// Removing invoices for good. QuickBooks has no undo for this, so the page
// shows the whole list first and this only runs on what it was handed.

import { getAccessToken, qbQuery } from './qb.js';
import { logUpload } from './db.js';
import { realmOf } from './desk.js';

const API = 'https://quickbooks.api.intuit.com';
const jobs = new Map();          // desk (company and person) -> job

const now = () => Date.now();
const sleep = ms => new Promise(r => setTimeout(r, ms));

function say(job, text, kind) {
  job.log.push({ at: new Date().toISOString(), text, kind: kind || 'info' });
  if (job.log.length > 6000) job.log.splice(0, 2000);
}

export function delSnapshot(desk, since) {
  const job = jobs.get(desk);
  if (!job) return null;

  return {
    id: job.id,
    state: job.state,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt || null,
    total: job.total,
    done: job.done,
    leftCount: Math.max(0, job.total - job.done),
    failed: job.failed,
        paymentsGone: job.paymentsGone,
    log: job.log.slice(Number(since) || 0),
    logLength: job.log.length,
    error: job.error || null
  };
}

// Carry on after a Stop or a failure: what is not yet gone goes through again.
export function resumeDelJob(desk) {
  const realmId = realmOf(desk);
  const job = jobs.get(desk);
  if (!job) throw new Error('There is no run to carry on');
  if (job.state === 'running') throw new Error('The run is still going');
  if (job.done >= job.total) throw new Error('Nothing is left to delete');

  job.cancel = false;
  job.failed = 0;
  job.error = null;
  job.state = 'running';
  job.finishedAt = null;
  say(job, 'Carrying on - ' + (job.total - job.done) + ' left');
  run(realmId, job, true).catch(e => {
    job.state = 'failed';
    job.error = e.message;
    job.finishedAt = new Date().toISOString();
    say(job, 'Stopped: ' + e.message, 'err');
  });
}

export function stopDelJob(desk) {
  const job = jobs.get(desk);
  if (!job || job.state !== 'running') return false;
  job.cancel = true;
  return true;
}

export function clearDelJob(desk) {
  const job = jobs.get(desk);
  if (job && job.state === 'running') return false;
  jobs.delete(desk);
  return true;
}

export function startDelJob(desk, opts) {
  const realmId = realmOf(desk);
  const old = jobs.get(desk);
  if (old && old.state === 'running') throw new Error('A delete run is already going');

  const list = (opts.invoices || [])
    .filter(x => x && x.id)
     .map(x => ({
      id: String(x.id),
      doc: String(x.doc || ''),
      total: Number(x.total || 0),
      paymentIds: (x.paymentIds || []).map(String)
    }));

  if (!list.length) throw new Error('Nothing was handed over to delete');

  const job = {
    id: 'del-' + now(),
    state: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    cancel: false,
    error: null,
    list,
    total: list.length,
    done: 0,
    deleted: new Set(),          // ids that are gone, so a carry-on skips them
    failed: 0,
        payDone: new Set(),
    paymentsGone: 0,
    log: []
  };

  jobs.set(desk, job);
  run(realmId, job).catch(e => {
    job.state = 'failed';
    job.error = e.message;
    job.finishedAt = new Date().toISOString();
    say(job, 'Stopped: ' + e.message, 'err');
  });

  return job.id;
}

// the token goes stale after an hour, so it is fetched again as we go
async function freshToken(realmId, job) {
  if (!job.token || now() - job.tokenAt > 40 * 60 * 1000) {
    job.token = await getAccessToken(realmId);
    job.tokenAt = now();
  }
  return job.token;
}
// A payment has to go before the invoice it sits on, or QuickBooks is left
// holding money against nothing.
async function removePayment(realmId, job, payId) {
  const token = await freshToken(realmId, job);

  const q = await qbQuery(realmId, token,
    `SELECT Id, SyncToken, PaymentRefNum FROM Payment WHERE Id = '${payId}'`);
  const found = (q.Payment || [])[0];
  if (!found) return 'gone';

  const r = await fetch(`${API}/v3/company/${realmId}/payment?operation=delete&minorversion=70`, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify({ Id: found.Id, SyncToken: found.SyncToken })
  });

  const text = await r.text();
  if (!r.ok) {
    let msg = text.slice(0, 200);
    try {
      const f = JSON.parse(text).Fault;
      if (f && f.Error && f.Error.length) msg = `${f.Error[0].Message} | ${f.Error[0].Detail || ''}`;
    } catch (e) {}
    throw new Error(msg);
  }

  return 'gone';
}
async function removeOne(realmId, job, inv) {
  const token = await freshToken(realmId, job);

  // the sync token has to be the current one, so the invoice is read first
  const q = await qbQuery(realmId, token, `SELECT Id, SyncToken, DocNumber FROM Invoice WHERE Id = '${inv.id}'`);
  const found = (q.Invoice || [])[0];
  if (!found) {
    say(job, `${inv.doc || inv.id}: already gone`, 'warn');
    return 'gone';
  }

  const r = await fetch(`${API}/v3/company/${realmId}/invoice?operation=delete&minorversion=70`, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify({ Id: found.Id, SyncToken: found.SyncToken })
  });

  const text = await r.text();
  if (!r.ok) {
    let msg = text.slice(0, 200);
    try {
      const f = JSON.parse(text).Fault;
      if (f && f.Error && f.Error.length) msg = `${f.Error[0].Message} | ${f.Error[0].Detail || ''}`;
    } catch (e) {}
    throw new Error(msg);
  }

  try {
    await logUpload(realmId, found.DocNumber, 'deleted',
      `QB Id ${found.Id} removed by hand`, null);
  } catch (e) {}

  return 'gone';
}

async function run(realmId, job, carrying) {
  if (!carrying) say(job, `Removing ${job.total} invoice${job.total === 1 ? '' : 's'}`);
  for (let i = 0; i < job.list.length; i++) {
    if (job.cancel) break;
    const inv = job.list[i];
    if (job.deleted.has(inv.id)) continue;

    let done = false;
    for (let attempt = 1; attempt <= 3 && !done; attempt++) {
      try {
                // the money first, then the invoice underneath it
        for (const pid of (inv.paymentIds || [])) {
          if (job.payDone.has(pid)) continue;
          await removePayment(realmId, job, pid);
          job.payDone.add(pid);
          job.paymentsGone++;
          say(job, `Removed the payment behind ${inv.doc || inv.id}`, 'ok');
        }
        await removeOne(realmId, job, inv);
        job.done++;
        job.deleted.add(inv.id);
        say(job, `Deleted ${inv.doc || inv.id}`, 'ok');
        done = true;
      } catch (e) {
        if (attempt < 3) {
          say(job, `${inv.doc || inv.id}: ${e.message} - trying again (${attempt} of 3)`, 'warn');
          job.token = null;                    // a stale token is the usual cause
          await sleep(attempt * 3000);
        } else {
          job.failed++;
          say(job, `Could not delete ${inv.doc || inv.id}: ${e.message}`, 'err');
        }
      }
    }

    // QuickBooks counts requests by the minute, so a small gap keeps it happy
    await sleep(350);
  }

  job.state = job.cancel ? 'stopped' : 'done';
  job.finishedAt = new Date().toISOString();
   const tail = (job.paymentsGone ? `, ${job.paymentsGone} payments removed` : '') +
               (job.failed ? `, ${job.failed} failed` : '');
  say(job, (job.cancel ? 'Stopped - ' : 'Finished - ') + job.done + ' deleted' + tail,
    job.failed ? 'warn' : 'ok');
}
