// Looking a pile of order numbers up in QuickBooks, before anything is voided.
//
// This used to be one long request: press the button and wait, with no way to
// take it back. A list pasted by mistake - the wrong month, the wrong column -
// had to be waited out before the right one could be sent. So it reads in
// batches as a job on the server, which means Stop takes effect at the end of
// the batch in flight, Carry on reads only the batches that were left, and
// Clear log puts the whole thing away.

import { getAccessToken, qbQuery } from './qb.js';
import { paymentsByIds, listAccounts, digitsOf } from './cpr.js';
import { realmOf } from './desk.js';

const jobs = new Map();            // desk (company and person) -> job
const MAX_EVENTS = 2000;
const CHUNK = 40;                  // order numbers per query, both spellings each

function push(job, type, msg) {
  job.lastId++;
  job.events.push({ id: job.lastId, type, msg, at: Date.now() });
  if (job.events.length > MAX_EVENTS) {
    job.events.splice(0, job.events.length - MAX_EVENTS);
  }
}

export function startVoidScan(desk, numbers) {
  const live = jobs.get(desk);
  if (live && live.state === 'running') {
    throw new Error('A look-up of yours is already going');
  }

  const raw = numbers;
  const list = (Array.isArray(raw) ? raw : String(raw || '').split(/[\s,;]+/))
    .map(x => String(x).trim())
    .filter(Boolean);
  if (!list.length) throw new Error('Paste some invoice numbers first');

  // both spellings - QuickBooks treats #91313480 and 91313480 as two documents
  const wanted = [];
  const seen = new Set();
  list.forEach(n => {
    const d = digitsOf(n);
    if (!d || seen.has(d)) return;
    seen.add(d);
    wanted.push(d);
  });
  if (!wanted.length) throw new Error('None of those lines holds an invoice number');

  const job = {
    id: Date.now(),
    state: 'running',
    stop: false,
    asked: list.length,
    wanted,
    cursor: 0,                     // how many numbers have been looked up
    invoices: new Map(),           // digits -> [invoice as QuickBooks has it]
    events: [],
    lastId: 0,
    startedAt: Date.now(),
    finishedAt: null,
    result: null
  };

  jobs.set(desk, job);
  run(realmOf(desk), job).catch(e => {
    push(job, 'error', 'ERROR: ' + e.message);
    job.state = 'error';
    job.finishedAt = Date.now();
  });

  return job.id;
}

async function run(realmId, job) {
  const token = await getAccessToken(realmId);

  push(job, 'log',
    `Looking ${job.wanted.length} invoice number${job.wanted.length === 1 ? '' : 's'} up in ` +
    `QuickBooks, ${CHUNK} at a time.`);

  while (job.cursor < job.wanted.length && !job.stop) {
    const chunk = job.wanted.slice(job.cursor, job.cursor + CHUNK);
    const variants = [];
    chunk.forEach(d => variants.push(`'#${d}'`, `'${d}'`));

    const q = await qbQuery(realmId, token,
      `SELECT Id, DocNumber, TxnDate, TotalAmt, Balance, CustomerRef, LinkedTxn, SyncToken ` +
      `FROM Invoice WHERE DocNumber IN (${variants.join(',')}) MAXRESULTS 1000`);

    let here = 0;
    (q.Invoice || []).forEach(inv => {
      const d = digitsOf(inv.DocNumber);
      if (!d) return;
      if (!job.invoices.has(d)) job.invoices.set(d, []);
      job.invoices.get(d).push(inv);
      here++;
    });

    job.cursor += chunk.length;
    push(job, here ? 'ok' : 'log',
      `${job.cursor} of ${job.wanted.length} looked up - ${here} found in this batch.`);
  }

  if (job.stop) {
    push(job, 'log', `Stopped - ${job.cursor} of ${job.wanted.length} looked up.`);
    job.result = await sortOut(realmId, token, job, true);
    job.state = 'stopped';
    job.finishedAt = Date.now();
    return;
  }

  // the payments behind anything that is already paid, so the page can say
  // which CPR took the money before anybody decides to void it
  job.result = await sortOut(realmId, token, job, false);

  const r = job.result;
  push(job, 'log',
    `--- ${r.ready.length} ready to void, ${r.paid.length} with a payment, ` +
    `${r.alreadyVoid.length} already void, ${r.notFound.length} not in QuickBooks ---`);
  job.state = 'done';
  job.finishedAt = Date.now();
}

async function sortOut(realmId, token, job, partial) {
  const payIds = [];
  job.invoices.forEach(arr => arr.forEach(inv => {
    (inv.LinkedTxn || []).forEach(t => {
      if (t.TxnType === 'Payment') payIds.push(String(t.TxnId));
    });
  }));

  const payMap = new Map();
  if (payIds.length) {
    const pays = await paymentsByIds(realmId, token, [...new Set(payIds)]);
    pays.forEach(p => payMap.set(String(p.id), p));
  }

  const accounts = await listAccounts(realmId, token);
  const accName = id => {
    const hit = accounts.find(a => String(a.id) === String(id));
    return hit ? hit.name : id;
  };

  const ready = [], paid = [], alreadyVoid = [], notFound = [];

  // a stopped run has only looked at the first so many, and the rest are
  // neither found nor missing - they are simply not read yet
  const read = partial ? job.wanted.slice(0, job.cursor) : job.wanted;

  read.forEach(d => {
    const copies = job.invoices.get(d);
    if (!copies || !copies.length) { notFound.push(d); return; }

    copies.forEach(inv => {
      const total = Number(inv.TotalAmt || 0);
      const entry = {
        id: inv.Id,
        syncToken: inv.SyncToken,
        doc: inv.DocNumber || '',
        date: inv.TxnDate || '',
        total,
        balance: Number(inv.Balance === undefined ? total : inv.Balance),
        customer: inv.CustomerRef ? (inv.CustomerRef.name || '') : ''
      };

      if (total === 0) { alreadyVoid.push(entry); return; }

      const linked = (inv.LinkedTxn || [])
        .filter(t => t.TxnType === 'Payment')
        .map(t => payMap.get(String(t.TxnId)))
        .filter(Boolean);

      if (linked.length) {
        entry.payments = linked.map(p => ({
          id: p.id,
          cpr: p.ref || '(no CPR number)',
          date: p.date,
          amount: p.amount,
          bank: p.accountName || accName(p.accountId)
        }));
        paid.push(entry);
        return;
      }

      ready.push(entry);
    });
  });

  return {
    asked: job.asked,
    unique: job.wanted.length,
    read: read.length,
    ready, paid, alreadyVoid, notFound
  };
}

export function resumeVoidScan(desk) {
  const job = jobs.get(desk);
  if (!job) throw new Error('There is no look-up to carry on');
  if (job.state === 'running') throw new Error('The look-up is still going');
  if (job.cursor >= job.wanted.length) throw new Error('Every number has been looked up');

  job.stop = false;
  job.state = 'running';
  job.finishedAt = null;
  push(job, 'log',
    `Carrying on - ${job.wanted.length - job.cursor} left to look up.`);
  run(realmOf(desk), job).catch(e => {
    push(job, 'error', 'ERROR: ' + e.message);
    job.state = 'error';
    job.finishedAt = Date.now();
  });
}

export function stopVoidScan(desk) {
  const job = jobs.get(desk);
  if (!job) return false;
  job.stop = true;
  push(job, 'log', 'Stop requested - finishing the batch in flight...');
  return true;
}

export function clearVoidScan(desk) {
  const job = jobs.get(desk);
  if (job && job.state === 'running') return false;
  jobs.delete(desk);
  return true;
}

export function voidScanSnapshot(desk, since) {
  const job = jobs.get(desk);
  if (!job) return null;

  return {
    id: job.id,
    state: job.state,
    asked: job.asked,
    unique: job.wanted.length,
    done: job.cursor,
    leftCount: Math.max(0, job.wanted.length - job.cursor),
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    events: job.events.filter(e => e.id > (Number(since) || 0)),
    lastEventId: job.lastId,
    result: job.result
  };
}
