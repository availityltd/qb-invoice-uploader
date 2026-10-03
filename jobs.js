import { getAccessToken, loadItems, loadTerms, getOrCreateCustomer, postInvoice } from './qb.js';
import { realmOf, deskKey } from './desk.js';
import { logUpload } from './db.js';
import { saveJobStart, saveJobProgress, clearJobRow, unfinishedJobs } from './jobstore.js';
// one running job per company, kept on the server so it survives page changes
// keyed by the desk - the company and the person together - so two people in
// the same books each have their own upload, their own log and their own Stop
const jobs = new Map();
const MAX_EVENTS = 4000;
const MAX_ROUNDS = 5;

// QuickBooks access tokens last an hour - refresh well before that
const TOKEN_LIFE = 40 * 60 * 1000;

// QB locks inventory while it writes - after a run of dead batches, back right off
const DEAD_BATCH_STREAK = 3;
const COOL_DOWN = 5 * 60 * 1000;

function push(job, type, msg) {
  // Pakistan is five hours ahead of the server's own clock
  const t = new Date(Date.now() + 5 * 3600 * 1000);
  let h = t.getUTCHours();
  const ampm = h < 12 ? 'am' : 'pm';
  h = h % 12; if (h === 0) h = 12;
  const stamp = String(h).padStart(2, '0') + ':' +
                String(t.getUTCMinutes()).padStart(2, '0') + ':' +
                String(t.getUTCSeconds()).padStart(2, '0') + ' ' + ampm;
  job.lastId++;
  job.events.push({ id: job.lastId, type, msg: stamp + '  ' + msg });
  if (job.events.length > 4000) job.events.splice(0, job.events.length - 4000);
}
function isAuthError(msg, status) {
  return status === 401 ||
    /AuthenticationFailed|003200|Unauthorized|token expired|invalid_grant/i.test(String(msg || ''));
}

function isDuplicate(msg) {
  return /duplicate document number/i.test(String(msg || ''));
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

   // the discount sits under the subtotal, the way QuickBooks shows it, rather
  // than as another product line
  const disc = Math.round(Number(inv.discount || 0) * 100) / 100;
  if (disc > 0) {
    lines.push({
      DetailType: 'DiscountLineDetail',
      Amount: disc,
      DiscountLineDetail: { PercentBased: false }
    });
  }

  const p = { DocNumber: inv.docNumber, CustomerRef: { value: customerId }, Line: lines };
  if (inv.txnDate) p.TxnDate = inv.txnDate;
  if (inv.dueDate) p.DueDate = inv.dueDate;
  if (inv.memo) p.CustomerMemo = { value: inv.memo };

  // the buyer's own name and address, in the billing block where it belongs
  if (Array.isArray(inv.billTo) && inv.billTo.length) {
    const b = inv.billTo.filter(Boolean).map(String);
    p.BillAddr = {};
    ['Line1', 'Line2', 'Line3', 'Line4', 'Line5'].forEach((k, i) => {
      if (b[i]) p.BillAddr[k] = b[i].slice(0, 500);
    });
  }

  const termId = termMap[String(inv.terms || '').toLowerCase()];
  if (termId) p.SalesTermRef = { value: termId };

  return p;
}

// a sleep that wakes early when the job is told to stop or hold
function nap(job, ms) {
  return new Promise(resolve => {
    const step = 250;
    let waited = 0;
    const t = setInterval(() => {
      waited += step;
      if (waited >= ms || job.stop || job.hold) { clearInterval(t); resolve(); }
    }, step);
  });
}

// hands back a token that is still good, fetching a new one when it has aged
async function tokenFor(realmId, job, force) {
  if (force || !job.token || (Date.now() - job.tokenAt) > TOKEN_LIFE) {
    job.token = await getAccessToken(realmId);
    job.tokenAt = Date.now();
    if (force) push(job, 'log', 'QuickBooks sign-in had expired - signed in again.');
  }
  return job.token;
}

export function startJob(desk, { invoices, delay, negativeItems, batchSize }) {
  const realmId = realmOf(desk);
  const live = jobs.get(desk);
  if (live && (live.state === 'running' || live.state === 'waiting')) {
    throw new Error('An upload of yours is already running');
  }

  let size = Number(batchSize) || 10;
  if (size < 1) size = 1;
  if (size > 30) size = 30;          // QuickBooks will not take more than 30

  const job = {
    id: Date.now(),
    desk,
    state: 'running',
    stop: false,
    hold: false,
    invoices,
    total: invoices.length,
    cursor: 0,
    delay: Number(delay) || 1000,
    batchSize: size,
    negSet: new Set((negativeItems || []).map(s => String(s).toLowerCase())),
    done: new Set(),
    failed: new Set(),
    events: [],
    lastId: 0,
    round: 0,
    streak: 0,
    token: null,
    tokenAt: 0,
    custCache: {},
    startedAt: Date.now(),
    finishedAt: null
  };

  jobs.set(desk, job);
  saveJobStart(desk, job).catch(e => console.error('job save failed:', e.message));
  run(realmId, job).catch(e => {
    push(job, 'error', 'ERROR: ' + e.message);
    job.state = 'error';
    job.finishedAt = Date.now();
  });

  return job.id;
}
// One invoice per request. QuickBooks holds the inventory lock while it writes,
// so a batch of ten has to finish inside one request and the gateway cuts the
// connection first - that is what "stream timeout" was. Sent singly it is
// slower, but it does not stop.
async function sendChunk(realmId, job, itemMap, termMap, chunk) {
  const token = await tokenFor(realmId, job);
  const out = [];

  for (const inv of chunk) {
    if (job.stop) break;

    let payload;
    try {
      const custId = await getOrCreateCustomer(realmId, token, inv.customer, job.custCache);
      payload = buildPayload(inv, custId, itemMap, termMap, job.negSet);
    } catch (e) {
      // a missing product is nothing a retry will fix
      out.push({
        inv, ok: false, msg: e.message, status: 0,
        retryable: !/not found in QuickBooks/i.test(e.message)
      });
      continue;
    }

    const r = await postInvoice(realmId, token, payload);

    if (r.ok) {
      out.push({ inv, ok: true, id: r.id });
    } else if (isDuplicate(r.msg)) {
      out.push({ inv, ok: true, id: null, already: true });
    } else {
      out.push({ inv, ok: false, msg: r.msg, status: r.status, retryable: r.retryable, tid: r.tid });
    }

    // a breath between invoices - this is what keeps the lock from building up
    if (job.delay > 0) await nap(job, job.delay);
  }

  return out;
}


// waits here while the job is held, and comes back false if it was stopped
async function waitWhileHeld(job) {
  if (!job.hold) return true;

  push(job, 'log', 'Paused. Press Resume to carry on from here.');
  job.state = 'paused';

  while (job.hold && !job.stop) {
    await new Promise(r => setTimeout(r, 500));
  }

  if (job.stop) return false;

  job.state = 'running';
  push(job, 'log', 'Carrying on.');
  return true;
}

async function pass(realmId, job, itemMap, termMap, list, isRetry) {
  let pending = list;

  for (let round = 1; round <= MAX_ROUNDS && pending.length && !job.stop; round++) {
    const again = [];
    let firstRound = (round === 1);

    for (let i = 0; i < pending.length; i += job.batchSize) {
      if (job.stop) return;
      if (job.hold && !(await waitWhileHeld(job))) return;

      // several dead batches in a row means QuickBooks is busy, not that we are wrong
      if (job.streak >= DEAD_BATCH_STREAK) {
        push(job, 'log', `${job.streak} batches failed in a row - QuickBooks looks busy. Pausing 5 minutes.`);
        job.state = 'waiting';
        await nap(job, COOL_DOWN);
        if (job.stop) return;
        if (job.hold && !(await waitWhileHeld(job))) return;
        job.state = 'running';
        job.streak = 0;
      }

      // anything already in QuickBooks is skipped, so a resume never repeats work
      const chunk = pending.slice(i, i + job.batchSize)
        .filter(inv => !job.done.has(inv.docNumber));

      if (!chunk.length) {
        if (firstRound && !isRetry) job.cursor = Math.min(job.total, i + job.batchSize);
        continue;
      }

      let results;

      try {
        results = await sendChunk(realmId, job, itemMap, termMap, chunk);
      } catch (e) {
        if (isAuthError(e.message, 0)) {
          try {
            await tokenFor(realmId, job, true);
            results = await sendChunk(realmId, job, itemMap, termMap, chunk);
          } catch (e2) {
            push(job, 'error', 'Batch failed: ' + e2.message);
            chunk.forEach(inv => again.push(inv));
            job.streak++;
            continue;
          }
        } else {
          push(job, 'error', 'Batch failed: ' + e.message);
          chunk.forEach(inv => again.push(inv));
          job.streak++;
          continue;
        }
      }

      let goodInChunk = 0;
      let sawAuth = false;

      for (const r of results) {
        if (r.ok) {
          goodInChunk++;
          job.done.add(r.inv.docNumber);
          job.failed.delete(r.inv.docNumber);
          push(job, 'ok',
            `OK      ${r.inv.docNumber}   ${r.already ? '(already in QuickBooks)' : '(QB Id ' + r.id + ')'}`,
            { doc: r.inv.docNumber });
          if (!r.already) {
            try { await logUpload(realmId, r.inv.docNumber, 'success', `QB Id ${r.id}`, null); } catch (e) {}
          }
          continue;
        }

        if (isAuthError(r.msg, r.status)) sawAuth = true;

        if (r.retryable && round < MAX_ROUNDS) {
          again.push(r.inv);
          push(job, 'retry', `retry ${round}/${MAX_ROUNDS}  ${r.inv.docNumber}  ${String(r.msg).slice(0, 100)}`);
        } else {
          job.failed.add(r.inv.docNumber);
          push(job, 'fail', `FAILED  ${r.inv.docNumber}  ${String(r.msg).slice(0, 250)}`, { doc: r.inv.docNumber });
          try { await logUpload(realmId, r.inv.docNumber, 'failed', r.msg, r.tid || null); } catch (e) {}
        }
      }

      if (sawAuth) await tokenFor(realmId, job, true);

      job.streak = goodInChunk ? 0 : job.streak + 1;

      if (firstRound && !isRetry) {
        job.cursor = Math.min(job.total, i + job.batchSize);
      }
      // the place is written down after every batch, so a restart loses nothing
            saveJobProgress(job.desk, job).catch(e => console.error('job progress failed:', e.message));
      if (i + job.batchSize < pending.length) await nap(job, job.delay);
    }

    if (again.length && round < MAX_ROUNDS && !job.stop) {
      const wait = round * 15;
      push(job, 'log', `${again.length} invoice${again.length === 1 ? '' : 's'} to try again - waiting ${wait} seconds.`);
      job.state = 'waiting';
      await nap(job, wait * 1000);
      if (job.stop) return;
      if (job.hold && !(await waitWhileHeld(job))) return;
      job.state = 'running';
    }

    pending = again;
  }

  // whatever is still standing after every round is a real failure
  pending.forEach(inv => {
    if (!job.done.has(inv.docNumber)) job.failed.add(inv.docNumber);
  });
}

async function run(realmId, job) {
  push(job, 'log', 'Connecting to QuickBooks...');
  const token = await tokenFor(realmId, job);

  push(job, 'log', 'Loading products...');
  const itemMap = await loadItems(realmId, token);
  push(job, 'log', `Products loaded: ${Object.keys(itemMap).length}`);

  const termMap = await loadTerms(realmId, token);

  push(job, 'log', `Sending ${job.total} invoices in batches of ${job.batchSize}.`);
  await pass(realmId, job, itemMap, termMap, job.invoices, false);

  const stuck = [...job.failed].filter(d => !job.done.has(d));

  if (job.stop) {
    push(job, 'log', `Stopped - ${job.done.size} of ${job.total} were uploaded.`);
    job.state = 'stopped';
  } else if (!stuck.length) {
    push(job, 'log', '--- All invoices uploaded ---');
    job.state = 'done';
    job.cursor = job.total;
  } else {
    push(job, 'log', `--- ${stuck.length} invoice${stuck.length === 1 ? '' : 's'} still failing. Use Retry failed only, or download the list. ---`);
    job.state = 'done';
    job.cursor = job.total;
  }

  job.finishedAt = Date.now();
         saveJobProgress(job.desk, job).catch(e => console.error('job progress failed:', e.message));
}

export function stopJob(desk) {
  const job = jobs.get(desk);
  if (!job) return false;
  job.stop = true;
  job.hold = false;
  push(job, 'log', 'Stop requested - finishing the batch in flight...');
  return true;
}

// Pause holds the run where it is. Resume picks up from the same place, so
// nothing already in QuickBooks is sent a second time.
export function pauseJob(desk) {
  const job = jobs.get(desk);
  if (!job) return false;
  if (job.state !== 'running' && job.state !== 'waiting') return false;
  job.hold = true;
  return true;
}

export function resumeJob(desk) {
  const job = jobs.get(desk);
  if (!job) throw new Error('Nothing to resume');

  // still on the server and merely held - just let it go
  if (job.hold && job.state === 'paused') {
    job.hold = false;
    return job.id;
  }

  // it had stopped, so a fresh run is started with whatever is left
  if (job.state === 'stopped' || job.state === 'error') {
    const left = job.invoices.filter(inv => !job.done.has(inv.docNumber));
    if (!left.length) throw new Error('Everything has already been uploaded');

    const carried = {
      done: new Set(job.done),
      events: job.events,
      lastId: job.lastId
    };

    const id = startJob(desk, {
      invoices: left,
      delay: job.delay,
      negativeItems: [...job.negSet],
      batchSize: job.batchSize
    });

    // keep the log and the tally, so the page reads as one long run
    const fresh = jobs.get(desk);
    fresh.done = carried.done;
    fresh.events = carried.events;
    fresh.lastId = carried.lastId;
    push(fresh, 'log',
      `Carrying on - ${carried.done.size} already uploaded, ${left.length} to go.`);

    return id;
  }

  throw new Error('The upload is already going');
}

export function clearJob(desk) {
  const job = jobs.get(desk);
  if (job && (job.state === 'running' || job.state === 'waiting' || job.state === 'paused')) return false;
  jobs.delete(desk);
  return true;
}

export function retryFailed(desk) {
  const job = jobs.get(desk);
  if (!job) throw new Error('Nothing to retry');
  if (job.state === 'running' || job.state === 'waiting' || job.state === 'paused') {
    throw new Error('The upload is still going');
  }

  const stuck = [...job.failed].filter(d => !job.done.has(d));
  if (!stuck.length) throw new Error('Nothing is failing');

  const set = new Set(stuck);
  const list = job.invoices.filter(inv => set.has(inv.docNumber));

  return startJob(desk, {
    invoices: list,
    delay: job.delay,
    negativeItems: [...job.negSet],
    batchSize: job.batchSize
  });
}

// what the page needs to draw itself, from scratch or from where it left off
export function snapshot(desk, since, full) {
  const job = jobs.get(desk);
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
    batchSize: job.batchSize,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    events: job.events.filter(e => e.id > (Number(since) || 0)),
    lastEventId: job.lastId
  };

  if (full) {
    out.done = [...job.done];
    out.failed = [...job.failed].filter(d => !job.done.has(d));
    out.remaining = job.invoices
      .filter(inv => !job.done.has(inv.docNumber))
      .map(x => x.docNumber);
  }

  return out;
}

export function remainingInvoices(desk) {
  const job = jobs.get(desk);
  if (!job) return [];
  return job.invoices.filter(inv => !job.done.has(inv.docNumber));
}

export function negativesOf(desk) {
  const job = jobs.get(desk);
  return job ? [...job.negSet] : [];
}
// When the server comes back after a deploy or a crash, any run that was still
// going is started again with whatever is left. Nothing already in QuickBooks
// is sent twice, because the done list came back with it.
export async function resumeUnfinished() {
  let rows = [];
  try { rows = await unfinishedJobs(); } catch (e) { return; }

  for (const row of rows) {
    try {
      const all = row.invoices || [];
      const done = new Set(row.done || []);
      const left = all.filter(inv => !done.has(inv.docNumber));

      // A run written before runs had an owner belongs to nobody now: resuming
      // it would post to QuickBooks with no page able to see or stop it. It is
      // dropped instead, and whoever it was carries on from their own page.
      if (!row.user_sub) { await clearJobRow(deskKey(row.realm_id, '')); continue; }

      const desk = deskKey(row.realm_id, row.user_sub);
      if (!left.length) { await clearJobRow(desk); continue; }

      const opts = row.opts || {};
      startJob(desk, {
        invoices: left,
        delay: opts.delay,
        negativeItems: opts.negativeItems || [],
        batchSize: opts.batchSize
      });

      // carry the tally and the log across, so the page reads as one run
      const job = jobs.get(desk);
      if (job) {
        job.done = done;
        job.failed = new Set(row.failed || []);
        job.events = row.events || [];
        job.lastId = job.events.length ? job.events[job.events.length - 1].id : 0;
        job.total = all.length;
        job.invoices = all;
        job.cursor = Number(row.cursor) || done.size;
        push(job, 'log',
          `Server restarted - carrying on. ${done.size} already uploaded, ${left.length} to go.`);
        saveJobStart(desk, job).catch(() => {});
      }
    } catch (e) { /* one bad row must not stop the rest */ }
  }
}
