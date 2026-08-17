import { getAccessToken, qbQuery } from './qb.js';
import { logUpload } from './db.js';

const API = 'https://quickbooks.api.intuit.com';

// one void run per company, kept on the server so leaving the page is safe
const jobs = new Map();
const MAX_EVENTS = 3000;
const MAX_ROUNDS = 4;

// worth another go - QuickBooks was busy or the inventory was locked for a moment
function worthRetry(msg) {
  return /another user was creating|stale object|429|throttle|System Failure|application error|business validation|deadlock|timeout|temporarily|try again/i
    .test(String(msg || ''));
}

function push(job, type, msg, extra) {
  job.lastId++;
  job.events.push(Object.assign({ id: job.lastId, type, msg }, extra || {}));
  if (job.events.length > MAX_EVENTS) {
    job.events.splice(0, job.events.length - MAX_EVENTS);
  }
}

function nap(job, ms) {
  return new Promise(resolve => {
    const step = 250;
    let waited = 0;
    const t = setInterval(() => {
      waited += step;
      if (waited >= ms || job.stop) { clearInterval(t); resolve(); }
    }, step);
  });
}

function faultOf(text) {
  let msg = String(text || '').slice(0, 300);
  try {
    const f = JSON.parse(text).Fault;
    if (f && f.Error && f.Error.length) {
      msg = `${f.Error[0].Message || ''} | ${f.Error[0].Detail || ''}`.trim();
    }
  } catch (e) {}
  return msg;
}

async function qbPost(realmId, token, path, body) {
  const r = await fetch(`${API}/v3/company/${realmId}/${path}`, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const text = await r.text();
  if (!r.ok) return { ok: false, msg: faultOf(text) };
  try { return { ok: true, body: JSON.parse(text) }; }
  catch (e) { return { ok: true, body: {} }; }
}

// take one invoice off a payment. If it was the only one, the payment goes too.
async function unlinkPayment(realmId, token, paymentId, invoiceId) {
  const q = await qbQuery(realmId, token, `SELECT * FROM Payment WHERE Id = '${paymentId}'`);
  const pay = (q.Payment || [])[0];
  if (!pay) return { ok: true, note: 'that payment is already gone' };

  const keep = (pay.Line || []).filter(line => {
    const links = line.LinkedTxn || [];
    return !links.some(t => t.TxnType === 'Invoice' && String(t.TxnId) === String(invoiceId));
  });

  // nothing left on it - the payment itself has to go
  if (!keep.length) {
    const r = await qbPost(realmId, token,
      'payment?operation=delete&minorversion=70',
      { Id: pay.Id, SyncToken: pay.SyncToken });
    if (!r.ok) return { ok: false, msg: r.msg };
    return { ok: true, note: `payment ${pay.Id} removed, it held only this invoice` };
  }

  const total = keep.reduce((s, l) => s + Number(l.Amount || 0), 0);
  const r = await qbPost(realmId, token, 'payment?minorversion=70', {
    Id: pay.Id,
    SyncToken: pay.SyncToken,
    sparse: true,
    Line: keep,
    TotalAmt: Math.round(total * 100) / 100
  });
  if (!r.ok) return { ok: false, msg: r.msg };

  return { ok: true, note: `payment ${pay.Id} now ${total.toFixed(2)} over ${keep.length} invoices` };
}

async function voidOne(realmId, token, inv, force) {
  // the scan already handed us the SyncToken, so invoices with a clean slate
  // need no second fetch - that halves the calls to QuickBooks
  let live;
  if (inv.syncToken && !inv.hasPayment) {
    live = { Id: inv.id, SyncToken: inv.syncToken, TotalAmt: 1, LinkedTxn: [] };
  } else {
    const q = await qbQuery(realmId, token, `SELECT * FROM Invoice WHERE Id = '${inv.id}'`);
    live = (q.Invoice || [])[0];
    if (!live) return { ok: false, msg: 'not in QuickBooks any more' };
  }

  if (Number(live.TotalAmt || 0) === 0) {
    return { ok: true, already: true, note: 'was already void' };
  }

  const notes = [];

  // a payment is in the way - only touch it when told to
  const payIds = (live.LinkedTxn || [])
    .filter(t => t.TxnType === 'Payment')
    .map(t => String(t.TxnId));

  if (payIds.length) {
    if (!force) return { ok: false, held: true, msg: 'a payment is linked to this invoice' };

    for (const pid of payIds) {
      const u = await unlinkPayment(realmId, token, pid, live.Id);
      if (!u.ok) return { ok: false, msg: 'could not free the payment: ' + u.msg };
      if (u.note) notes.push(u.note);
    }

    // SyncToken moved when the payment changed - fetch the invoice again
    const q2 = await qbQuery(realmId, token, `SELECT * FROM Invoice WHERE Id = '${inv.id}'`);
    const again = (q2.Invoice || [])[0];
    if (!again) return { ok: false, msg: 'invoice disappeared while freeing the payment' };
    live.SyncToken = again.SyncToken;
  }

  const r = await qbPost(realmId, token, 'invoice?operation=void&minorversion=70',
    { Id: live.Id, SyncToken: live.SyncToken });

  if (!r.ok) return { ok: false, msg: r.msg, notes };
  return { ok: true, notes };
}

export function startVoidJob(realmId, { invoices, force, delay }) {
  const live = jobs.get(realmId);
  if (live && live.state === 'running') {
    throw new Error('A void run is already going for this company');
  }
  if (!Array.isArray(invoices) || !invoices.length) throw new Error('Nothing to void');

  const job = {
    id: Date.now(),
    state: 'running',
    stop: false,
    invoices,
    force: !!force,
   delay: delay === undefined ? 0 : Number(delay) || 0,
    lanes: 1,
    total: invoices.length,
    done: 0,
    voided: [],
    failed: [],
    held: [],
    events: [],
    lastId: 0,
    startedAt: Date.now(),
    finishedAt: null
  };

  jobs.set(realmId, job);
  run(realmId, job).catch(e => {
    push(job, 'error', 'ERROR: ' + e.message);
    job.state = 'error';
    job.finishedAt = Date.now();
  });

  return job.id;
}

async function run(realmId, job) {
  push(job, 'log', 'Connecting to QuickBooks...');
  const token = await getAccessToken(realmId);

  push(job, 'log', `Voiding ${job.total} invoice${job.total === 1 ? '' : 's'}` +
    (job.force ? ' - linked payments will be freed first.' : '.'));

 // Voiding does not touch stock, so several can run side by side.
  // Anything that needs its payment freeing goes one at a time - those
  // do touch a shared record and must not trip over each other.
 let pending = job.invoices.slice();

  for (let round = 1; round <= MAX_ROUNDS && pending.length && !job.stop; round++) {
    const again = [];

    if (round > 1) {
      push(job, 'log', `Round ${round} of ${MAX_ROUNDS}: trying ${pending.length} again.`);
    }

    async function attempt(inv) {
      let r;
      try {
        r = await voidOne(realmId, token, inv, job.force);
      } catch (e) {
        r = { ok: false, msg: e.message };
      }

      if (r.ok) {
        job.done++;
        job.voided.push({ doc: inv.doc, id: inv.id, already: !!r.already });
        push(job, 'ok', `VOID    ${inv.doc}` +
          (r.already ? '   (was already void)' : '') +
          ((r.notes && r.notes.length) ? '   [' + r.notes.join('; ') + ']' : ''),
          { doc: inv.doc });
        try {
          await logUpload(realmId, inv.doc, 'voided', `QB Id ${inv.id} voided`, null);
        } catch (e) {}
        return;
      }

      if (r.held) {
        job.done++;
        job.held.push({ doc: inv.doc, id: inv.id, msg: r.msg });
        push(job, 'held', `HELD    ${inv.doc}   ${r.msg}`, { doc: inv.doc });
        return;
      }

      // inventory locks and throttling pass - a fresh token and a pause fix them
      if (worthRetry(r.msg) && round < MAX_ROUNDS) {
        again.push(Object.assign({}, inv, { syncToken: null }));
        push(job, 'retry', `retry ${round}/${MAX_ROUNDS}  ${inv.doc}   ${String(r.msg).slice(0, 110)}`);
        return;
      }

      job.done++;
      job.failed.push({ doc: inv.doc, id: inv.id, msg: r.msg });
      push(job, 'fail', `FAILED  ${inv.doc}   ${String(r.msg).slice(0, 200)}`, { doc: inv.doc });
    }

    const quick = pending.filter(x => !x.hasPayment);
    const careful = pending.filter(x => x.hasPayment);

    if (quick.length) {
      if (round === 1) {
        push(job, 'log', `${quick.length} with no payment on them - ${job.lanes} at a time.`);
      }
      let next = 0;
      const lane = async () => {
        while (!job.stop) {
          const i = next++;
          if (i >= quick.length) return;
          await attempt(quick[i]);
          if (job.delay) await nap(job, job.delay);
        }
      };
      await Promise.all(Array.from({ length: job.lanes }, lane));
    }

    if (careful.length && !job.stop) {
      if (round === 1) {
        push(job, 'log', `${careful.length} sit on payments - these go one at a time.`);
      }
      for (const inv of careful) {
        if (job.stop) break;
        await attempt(inv);
        if (job.delay) await nap(job, job.delay);
      }
    }

    pending = again;

    if (pending.length && round < MAX_ROUNDS && !job.stop) {
      const wait = round * 30;
      push(job, 'log', `${pending.length} left over - waiting ${wait} seconds, then round ${round + 1}.`);
      await nap(job, wait * 1000);
    }
  }

  // anything still standing after every round really did not go through
  pending.forEach(inv => {
    job.done++;
    job.failed.push({ doc: inv.doc, id: inv.id, msg: 'still failing after every round' });
    push(job, 'fail', `FAILED  ${inv.doc}   still failing after ${MAX_ROUNDS} rounds`, { doc: inv.doc });
  });
  if (job.stop) {
    push(job, 'log', 'Stopped.');
    job.state = 'stopped';
  } else {
    push(job, 'log', `--- ${job.voided.length} voided, ${job.held.length} held back, ${job.failed.length} failed ---`);
    job.state = 'done';
  }
  job.finishedAt = Date.now();
}

export function stopVoidJob(realmId) {
  const job = jobs.get(realmId);
  if (!job) return false;
  job.stop = true;
  push(job, 'log', 'Stop requested - finishing the invoice in flight...');
  return true;
}

export function clearVoidJob(realmId) {
  const job = jobs.get(realmId);
  if (job && job.state === 'running') return false;
  jobs.delete(realmId);
  return true;
}

export function voidSnapshot(realmId, since, full) {
  const job = jobs.get(realmId);
  if (!job) return null;

  const out = {
    id: job.id,
    state: job.state,
    total: job.total,
    done: job.done,
    voidedCount: job.voided.length,
    heldCount: job.held.length,
    failedCount: job.failed.length,
    force: job.force,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    events: job.events.filter(e => e.id > (Number(since) || 0)),
    lastEventId: job.lastId
  };

  if (full || job.state !== 'running') {
    out.voided = job.voided;
    out.held = job.held;
    out.failed = job.failed;
  }

  return out;
}
