// The other way round. The Void page's first tab takes order numbers off the
// return sheet and looks them up in QuickBooks; this looks a pile of pasted
// invoice numbers up in the return sheet instead - were these ones ever
// returned to us, and on what day. Nothing is written anywhere: it reads the
// workbook tab by tab and says what it found.
//
// It runs as a job on the server, like everything else that can take a while,
// so the page can be left, Stop is honoured between tabs, and what was read
// already is kept for Carry on.

import { listTabs } from './sheets.js';
import { digitsOf } from './cpr.js';
import { readDateColumns } from './voidsheet.js';

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

export function startCheckJob(desk, opts) {
  const live = jobs.get(desk);
  if (live && live.state === 'running') {
    throw new Error('A return sheet check of yours is already going');
  }

  const raw = opts.numbers;
  const list = (Array.isArray(raw) ? raw : String(raw || '').split(/[\s,;]+/))
    .map(x => String(x).trim())
    .filter(Boolean);
  if (!list.length) throw new Error('Paste some invoice numbers first');
  if (!opts.sheetId) throw new Error('Pick the return workbook first');

  // "#91298851" and "91298851" are the same order written two ways - the
  // pasted number and the one in the sheet both come down to their digits, so
  // either spelling is found without anybody having to paste it twice.
  const asked = [];
  const byKey = new Map();
  list.forEach(n => {
    const key = digitsOf(n);
    if (!key) return;
    if (byKey.has(key)) { byKey.get(key).times++; return; }
    const row = { key, written: n, times: 1, places: [] };
    byKey.set(key, row);
    asked.push(row);
  });
  if (!asked.length) throw new Error('None of those lines holds an order number');

  const job = {
    id: Date.now(),
    state: 'running',
    stop: false,
    sheetId: String(opts.sheetId),
    sheetName: String(opts.sheetName || 'the return sheet'),
    excel: !!opts.excel,
    wantTabs: Array.isArray(opts.tabs) ? opts.tabs.filter(Boolean) : [],
    from: opts.from || '',
    to: opts.to || '',
    pasted: list.length,
    asked,
    byKey,
    tabsAll: [],
    tabsDone: [],
    tabsSkipped: [],
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

async function run(job, only) {
  if (!job.tabsAll.length) {
    let tabs = job.wantTabs.slice();
    if (!tabs.length) {
      const all = await tryThrice(job, 'The return sheet',
        () => listTabs(job.sheetId, job.excel));
      tabs = all.map(t => t.title);
    }
    job.tabsAll = tabs;
  }

  const done = new Set(job.tabsDone.concat(job.tabsSkipped));
  const queue = (only || job.tabsAll).filter(t => !done.has(t));

  push(job, 'log',
    `${job.asked.length} order number${job.asked.length === 1 ? '' : 's'} to look for in ` +
    `${queue.length} tab${queue.length === 1 ? '' : 's'} of ${job.sheetName}` +
    (job.from || job.to ? ` (${job.from || 'the start'} to ${job.to || 'the end'})` : '') + '.');

  for (const title of queue) {
    if (job.stop) break;

    let d;
    try {
      d = await tryThrice(job, title, () => readDateColumns(job.sheetId, title, job.excel));
    } catch (e) {
      job.tabsSkipped.push(title);
      push(job, 'fail', `SKIPPED ${title}   ${String(e.message).slice(0, 200)}`);
      continue;
    }

    let hits = 0;
    (d.days || []).forEach(day => {
      if (job.from && day.date && day.date < job.from) return;
      if (job.to   && day.date && day.date > job.to)   return;

      (day.numbers || []).forEach(n => {
        const row = job.byKey.get(digitsOf(n));
        if (!row) return;
        // the same order can be written on two days, or twice on one - every
        // place it sits is kept, because that is itself worth seeing
        row.places.push({ tab: title, date: day.date || '', written: n });
        hits++;
      });
    });

    job.tabsDone.push(title);
    push(job, hits ? 'ok' : 'log',
      `${title}   ${hits ? 'found ' + hits : 'nothing here'}` +
      `   (${job.tabsDone.length + job.tabsSkipped.length} of ${job.tabsAll.length} tabs)`);
  }

  const found = job.asked.filter(r => r.places.length).length;

  if (job.stop) {
    push(job, 'log', 'Stopped.');
    job.state = 'stopped';
  } else {
    push(job, 'log',
      `--- ${found} of ${job.asked.length} on the return sheet, ` +
      `${job.asked.length - found} not on it ---`);
    job.state = 'done';
  }
  job.finishedAt = Date.now();
}

// Carry on after a Stop: the tabs not yet read are read now, in the same log,
// and what was found before stands.
export function resumeCheckJob(desk) {
  const job = jobs.get(desk);
  if (!job) throw new Error('There is no return sheet check to carry on');
  if (job.state === 'running') throw new Error('The return sheet check is still going');

  const done = new Set(job.tabsDone);
  const left = job.tabsAll.filter(t => !done.has(t));
  if (!left.length) throw new Error('Every tab has been read already');

  // a tab that was skipped is worth another go on the way through
  job.tabsSkipped = [];
  job.stop = false;
  job.state = 'running';
  job.finishedAt = null;
  push(job, 'log', `Carrying on - ${left.length} tab${left.length === 1 ? '' : 's'} left.`);
  run(job, left).catch(e => {
    push(job, 'error', 'ERROR: ' + e.message);
    job.state = 'error';
    job.finishedAt = Date.now();
  });
}

export function stopCheckJob(desk) {
  const job = jobs.get(desk);
  if (!job) return false;
  job.stop = true;
  push(job, 'log', 'Stop requested - finishing the tab being read...');
  return true;
}

export function clearCheckJob(desk) {
  const job = jobs.get(desk);
  if (job && job.state === 'running') return false;
  jobs.delete(desk);
  return true;
}

export function checkSnapshot(desk, since, full) {
  const job = jobs.get(desk);
  if (!job) return null;

  const found = [], missing = [];
  job.asked.forEach(r => {
    const row = {
      doc: r.written,
      number: r.key,
      pastedTimes: r.times,
      places: r.places
    };
    (r.places.length ? found : missing).push(row);
  });

  const out = {
    id: job.id,
    state: job.state,
    sheetName: job.sheetName,
    from: job.from,
    to: job.to,
    pasted: job.pasted,
    unique: job.asked.length,
    total: job.tabsAll.length,
    done: job.tabsDone.length + job.tabsSkipped.length,
    skippedCount: job.tabsSkipped.length,
    foundCount: found.length,
    missingCount: missing.length,
    leftCount: Math.max(0, job.tabsAll.length - job.tabsDone.length),
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    events: job.events.filter(e => e.id > (Number(since) || 0)),
    lastEventId: job.lastId
  };

  if (full || job.state !== 'running') {
    out.found = found;
    out.missing = missing;
  }

  return out;
}
