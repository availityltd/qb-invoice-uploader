// Where an order sits in the advance sheet.
//
// The Advance payments page works forwards: pick a month's tab, pick the days,
// and everything paid on those days is matched against QuickBooks. This is the
// same sheet read backwards - here is a list of order numbers, now find their
// rows, whichever workbook and whichever month they were written in.
//
// It reads tab by tab and nothing else, so it runs as a job on the server with
// Stop, Carry on and Clear log: a search started on the wrong months is stopped
// the moment it is seen, and started again on the right ones.

import { listTabs } from './sheets.js';
import { digitsOf } from './cpr.js';
import { loadAdvance } from './advance.js';

const jobs = new Map();            // desk (company and person) -> job
const MAX_EVENTS = 3000;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function push(job, type, msg) {
  job.lastId++;
  job.events.push({ id: job.lastId, type, msg, at: Date.now() });
  if (job.events.length > MAX_EVENTS) {
    job.events.splice(0, job.events.length - MAX_EVENTS);
  }
}

// Google says no now and then. Three tries, each after a longer pause.
async function tryThrice(job, what, work) {
  let last;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await work();
    } catch (e) {
      last = e;
      if (job.stop) throw e;
      if (attempt < 3) {
        push(job, 'retry', `${what}: ${e.message} - trying again (${attempt} of 3)`);
        await sleep(attempt * 3000);
      }
    }
  }
  throw last;
}

export function startAdvFind(desk, opts) {
  const live = jobs.get(desk);
  if (live && live.state === 'running') {
    throw new Error('A search of yours is already going');
  }

  const raw = opts.numbers;
  const list = (Array.isArray(raw) ? raw : String(raw || '').split(/[\s,;]+/))
    .map(x => String(x).trim())
    .filter(Boolean);
  if (!list.length) throw new Error('Paste some order numbers first');

  const books = (opts.books || []).filter(b => b && b.id);
  if (!books.length) throw new Error('Pick at least one workbook to read');

  // "#91298851" and "91298851" are one order written two ways
  const wanted = new Map();
  list.forEach(n => {
    const key = digitsOf(n);
    if (!key || wanted.has(key)) return;
    wanted.set(key, n);
  });
  if (!wanted.size) throw new Error('None of those lines holds an order number');

  const job = {
    id: Date.now(),
    state: 'running',
    stop: false,
    books,
    cols: opts.cols || null,
    wanted,
    pasted: list.length,
    hits: [],
    seen: [],                      // "<book id>|<tab>" already read to the end
    skipped: [],
    tabsTotal: 0,
    events: [],
    lastId: 0,
    startedAt: Date.now(),
    finishedAt: null
  };

  jobs.set(desk, job);
  run(job).catch(e => {
    push(job, 'error', 'ERROR: ' + e.message);
    job.state = 'error';
    job.finishedAt = Date.now();
  });

  return job.id;
}

async function run(job) {
  // the tabs to read, worked out once and then kept, so a carry-on knows
  // exactly what is left
  if (!job.plan) {
    const plan = [];
    for (const b of job.books) {
      if (job.stop) break;
      let tabs = (b.tabs && b.tabs.length) ? b.tabs : null;
      if (!tabs) {
        const all = await tryThrice(job, b.name || 'the workbook',
          () => listTabs(b.id, !!b.excel));
        tabs = all.map(t => t.title);
      }
      tabs.forEach(t => plan.push({ id: b.id, name: b.name || '', excel: !!b.excel, tab: t }));
    }
    job.plan = plan;
    job.tabsTotal = plan.length;
  }

  const done = new Set(job.seen.concat(job.skipped));
  const queue = job.plan.filter(x => !done.has(x.id + '|' + x.tab));

  push(job, 'log',
    `${job.wanted.size} order number${job.wanted.size === 1 ? '' : 's'} to look for in ` +
    `${queue.length} tab${queue.length === 1 ? '' : 's'}.`);

  for (const at of queue) {
    if (job.stop) break;

    let d;
    try {
      d = await tryThrice(job, `${at.name} / ${at.tab}`,
        () => loadAdvance(at.id, at.tab, at.excel, job.cols));
    } catch (e) {
      job.skipped.push(at.id + '|' + at.tab);
      push(job, 'fail', `SKIPPED ${at.name} / ${at.tab}   ${String(e.message).slice(0, 200)}`);
      continue;
    }

    let found = 0;
    (d.rows || []).forEach(r => {
      const key = digitsOf(r.invoice);
      if (!key || !job.wanted.has(key)) return;
      // the same order can be part paid twice, on two days - both rows are
      // real advances and both are shown
      job.hits.push(Object.assign({}, r, {
        asked: job.wanted.get(key),
        sheetId: at.id,
        sheetName: at.name,
        tab: at.tab,
        excel: at.excel
      }));
      found++;
    });

    job.seen.push(at.id + '|' + at.tab);
    push(job, found ? 'ok' : 'log',
      `${at.name} / ${at.tab}   ${found ? 'found ' + found : 'nothing here'}` +
      `   (${job.seen.length + job.skipped.length} of ${job.tabsTotal} tabs)`);
  }

  if (job.stop) {
    push(job, 'log', 'Stopped.');
    job.state = 'stopped';
  } else {
    const hit = new Set(job.hits.map(h => digitsOf(h.invoice)));
    push(job, 'log',
      `--- ${hit.size} of ${job.wanted.size} found in the advance sheet, ` +
      `${job.wanted.size - hit.size} not in it ---`);
    job.state = 'done';
  }
  job.finishedAt = Date.now();
}

export function resumeAdvFind(desk) {
  const job = jobs.get(desk);
  if (!job) throw new Error('There is no search to carry on');
  if (job.state === 'running') throw new Error('The search is still going');

  const done = new Set(job.seen);
  const left = (job.plan || []).filter(x => !done.has(x.id + '|' + x.tab));
  if (!left.length) throw new Error('Every tab has been read already');

  // a tab that was skipped is worth another go on the way through
  job.skipped = [];
  job.stop = false;
  job.state = 'running';
  job.finishedAt = null;
  push(job, 'log', `Carrying on - ${left.length} tab${left.length === 1 ? '' : 's'} left.`);
  run(job).catch(e => {
    push(job, 'error', 'ERROR: ' + e.message);
    job.state = 'error';
    job.finishedAt = Date.now();
  });
}

export function stopAdvFind(desk) {
  const job = jobs.get(desk);
  if (!job) return false;
  job.stop = true;
  push(job, 'log', 'Stop requested - finishing the tab being read...');
  return true;
}

export function clearAdvFind(desk) {
  const job = jobs.get(desk);
  if (job && job.state === 'running') return false;
  jobs.delete(desk);
  return true;
}

export function advFindSnapshot(desk, since) {
  const job = jobs.get(desk);
  if (!job) return null;

  const hit = new Set(job.hits.map(h => digitsOf(h.invoice)));
  const missing = [];
  job.wanted.forEach((written, key) => { if (!hit.has(key)) missing.push(written); });

  return {
    id: job.id,
    state: job.state,
    pasted: job.pasted,
    asked: job.wanted.size,
    found: hit.size,
    rows: job.hits,
    missing,
    total: job.tabsTotal,
    done: job.seen.length + job.skipped.length,
    skippedCount: job.skipped.length,
    leftCount: Math.max(0, job.tabsTotal - job.seen.length),
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    events: job.events.filter(e => e.id > (Number(since) || 0)),
    lastEventId: job.lastId
  };
}
