// Paste a pile of order numbers, and this walks the courier sheets looking for
// each one. The page says which folders to open and, if wanted, which tabs of
// the return sheet to check afterwards. Runs as a background job, so leaving
// the page changes nothing.

import { listFolders, listSheetsIn, listTabs } from './sheets.js';
import { loadSheet, digitsOf } from './cpr.js';
import { readDateColumns } from './voidsheet.js';
import { getSetting } from './settings.js';
import { realmOf } from './desk.js';

const jobs = new Map();          // desk (company and person) -> job

function now() { return Date.now(); }

const sleep = ms => new Promise(r => setTimeout(r, ms));

function say(job, text) {
  job.log.push({ at: new Date().toISOString(), text });
  if (job.log.length > 4000) job.log.splice(0, 1000);
}

// Google says no now and then. Three tries, each after a longer pause.
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
        await sleep(attempt * 3000);
      }
    }
  }
  throw last;
}

/* ==================== reading folder names ==================== */

// Folder names are written by hand, so the month and year are dug out of
// whatever was typed: "07-July-2025 - MR-UR done" is July 2025.
const MONTH_WORDS = [
  ['jan', 1], ['feb', 2], ['mar', 3], ['apr', 4], ['may', 5], ['jun', 6],
  ['jul', 7], ['aug', 8], ['sep', 9], ['oct', 10], ['nov', 11], ['dec', 12]
];

const MONTH_NAMES = ['', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

export function readFolderName(name) {
  const s = String(name || '').toLowerCase();

  let month = 0;
  for (const [word, n] of MONTH_WORDS) {
    if (s.includes(word)) { month = n; break; }
  }

  const y = s.match(/(20\d{2})/);
  const year = y ? Number(y[1]) : 0;

  return { month, year };
}

// The whole folder tree, so the page can offer years, months and sheets.
export async function listTree(realmId) {
  const root = await getSetting(realmId, 'cpr:root', '');
  if (!root) throw new Error('Set the Drive folder in Receive payments first');

  const companies = await listFolders(root);
  const out = [];

  for (const c of companies) {
    let months = [];
    try {
      months = await listFolders(c.id);
    } catch (e) {
      continue;
    }

    const folders = months.map(m => {
      const { month, year } = readFolderName(m.name);
      return {
        id: m.id,
        name: m.name,
        month,
        year,
        label: month ? `${MONTH_NAMES[month]} ${year || ''}`.trim() : ''
      };
    });

    out.push({ id: c.id, company: c.name, folders });
  }

  return out;
}

// the sheets inside the folders the page picked out
export async function sheetsIn(realmId, folderIds) {
  const ids = (folderIds || []).map(String).filter(Boolean);
  const out = [];

  for (const id of ids) {
    try {
      const files = await listSheetsIn(id);
      files.forEach(f => out.push({ folderId: id, id: f.id, name: f.name, excel: f.excel }));
    } catch (e) { /* skip */ }
  }

  return out;
}

/* ==================== what the sheet's words mean ==================== */
// One courier writes its sheets the same way for every account, so the first
// word of the folder name is enough to know which columns to use.
function colsFor(job, company) {
  if (job.cols[company]) return job.cols[company];
  const word = String(company || '').trim().split(/[\s\-]+/)[0].toLowerCase();
  return job.cols[word] || null;
}
function bucketOf(status) {
  const s = String(status || '').trim().toLowerCase();
  if (!s) return 'unknown';
  if (s.includes('deliver') && !s.includes('under') && !s.includes('out for')) return 'delivered';
  if (s.includes('return')) return 'returned';
  if (s.includes('cancel') || s.includes('un-assign')) return 'cancelled';
  if (s.includes('expire')) return 'expired';
  if (s.includes('lost') || s.includes('stolen')) return 'lost';
  if (s.includes('damage')) return 'damaged';
  if (s.includes('transit') || s.includes('route') || s.includes('out for') ||
      s.includes('warehouse') || s.includes('attempt') || s.includes('picked')) return 'transit';
  if (s.includes('unbook')) return 'unbooked';
  if (s.includes('book')) return 'booked';
  return 'other';
}

/* ==================== the answer ==================== */

function summarise(job) {
  const byCourier = {};
  const rows = [];

  job.hits.forEach(hit => {
    const c = hit.courier || '(unknown)';
    if (!byCourier[c]) {
      byCourier[c] = { courier: c, total: 0, amount: 0, buckets: {} };
    }
    const g = byCourier[c];
    g.total++;
    g.amount += hit.amount || 0;
    g.buckets[hit.bucket] = (g.buckets[hit.bucket] || 0) + 1;

    rows.push(hit);
  });

  const missing = [];
  job.wanted.forEach(d => {
    if (!job.hits.has(d)) missing.push(job.asWritten.get(d) || d);
  });

  const r2 = v => Math.round(Number(v || 0) * 100) / 100;

  return {
    asked: job.asked,
    found: job.hits.size,
    missing,
    skipped: job.skipped,
    couriers: Object.values(byCourier)
      .map(g => ({
        courier: g.courier,
        total: g.total,
        amount: r2(g.amount),
        delivered: g.buckets.delivered || 0,
        returned: g.buckets.returned || 0,
        transit: g.buckets.transit || 0,
        cancelled: g.buckets.cancelled || 0,
        other: g.total - (g.buckets.delivered || 0) - (g.buckets.returned || 0) -
               (g.buckets.transit || 0) - (g.buckets.cancelled || 0)
      }))
      .sort((a, b) => b.total - a.total),
    rows: rows.sort((a, b) =>
      String(a.courier).localeCompare(String(b.courier)) ||
      String(a.invoice).localeCompare(String(b.invoice)))
  };
}

export function findSnapshot(desk, since) {
  const job = jobs.get(desk);
  if (!job) return null;

  const from = Number(since) || 0;
  return {
    id: job.id,
    state: job.state,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt || null,
    asked: job.asked,
    sheetsSeen: job.sheetsSeen,
    sheetsTotal: job.sheetsTotal,
    matched: job.hits.size,
    canCarryOn: job.state === 'stopped' || job.state === 'failed',
    skipped: job.skipped.length,
    log: job.log.slice(from),
    logLength: job.log.length,
    result: (job.state === 'done' || job.state === 'stopped') ? summarise(job) : null,
    error: job.error || null
  };
}

// Carry on after a Stop: the sheets not yet read are read, what was found stays.
export function resumeFindJob(desk) {
  const realmId = realmOf(desk);
  const job = jobs.get(desk);
  if (!job) throw new Error('There is no search to carry on');
  if (job.state === 'running') throw new Error('The search is still running');
  if (job.state === 'done') throw new Error('The search already finished');

  job.cancel = false;
  job.error = null;
  job.state = 'running';
  job.finishedAt = null;
  job.skipped = [];
  job.sheetsSeen = 0;
  say(job, 'Carrying on - ' + job.hits.size + ' of ' + job.wanted.size + ' found so far');
  run(realmId, job, true).catch(e => {
    job.state = 'failed';
    job.error = e.message;
    job.finishedAt = new Date().toISOString();
    say(job, 'Stopped: ' + e.message);
  });
}

export function stopFindJob(desk) {
  const job = jobs.get(desk);
  if (!job || job.state !== 'running') return false;
  job.cancel = true;
  return true;
}

export function clearFindJob(desk) {
  const job = jobs.get(desk);
  if (job && job.state === 'running') return false;
  jobs.delete(desk);
  return true;
}

export function startFindJob(desk, opts) {
  const realmId = realmOf(desk);
  const old = jobs.get(desk);
  if (old && old.state === 'running') throw new Error('A search is already running');

  const raw = opts.numbers;
  const list = (Array.isArray(raw) ? raw : String(raw || '').split(/[\s,;]+/))
    .map(x => String(x).trim())
    .filter(Boolean);

  if (!list.length) throw new Error('Paste some order numbers first');

  const wanted = new Set();
  const asWritten = new Map();
  list.forEach(n => {
    const d = digitsOf(n);
    if (!d) return;
    wanted.add(d);
    if (!asWritten.has(d)) asWritten.set(d, n);
  });

  if (!wanted.size) throw new Error('None of those looked like order numbers');

  const job = {
    id: 'find-' + now(),
    state: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    cancel: false,
    error: null,
    asked: wanted.size,
    wanted,
    asWritten,
    hits: new Map(),
    seen: new Set(),                // sheets read to the end, which a carry-on skips
    log: [],
    skipped: [],
    beat: now(),
    sheetsSeen: 0,
    sheetsTotal: 0,
    folderIds: (opts.folderIds || []).map(String).filter(Boolean),
        cols: opts.cols || {},          // company name -> { invoice, amount, status }
    skipCpr: !!opts.skipCpr,
    returnSheet: opts.returnSheet || null   // { id, name, excel, tabs, from, to }
  };

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
  if (!carrying) say(job, `Looking for ${job.asked} order numbers`);

  if (!job.skipCpr) await walkCpr(realmId, job);

  // whatever the CPR sheets never mentioned may have come back as a return
  const want = job.returnSheet;
  if (!job.cancel && want && want.id) {
    const left = [...job.wanted].filter(d => !job.hits.has(d));
    if (left.length) {
      say(job, `${left.length} still unaccounted for - checking the return sheet`);
      try {
        await walkReturns(job, new Set(left));
      } catch (e) {
        say(job, `The return sheet could not be checked - ${e.message}`);
      }
    } else {
      say(job, 'Nothing was left over, so the return sheet was not needed');
    }
  }

  job.state = job.cancel ? 'stopped' : 'done';
  job.finishedAt = new Date().toISOString();

  if (job.skipped.length) {
    say(job, `${job.skipped.length} sheet${job.skipped.length === 1 ? '' : 's'} could not be read at all`);
  }
  say(job, job.cancel
    ? `Stopped - ${job.hits.size} of ${job.wanted.size} found`
    : `Finished - ${job.hits.size} of ${job.wanted.size} found`);
}

async function walkCpr(realmId, job) {
  const root = await getSetting(realmId, 'cpr:root', '');
  if (!root) throw new Error('Set the Drive folder in Receive payments first');

  const companies = await tryThrice(job, 'The Drive folder', () => listFolders(root));

  // the page hands over the exact folders it picked; with none, everything goes
  const only = job.folderIds.length ? new Set(job.folderIds) : null;
  const files = [];

  for (const c of companies) {
    if (job.cancel) break;

    let months = [], loose = [];
    try {
      months = await tryThrice(job, c.name, () => listFolders(c.id));
      if (!only) loose = await tryThrice(job, c.name, () => listSheetsIn(c.id));
    } catch (e) {
      say(job, `${c.name}: could not be opened - ${e.message}`);
      job.skipped.push(c.name);
      continue;
    }

    loose.forEach(f => files.push({ courier: c.name, month: '', file: f }));

    for (const m of months) {
      if (only && !only.has(String(m.id))) continue;
      try {
        const inside = await tryThrice(job, `${c.name} / ${m.name}`, () => listSheetsIn(m.id));
        inside.forEach(f => files.push({ courier: c.name, month: m.name, file: f }));
      } catch (e) {
        say(job, `${c.name} / ${m.name}: skipped - ${e.message}`);
        job.skipped.push(`${c.name} / ${m.name}`);
      }
    }
  }

  job.sheetsTotal = files.length;
  say(job, `${files.length} sheet${files.length === 1 ? '' : 's'} to read`);

  for (const item of files) {
    if (job.cancel) break;
    if (job.hits.size >= job.wanted.size) {
      say(job, 'Every number has been found in the CPR sheets');
      break;
    }

    if (job.seen.has(item.file.id)) { job.sheetsSeen++; continue; }

    const where = item.month ? `${item.courier} / ${item.month}` : item.courier;
    const label = `${where} / ${item.file.name}`;

    let tabs = [];
    try {
      tabs = await tryThrice(job, label, () => listTabs(item.file.id, item.file.excel));
    } catch (e) {
      job.sheetsSeen++;
      job.skipped.push(label);
      say(job, `${label}: skipped after three tries - ${e.message}`);
      continue;
    }

    let foundHere = 0;
    let tabTrouble = 0;

    for (const t of tabs) {
      if (job.cancel) break;

      let data;
      try {
                       data = await tryThrice(job, `${label} / ${t.title}`,
                   () => loadSheet(item.file.id, t.title, item.file.excel, colsFor(job, item.courier)));
      } catch (e) {
        tabTrouble++;
        job.skipped.push(`${label} / ${t.title}`);
        continue;
      }

      const hasStatus = data.cols.status >= 0;

      data.rows.forEach(r => {
        const d = digitsOf(r.invoice);
        if (!d || !job.wanted.has(d) || job.hits.has(d)) return;

        job.hits.set(d, {
          invoice: job.asWritten.get(d) || r.invoice,
          sheetInvoice: r.invoice,
          courier: item.courier,
          month: item.month,
          sheet: item.file.name,
          tab: t.title,
          sheetRow: r.sheetRow,
          status: r.status || '',
                    // a sheet with no status column only lists what was delivered
          bucket: hasStatus ? bucketOf(r.status) : 'delivered',
          amount: r.amount || 0,
          cprNumber: r.cprNumber || '',
          cprDate: r.cprDate || null
        });
        foundHere++;
      });
    }

    job.sheetsSeen++;
    if (!job.cancel) job.seen.add(item.file.id);
    job.beat = now();

    if (foundHere) {
      say(job, `${label}: found ${foundHere}` +
               ` (${job.hits.size} of ${job.wanted.size} so far)`);
    }
    if (tabTrouble) {
      say(job, `${label}: ${tabTrouble} tab${tabTrouble === 1 ? '' : 's'} could not be read`);
    }
  }
}

// The return sheet is a different shape: dated columns, order numbers stacked
// underneath. The page says which workbook, which tabs, and which days.
async function walkReturns(job, left) {
  const want = job.returnSheet;

  let tabs = (want.tabs && want.tabs.length) ? want.tabs : null;
  if (!tabs) {
    const all = await tryThrice(job, 'The return sheet', () => listTabs(want.id, want.excel));
    tabs = all.map(t => t.title);
  }

  say(job, `Reading ${tabs.length} tab${tabs.length === 1 ? '' : 's'} of the return sheet`);

  for (const title of tabs) {
    if (job.cancel) break;
    if (!left.size) break;

    let d;
    try {
      d = await tryThrice(job, `Returns / ${title}`,
        () => readDateColumns(want.id, title, want.excel));
    } catch (e) {
      job.skipped.push(`Returns / ${title}`);
      continue;
    }

    let foundHere = 0;

    (d.days || []).forEach(day => {
      if (want.from && day.date && day.date < want.from) return;
      if (want.to   && day.date && day.date > want.to)   return;

      (day.numbers || []).forEach(n => {
        const key = digitsOf(n);
        if (!key || !left.has(key) || job.hits.has(key)) return;

        job.hits.set(key, {
          invoice: job.asWritten.get(key) || n,
          sheetInvoice: n,
          courier: 'Returned to us',
          month: '',
          sheet: want.name || 'Return sheet',
          tab: title,
          sheetRow: 0,
          status: 'On the return sheet',
          bucket: 'returned',
          amount: 0,
          cprNumber: '',
          cprDate: day.date || null,
          returnedOn: day.date || null
        });

        left.delete(key);
        foundHere++;
      });
    });

    job.beat = now();

    if (foundHere) {
      say(job, `Returns / ${title}: found ${foundHere}` +
               ` (${job.hits.size} of ${job.wanted.size} so far)`);
    }
  }
}
// The header of the first tab of one sheet, so the page can ask which column
// is which. Only the top few rows are read - a whole workbook is far too much
// to move just to see the names.
export async function peekHeader(sheetId, excel) {
  const tabs = await listTabs(sheetId, excel);
  if (!tabs.length) throw new Error('That file has no tabs');

  const d = await loadSheet(sheetId, tabs[0].title, excel, null);
  return {
    tab: tabs[0].title,
    header: d.header,
    guess: d.cols
  };
}
