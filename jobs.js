import { getAccessToken, loadItems, loadTerms, getOrCreateCustomer, postInvoice } from './qb.js';
import { logUpload } from './db.js';

// one running job per company, kept on the server so it survives page changes
const jobs = new Map();
const MAX_EVENTS = 4000;
const MAX_AUTO_ROUNDS = 3;

function push(job, type, msg, extra) {
  job.lastId++;
  job.events.push(Object.assign({ id: job.lastId, type, msg }, extra || {}));
  if (job.events.length > MAX_EVENTS) {
    job.events.splice(0, job.events.length - MAX_EVENTS);
  }
}

function buildPayload(inv, customerId, itemMap, termMap, negSet) {
  const lines = [];

  for (const L of inv.lines) {
    const itemId = itemMap[String(L.item).toLowerCase()];
    if (!itemId) throw new Error(`Item not found in QuickBooks: "${L.item}"`);

    let amount = L.amt;
    let rate = L.rate || L.amt;
    if (negSet.has(String(L.item).toLowerCase())) {
      amount = -Math.abs(amount);
      rate = -Math.abs(rate);
    }

    const detail = { ItemRef: { value: itemId }, Qty: L.qty, UnitPrice: rate };
    if (L.svc) detail.ServiceDate = L.svc;

    const line = { DetailType: 'SalesItemLineDetail', Amount: amount, SalesItemLineDetail: detail };
    if (L.desc) line.Description = L.desc;
    lines.push(line);
  }

  const p = { DocNumber: inv.docNumber, CustomerRef: { value: customerId }, Line: lines };
  if (inv.txnDate) p.TxnDate = inv.txnDate;
  if (inv.dueDate) p.DueDate = inv.dueDate;
  if (inv.memo) p.CustomerMemo = { value: inv.memo };

  const termId = termMap[String(inv.terms || '').toLowerCase()];
  if (termId) p.SalesTermRef = { value: termId };

  return p;
}

// a sleep that wakes early when the job is told to stop
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

export function startJob(realmId, { invoices, delay, negativeItems }) {
  const live = jobs.get(realmId);
  if (live && live.state === 'running') {
    throw new Error('An upload is already running for this company');
  }

  const job = {
    id: Date.now(),
    state: 'running',
    stop: false,
    invoices,
    total: invoices.length,
    cursor: 0,
    delay: Number(delay) || 1000,
    negSet: new Set((negativeItems || []).map(s => String(s).toLowerCase())),
    done: new Set(),
    failed: new Set(),
    events: [],
    lastId: 0,
    round: 0,
    startedAt: Date.now(),
    finishedAt: null
  };

  jobs.set(realmId, job);
  run(realmId, job).catch(e => {
    push(job, 'error', e.message);
    job.state = 'error';
    job.finishedAt = Date.now();
  });

  return job.id;
}

async function pass(realmId, job, token, itemMap, termMap, custCache, list, isRetry) {
  for (let i = 0; i < list.length; i++) {
    if (job.stop) return;

    const inv = list[i];
    let ok = false, lastErr = '';

    for (let attempt = 1; attempt <= 5; attempt++) {
      if (job.stop) return;
      try {
        const custId = await getOrCreateCustomer(realmId, token, inv.customer, custCache);
        const payload = buildPayload(inv, custId, itemMap, termMap, job.negSet);
        const result = await postInvoice(realmId, token, payload);

        if (result.ok) {
          push(job, 'ok', `OK      ${inv.docNumber}   (QB Id ${result.id})`, { doc: inv.docNumber });
          job.done.add(inv.docNumber);
          job.failed.delete(inv.docNumber);
          try { await logUpload(realmId, inv.docNumber, 'success', `QB Id ${result.id}`, result.tid); } catch (e) {}
          ok = true;
          break;
        }

        lastErr = `${result.msg} [tid=${result.tid}]`;

        // QB already has it - that counts as done, not failed
        if (/duplicate document number/i.test(result.msg)) {
          push(job, 'ok', `OK      ${inv.docNumber}   (already in QuickBooks)`, { doc: inv.docNumber });
          job.done.add(inv.docNumber);
          job.failed.delete(inv.docNumber);
          ok = true;
          break;
        }

        if (!result.retryable) break;
        push(job, 'retry', `retry ${attempt}/5  ${inv.docNumber}  ${result.msg.slice(0, 100)}`);
        await nap(job, attempt * 5000);

      } catch (e) {
        lastErr = e.message;
        if (/not found in QuickBooks/.test(e.message)) break;
        push(job, 'retry', `retry ${attempt}/5  ${inv.docNumber}  ${e.message.slice(0, 100)}`);
        await nap(job, attempt * 5000);
      }
    }

    if (!ok) {
      job.failed.add(inv.docNumber);
      push(job, 'fail', `FAILED  ${inv.docNumber}  ${lastErr.slice(0, 250)}`, { doc: inv.docNumber });
      try { await logUpload(realmId, inv.docNumber, 'failed', lastErr, null); } catch (e) {}
    }

    if (!isRetry) job.cursor = i + 1;
    if (i < list.length - 1) await nap(job, job.delay);
  }
}

async function run(realmId, job) {
  push(job, 'log', 'Connecting to QuickBooks...');
  const token = await getAccessToken(realmId);

  push(job, 'log', 'Loading products...');
  const itemMap = await loadItems(realmId, token);
  push(job, 'log', `Products loaded: ${Object.keys(itemMap).length}`);

  const termMap = await loadTerms(realmId, token);
  const custCache = {};

  await pass(realmId, job, token, itemMap, termMap, custCache, job.invoices, false);

  // automatic retry rounds for whatever is still failing
  while (!job.stop && job.round < MAX_AUTO_ROUNDS) {
    const stuck = [...job.failed].filter(d => !job.done.has(d));
    if (!stuck.length) break;

    job.round++;
    const pause = job.round * 120;
    push(job, 'log', `Retry round ${job.round} of ${MAX_AUTO_ROUNDS} - ${stuck.length} invoice${stuck.length === 1 ? '' : 's'}, starting in ${pause} seconds.`);
    job.state = 'waiting';
    await nap(job, pause * 1000);
    if (job.stop) break;
    job.state = 'running';

    const set = new Set(stuck);
    const list = job.invoices.filter(inv => set.has(inv.docNumber));
    await pass(realmId, job, token, itemMap, termMap, custCache, list, true);
  }

  const stuck = [...job.failed].filter(d => !job.done.has(d));

  if (job.stop) {
    push(job, 'log', 'Stopped.');
    job.state = 'stopped';
  } else if (!stuck.length) {
    push(job, 'log', '--- All invoices uploaded ---');
    job.state = 'done';
  } else {
    push(job, 'log', `--- ${stuck.length} invoice${stuck.length === 1 ? '' : 's'} still failing. Use Retry failed only, or download the list. ---`);
    job.state = 'done';
  }

  job.finishedAt = Date.now();
}

export function stopJob(realmId) {
  const job = jobs.get(realmId);
  if (!job) return false;
  job.stop = true;
  push(job, 'log', 'Stop requested - finishing the current invoice...');
  return true;
}

export function clearJob(realmId) {
  const job = jobs.get(realmId);
  if (job && job.state === 'running') return false;
  jobs.delete(realmId);
  return true;
}

export function retryFailed(realmId) {
  const job = jobs.get(realmId);
  if (!job) throw new Error('Nothing to retry');
  if (job.state === 'running' || job.state === 'waiting') {
    throw new Error('The upload is still going');
  }

  const stuck = [...job.failed].filter(d => !job.done.has(d));
  if (!stuck.length) throw new Error('Nothing is failing');

  const set = new Set(stuck);
  const list = job.invoices.filter(inv => set.has(inv.docNumber));

  return startJob(realmId, {
    invoices: list,
    delay: job.delay,
    negativeItems: [...job.negSet]
  });
}

// what the page needs to draw itself, from scratch or from where it left off
export function snapshot(realmId, since, full) {
  const job = jobs.get(realmId);
  if (!job) return null;

  const out = {
    id: job.id,
    state: job.state,
    total: job.total,
    cursor: job.cursor,
    doneCount: job.done.size,
    failedCount: [...job.failed].filter(d => !job.done.has(d)).length,
    round: job.round,
    delay: job.delay,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    events: job.events.filter(e => e.id > (Number(since) || 0)),
    lastEventId: job.lastId
  };

  if (full) {
    out.done = [...job.done];
    out.failed = [...job.failed].filter(d => !job.done.has(d));
    out.remaining = job.invoices.slice(job.cursor).map(x => x.docNumber);
  }

  return out;
}

export function remainingInvoices(realmId) {
  const job = jobs.get(realmId);
  if (!job) return [];
  return job.invoices.slice(job.cursor);
}

export function negativesOf(realmId) {
  const job = jobs.get(realmId);
  return job ? [...job.negSet] : [];
}
