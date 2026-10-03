import { getAccessToken, qbQuery } from './qb.js';
import { logUpload, pool, keyRunsByDesk } from './db.js';
import { realmOf, userOf, deskKey } from './desk.js';

const API = 'https://quickbooks.api.intuit.com';

// one void run per desk - the company and the person together - kept on the
// server so leaving the page, or picking it up on another computer, is safe.
// Two people in the same books do not share a run, a log or a Stop button.
const jobs = new Map();
const MAX_EVENTS = 3000;
// A refusal is QuickBooks being loaded - it holds the stock for a while after each
// void - never the invoice. So the refused one goes to the back of the queue and is
// tried again this long afterwards, as many times as it takes. Nothing else waits on
// it, and the run only ends when every invoice is voided or Stop is pressed.
const RETRY_PAUSE = 60 * 1000;
// QuickBooks access tokens last an hour - refresh well before that
const TOKEN_LIFE = 40 * 60 * 1000;
function isAuthError(msg) {
  return /AuthenticationFailed|003200|\(401\)|Unauthorized|token expired/i.test(String(msg || ''));
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

// A void run lives in memory while it goes and in Postgres as well, so a deploy or a
// crash half way does not lose it: a server that comes back carries on with what was
// left. What was voided a moment before the restart but not yet written down is
// simply tried again, and QuickBooks answers that it is already void - which counts
// as done. The progress is written every few invoices, the list itself once.
export async function initVoidStore() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS void_runs (
      realm_id   TEXT NOT NULL,
      invoices   JSONB,
      progress   JSONB,
      updated_at TIMESTAMPTZ DEFAULT now()
    )
  `);
  await keyRunsByDesk('void_runs');
}

async function saveVoid(desk, job, withList) {
  const progress = {
    id: job.id, state: job.state, force: job.force, total: job.total,
    voided: job.voided, held: job.held, failed: job.failed,
    retried: job.retried || 0, lastId: job.lastId,
    startedAt: job.startedAt, finishedAt: job.finishedAt,
    events: job.events.slice(-300)
  };
  if (withList) {
    await pool.query(
      `INSERT INTO void_runs (realm_id, user_sub, invoices, progress, updated_at)
       VALUES ($1,$4,$2,$3, now())
       ON CONFLICT (realm_id, user_sub) DO UPDATE SET
         invoices = $2, progress = $3, updated_at = now()`,
      [realmOf(desk), JSON.stringify(job.invoices), JSON.stringify(progress), userOf(desk)]);
  } else {
    await pool.query(
      `UPDATE void_runs SET progress = $2, updated_at = now()
        WHERE realm_id = $1 AND user_sub = $3`,
      [realmOf(desk), JSON.stringify(progress), userOf(desk)]);
  }
}

// written every few results or every 15 seconds, and always when the state changes
function saveSoon(desk, job, force) {
  job.unsaved = (job.unsaved || 0) + 1;
  if (!force && job.unsaved < 5 && Date.now() - (job.savedAt || 0) < 15000) return;
  job.unsaved = 0;
  job.savedAt = Date.now();
  return saveVoid(desk, job, false).catch(e => console.error('void save:', e.message));
}

// after a restart: a run that was going carries on, one that had stopped or
// finished comes back as it was, so its log and its Carry on are still there
export async function resumeVoidRuns() {
  const q = await pool.query('SELECT realm_id, user_sub, invoices, progress FROM void_runs');
  for (const row of q.rows) {
    try {
      const p = row.progress || {};
      // nobody's run - written before runs had an owner - is not restarted
      if (!row.user_sub) continue;
      const desk = deskKey(row.realm_id, row.user_sub);
      const job = {
        id: p.id || Date.now(), desk, state: p.state || 'stopped', stop: false,
        invoices: row.invoices || [], force: !!p.force,
        delay: 0, lanes: 1, token: null, tokenAt: 0,
        total: p.total || (row.invoices || []).length,
        voided: p.voided || [], held: p.held || [], failed: p.failed || [],
        retried: p.retried || 0, events: p.events || [], lastId: p.lastId || 0,
        startedAt: p.startedAt || Date.now(), finishedAt: p.finishedAt || null
      };
      job.done = job.voided.length + job.held.length + job.failed.length;
      jobs.set(desk, job);
      if (job.state !== 'running') continue;

      const gone = new Set(job.voided.concat(job.held, job.failed).map(x => String(x.id)));
      const left = job.invoices
        .filter(i => !gone.has(String(i.id)))
        .map(i => Object.assign({}, i, { syncToken: null }));
      push(job, 'log', 'The server restarted - carrying on where it stopped (' + left.length + ' left).');
      run(row.realm_id, job, left).catch(e => {
        push(job, 'error', 'ERROR: ' + e.message);
        job.state = 'error';
        job.finishedAt = Date.now();
        saveSoon(desk, job, true);
      });
    } catch (e) {
      console.error('void resume:', e.message);
    }
  }
}

function push(job, type, msg, extra) {
  job.lastId++;
  job.events.push(Object.assign(
    { id: job.lastId, type, msg, at: Date.now() },
    extra || {}
  ));
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

export function startVoidJob(desk, { invoices, force, delay }) {
  const realmId = realmOf(desk);
  const live = jobs.get(desk);
  if (live && live.state === 'running') {
    throw new Error('A void run of yours is already going');
  }
  if (!Array.isArray(invoices) || !invoices.length) throw new Error('Nothing to void');

  const job = {
    id: Date.now(),
    desk,
    state: 'running',
    stop: false,
    invoices,
    force: !!force,
    // one invoice per request, back to back - no pause between them
    delay: delay === undefined ? 0 : Number(delay) || 0,
    lanes: 1, // strictly one at a time: QuickBooks turns down voids sent together
    token: null,
    tokenAt: 0,
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

  jobs.set(desk, job);
  // written down before it starts, so a restart in the first minutes is not lost
  saveVoid(desk, job, true).catch(e => console.error('void save:', e.message));
  run(realmId, job).catch(e => {
    push(job, 'error', 'ERROR: ' + e.message);
    job.state = 'error';
    job.finishedAt = Date.now();
    saveSoon(job.desk, job, true);
  });

  return job.id;
}

async function run(realmId, job, only) {
  push(job, 'log', 'Connecting to QuickBooks...');
  await tokenFor(realmId, job);

  const count = only ? only.length : job.total;
  push(job, 'log', (only ? 'Carrying on: ' : '') + `Voiding ${count} invoice${count === 1 ? '' : 's'}` +
    (job.force ? ' - linked payments will be freed first.' : '.'));

  // One invoice at a time. Those with no payment go first, then those on a payment.
  const order = (only || job.invoices).slice();
  const queue = order.filter(x => !x.hasPayment).concat(order.filter(x => x.hasPayment));
  push(job, 'log', `${queue.length} to void, one at a time. A refused one goes to the back of ` +
    `the queue and comes round again ${Math.round(RETRY_PAUSE / 1000)} seconds later, so the rest do not wait for it.`);

  // Does one attempt and says what came of it: 'done', 'retry' or 'final'.
  async function attempt(inv) {
    let r;
    try {
      const token = await tokenFor(realmId, job);
      r = await voidOne(realmId, token, inv, job.force);

      // the hour ran out mid-run - sign in again and have another go now
      if (!r.ok && isAuthError(r.msg)) {
        const fresh = await tokenFor(realmId, job, true);
        r = await voidOne(realmId, fresh, Object.assign({}, inv, { syncToken: null }), job.force);
      }
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
      saveSoon(job.desk, job);
      return 'done';
    }

    if (r.held) {
      job.done++;
      job.held.push({ doc: inv.doc, id: inv.id, msg: r.msg });
      push(job, 'held', `HELD    ${inv.doc}   ${r.msg}`, { doc: inv.doc });
      saveSoon(job.desk, job);
      return 'done';
    }

    // a refusal is QuickBooks being busy - a lock, a timeout - not the invoice,
    // so it is tried again after a pause, however many times that takes
    if (!/not in QuickBooks any more/.test(r.msg)) {
      job.retried = (job.retried || 0) + 1;
      push(job, 'retry', `retry  ${inv.doc}   ${String(r.msg).slice(0, 300)}`);
      return 'retry';
    }

    job.done++;
    job.failed.push({ doc: inv.doc, id: inv.id, msg: r.msg });
    push(job, 'fail', `FAILED  ${inv.doc}   ${String(r.msg).slice(0, 200)}`, { doc: inv.doc });
    saveSoon(job.desk, job);
    return 'final';
  }

  // The queue is worked from the front, without a pause: a void that goes through
  // quickly is followed straight away by the next one. A refused one is put at the
  // back with the time it may be tried again, so the others carry on meanwhile and
  // it comes round later. Only when every one left is still waiting does the run
  // pause, and then only until the first of them is due.
  const waiting = queue.map(inv => ({ inv, readyAt: 0 }));

  while (waiting.length && !job.stop) {
    const now = Date.now();
    let at = waiting.findIndex(w => w.readyAt <= now);

    if (at < 0) {
      // every one left is still cooling off - wait for the first that is due
      const due = Math.min(...waiting.map(w => w.readyAt));
      const secs = Math.max(1, Math.round((due - now) / 1000));
      push(job, 'log', `${waiting.length} waiting for QuickBooks to let go - ${secs}s until the next try.`);
      await nap(job, due - now);
      job.token = null; // a fresh sign-in after the wait
      continue;
    }

    const one = waiting.splice(at, 1)[0];
    const out = await attempt(Object.assign({}, one.inv, { syncToken: null }));
    if (out === 'retry') {
      one.readyAt = Date.now() + RETRY_PAUSE;
      waiting.push(one);
    }
  }

  if (job.stop) {
    push(job, 'log', 'Stopped.');
    job.state = 'stopped';
  } else {
    push(job, 'log', `--- ${job.voided.length} voided, ${job.held.length} held back, ${job.failed.length} failed ---`);
    job.state = 'done';
  }
  job.finishedAt = Date.now();
  await saveSoon(job.desk, job, true);
}

// Carry on after a Stop: whatever was neither voided nor held back - the ones
// not reached and the ones that failed - goes through the same run again.
export function resumeVoidJob(desk) {
  const realmId = realmOf(desk);
  const job = jobs.get(desk);
  if (!job) throw new Error('There is no void run to carry on');
  if (job.state === 'running') throw new Error('The void run is still going');

  const gone = new Set(job.voided.concat(job.held).map(x => String(x.id)));
  const left = job.invoices
    .filter(i => !gone.has(String(i.id)))
    .map(i => Object.assign({}, i, { syncToken: null }));
  if (!left.length) throw new Error('Nothing is left to void');

  job.failed = [];
  job.done = gone.size;
  job.stop = false;
  job.state = 'running';
  job.finishedAt = null;
  saveSoon(job.desk, job, true);
  run(realmId, job, left).catch(e => {
    push(job, 'error', 'ERROR: ' + e.message);
    job.state = 'error';
    job.finishedAt = Date.now();
    saveSoon(job.desk, job, true);
  });
}

export function stopVoidJob(desk) {
  const job = jobs.get(desk);
  if (!job) return false;
  job.stop = true;
  push(job, 'log', 'Stop requested - finishing the invoice in flight...');
  return true;
}

export function clearVoidJob(desk) {
  const job = jobs.get(desk);
  if (job && job.state === 'running') return false;
  jobs.delete(desk);
  pool.query('DELETE FROM void_runs WHERE realm_id = $1 AND user_sub = $2',
    [realmOf(desk), userOf(desk)]).catch(() => {});
  return true;
}

export function voidSnapshot(desk, since, full) {
  const job = jobs.get(desk);
  if (!job) return null;

  const out = {
    id: job.id,
    state: job.state,
    total: job.total,
    done: job.done,
    seen: job.done + (job.retried || 0),
    retried: job.retried || 0,
    voidedCount: job.voided.length,
    heldCount: job.held.length,
    failedCount: job.failed.length,
    leftCount: Math.max(0, job.total - job.voided.length - job.held.length),
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
