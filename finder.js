// Paste a pile of order numbers, and this walks the courier folders looking
// for each one. It answers a plain question: which courier had it, and what
// happened to it. Runs as a background job, so leaving the page is fine.

import { listFolders, listSheetsIn, listTabs } from './sheets.js';
import { loadSheet, digitsOf, clean } from './cpr.js';
import { getSetting } from './settings.js';

const jobs = new Map();          // realmId -> job

function now() { return Date.now(); }

export function findSnapshot(realmId, since) {
  const job = jobs.get(realmId);
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
    log: job.log.slice(from),
    logLength: job.log.length,
    result: job.state === 'done' ? summarise(job) : null,
    error: job.error || null
  };
}

export function stopFindJob(realmId) {
  const job = jobs.get(realmId);
  if (!job || job.state !== 'running') return false;
  job.cancel = true;
  return true;
}

export function clearFindJob(realmId) {
  const job = jobs.get(realmId);
  if (job && job.state === 'running') return false;
  jobs.delete(realmId);
  return true;
}

function say(job, text) {
  job.log.push({ at: new Date().toISOString(), text });
  if (job.log.length > 4000) job.log.splice(0, 1000);
}

// what the sheet's own words mean, in plain buckets
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

function summarise(job) {
  const byCourier = {};
  const rows = [];

  job.hits.forEach((hit, key) => {
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
  job.wanted.forEach(d => { if (!job.hits.has(d)) missing.push(job.asWritten.get(d) || d); });

  const r2 = v => Math.round(Number(v || 0) * 100) / 100;

  return {
    asked: job.asked,
    found: job.hits.size,
    missing,
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

export function startFindJob(realmId, opts) {
  const old = jobs.get(realmId);
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
    log: [],
    sheetsSeen: 0,
    sheetsTotal: 0,
    months: (opts.months || []).map(x => String(x).toLowerCase())
  };

  jobs.set(realmId, job);
  run(realmId, job).catch(e => {
    job.state = 'failed';
    job.error = e.message;
    job.finishedAt = new Date().toISOString();
  });

  return job.id;
}

// a month folder is wanted if no months were picked, or its name matches one
function monthWanted(job, name) {
  if (!job.months.length) return true;
  const low = String(name || '').toLowerCase();
  return job.months.some(m => low.includes(m));
}

async function run(realmId, job) {
  const root = await getSetting(realmId, 'cpr:root', '');
  if (!root) throw new Error('Set the Drive folder in Receive payments first');

  say(job, `Looking for ${job.asked} order numbers`);

  const couriers = await listFolders(root);
  say(job, `${couriers.length} courier folders to walk through`);

  // build the list of files first, so progress can be counted
  const files = [];
  for (const c of couriers) {
    if (job.cancel) break;

    let months = [], loose = [];
    try {
      [months, loose] = await Promise.all([listFolders(c.id), listSheetsIn(c.id)]);
    } catch (e) {
      say(job, `${c.name}: could not be opened - ${e.message}`);
      continue;
    }

    loose.forEach(f => files.push({ courier: c.name, month: '', file: f }));

    for (const m of months) {
      if (!monthWanted(job, m.name)) continue;
      try {
        const inside = await listSheetsIn(m.id);
        inside.forEach(f => files.push({ courier: c.name, month: m.name, file: f }));
      } catch (e) {
        say(job, `${c.name} / ${m.name}: ${e.message}`);
      }
    }
  }

  job.sheetsTotal = files.length;
  say(job, `${files.length} sheets to read`);

  for (const item of files) {
    if (job.cancel) break;
    if (job.hits.size >= job.wanted.size) {
      say(job, 'Every number has been found - stopping early');
      break;
    }

    const where = item.month ? `${item.courier} / ${item.month}` : item.courier;

    let tabs = [];
    try {
      tabs = await listTabs(item.file.id, item.file.excel);
    } catch (e) {
      job.sheetsSeen++;
      say(job, `${where} / ${item.file.name}: ${e.message}`);
      continue;
    }

    let foundHere = 0;

    for (const t of tabs) {
      if (job.cancel) break;
      let data;
      try {
        data = await loadSheet(item.file.id, t.title, item.file.excel, null);
      } catch (e) {
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
          bucket: hasStatus ? bucketOf(r.status) : 'unknown',
          amount: r.amount || 0,
          cprNumber: r.cprNumber || '',
          cprDate: r.cprDate || null
        });
        foundHere++;
      });
    }

    job.sheetsSeen++;
    if (foundHere) {
      say(job, `${where} / ${item.file.name}: found ${foundHere}` +
               ` (${job.hits.size} of ${job.wanted.size} so far)`);
    }
  }

  job.state = job.cancel ? 'stopped' : 'done';
  job.finishedAt = new Date().toISOString();
  say(job, job.cancel
    ? `Stopped - ${job.hits.size} of ${job.wanted.size} found`
    : `Finished - ${job.hits.size} of ${job.wanted.size} found`);
}

// the month folders that exist, so the page can offer them
export async function listMonths(realmId) {
  const root = await getSetting(realmId, 'cpr:root', '');
  if (!root) throw new Error('Set the Drive folder in Receive payments first');

  const couriers = await listFolders(root);
  const names = new Set();

  for (const c of couriers) {
    try {
      const months = await listFolders(c.id);
      months.forEach(m => names.add(m.name));
    } catch (e) { /* skip */ }
  }

  return [...names].sort();
}
