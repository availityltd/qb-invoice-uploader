// Bringing months of a courier's history into our own table, once. After this
// runs, everything else - the receipts, the city figures, what is still owed -
// is answered from here instead of asking the courier all over again.

import { getAccount, saveOrders, needCpr, savePayments } from './couriers.js';
import { adapter as postexAdapter } from './postex.js';
import { realmOf } from './desk.js';

const ADAPTERS = { postex: postexAdapter };

const jobs = new Map();          // desk (company and person) -> job

const now = () => Date.now();
const sleep = ms => new Promise(r => setTimeout(r, ms));

function say(job, text) {
  job.log.push({ at: new Date().toISOString(), text });
  if (job.log.length > 3000) job.log.splice(0, 800);
}

async function tryThrice(job, what, work) {
  let last;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await work();
    } catch (e) {
      last = e;
      if (job.cancel) throw e;
      if (attempt < 3) {
        say(job, `${what}: ${e.message} - trying again (${attempt} of 3)`);
        await sleep(attempt * 4000);
      }
    }
  }
  throw last;
}

// a month at a time keeps each answer small enough to arrive
function monthsBetween(from, to) {
  const out = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  const lastY = Number(to.slice(0, 4));
  const lastM = Number(to.slice(5, 7));

  let guard = 0;
  while ((y < lastY || (y === lastY && m <= lastM)) && guard < 60) {
    const start = `${y}-${String(m).padStart(2, '0')}-01`;
    const endDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    let end = `${y}-${String(m).padStart(2, '0')}-${String(endDay).padStart(2, '0')}`;

    out.push({
      from: start < from ? from : start,
      to: end > to ? to : end,
      label: start.slice(0, 7)
    });

    m++;
    if (m > 12) { m = 1; y++; }
    guard++;
  }
  return out;
}

export function backfillSnapshot(desk, since) {
  const job = jobs.get(desk);
  if (!job) return null;

  return {
    id: job.id,
    state: job.state,
    phase: job.phase,
    canCarryOn: job.state === 'stopped' || job.state === 'failed',
    startedAt: job.startedAt,
    finishedAt: job.finishedAt || null,
    account: job.label,
    monthsDone: job.monthsDone,
    monthsTotal: job.monthsTotal,
    ordersSaved: job.ordersSaved,
    asked: job.asked,
    withCpr: job.withCpr,
    cprLeft: job.cprLeft,
    log: job.log.slice(Number(since) || 0),
    logLength: job.log.length,
    error: job.error || null
  };
}

// Carry on after a Stop or a failure: the months not yet kept are read again,
// and the receipts are asked for again where they are still missing.
export function resumeBackfill(desk) {
  const realmId = realmOf(desk);
  const job = jobs.get(desk);
  if (!job) throw new Error('There is no backfill to carry on');
  if (job.state === 'running') throw new Error('The backfill is still running');
  if (job.state === 'done') throw new Error('The backfill already finished');

  job.cancel = false;
  job.error = null;
  job.state = 'running';
  job.phase = 'orders';
  job.finishedAt = null;
  job.monthsDone = job.okMonths.size;
  say(job, 'Carrying on');
  run(realmId, job, true).catch(e => {
    job.state = 'failed';
    job.error = e.message;
    job.finishedAt = new Date().toISOString();
    say(job, 'Stopped: ' + e.message);
  });
}

export function stopBackfill(desk) {
  const job = jobs.get(desk);
  if (!job || job.state !== 'running') return false;
  job.cancel = true;
  return true;
}

export function clearBackfill(desk) {
  const job = jobs.get(desk);
  if (job && job.state === 'running') return false;
  jobs.delete(desk);
  return true;
}

export function startBackfill(desk, opts) {
  const realmId = realmOf(desk);
  const old = jobs.get(desk);
  if (old && old.state === 'running') throw new Error('A backfill is already running');

  const from = String(opts.from || '').slice(0, 10);
  const to = String(opts.to || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    throw new Error('Pick a from and to date');
  }
  if (from > to) throw new Error('The first date is after the last one');
  if (!opts.account) throw new Error('Pick an account');

  const job = {
    id: 'fill-' + now(),
    state: 'running',
    phase: 'orders',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    cancel: false,
    error: null,
    accountId: Number(opts.account),
    label: '',
    from, to,
    months: monthsBetween(from, to),
    monthsDone: 0,
    okMonths: new Set(),          // months kept, which a carry-on skips
    monthsTotal: 0,
    ordersSaved: 0,
    asked: 0,
    cprLeft: 0,
    withCpr: opts.withCpr !== false,
    log: []
  };
  job.monthsTotal = job.months.length;

  jobs.set(desk, job);
  run(realmId, job).catch(e => {
    job.state = 'failed';
    job.error = e.message;
    job.finishedAt = new Date().toISOString();
    say(job, 'Stopped: ' + e.message);
  });

  return job.id;
}

async function run(realmId, job, carrying) {
  const acc = await getAccount(realmId, job.accountId);
  if (!acc) throw new Error('No such account');

  const a = ADAPTERS[acc.courier];
  if (!a) throw new Error('No adapter for ' + acc.courier);

  job.label = acc.label;
  if (!carrying) say(job, `${acc.label}: ${job.from} to ${job.to}, ${job.months.length} month${job.months.length === 1 ? '' : 's'}`);

  /* ---------- the orders themselves ---------- */

  for (const m of job.months) {
    if (job.cancel) break;
    if (job.okMonths.has(m.label)) continue;

    let orders = [];
    try {
      orders = await tryThrice(job, m.label, () => a.fetchOrders(acc.token, m.from, m.to, 0));
    } catch (e) {
      say(job, `${m.label}: gave up - ${e.message}`);
      job.monthsDone++;
      continue;
    }

    let saved = 0;
    try {
      saved = await saveOrders(realmId, acc.id, acc.courier, orders);
    } catch (e) {
      say(job, `${m.label}: ${orders.length} came back but could not be kept - ${e.message}`);
      job.monthsDone++;
      continue;
    }

    job.ordersSaved += saved;
    job.monthsDone++;
    job.okMonths.add(m.label);
    say(job, `${m.label}: ${orders.length} orders, ${saved} kept`);

    await sleep(500);
  }

  if (job.cancel) {
    job.state = 'stopped';
    job.finishedAt = new Date().toISOString();
    say(job, `Stopped - ${job.ordersSaved} orders kept`);
    return;
  }

  /* ---------- then what each one was paid under ---------- */

  if (job.withCpr && a.fetchPayment) {
    job.phase = 'receipts';
    say(job, 'Now asking what each delivered parcel was paid under');

    let round = 0;
    while (!job.cancel && round < 400) {
      let list;
      try {
        list = await needCpr(realmId, acc.id, 80);
      } catch (e) {
        say(job, 'Could not read the list of what is left - ' + e.message);
        break;
      }

      if (!list.length) {
        say(job, 'Every delivered parcel has been asked about');
        break;
      }

      job.cprLeft = list.length;

      // eight at a time - quick, without leaning on the courier
      for (let i = 0; i < list.length; i += 8) {
        if (job.cancel) break;
        const chunk = list.slice(i, i + 8);
        const answers = await Promise.all(
          chunk.map(t => a.fetchPayment(acc.token, t).catch(() => null))
        );
        const good = answers.filter(Boolean);
        try { await savePayments(realmId, acc.id, good); } catch (e) {}
        job.asked += chunk.length;
      }

      round++;
      if (round % 5 === 0) say(job, `${job.asked} asked about so far`);
      await sleep(300);
    }
  }

  job.state = job.cancel ? 'stopped' : 'done';
  job.phase = 'done';
  job.finishedAt = new Date().toISOString();
  say(job, job.cancel
    ? `Stopped - ${job.ordersSaved} orders kept, ${job.asked} asked about`
    : `Finished - ${job.ordersSaved} orders kept, ${job.asked} asked about`);
}
