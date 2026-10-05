// Why is this invoice still open?
//
// Open invoices pile up for reasons the books themselves do not say: the order
// went to a blogger as a free product, it was damaged or replaced, the customer
// paid part of it in advance, the courier already paid it in a CPR, or it came
// back. Each of those is written down somewhere else - a sheet somebody keeps.
//
// So the sheets are attached once, here, as sources (a CSV, or numbers pasted
// with their amounts), and kept for the company. An audit then takes the open
// invoices - read from QuickBooks by date, pasted with their amounts, or
// uploaded as a CSV - looks each one up in every source, and says what it found.
//
// Nothing here writes to QuickBooks. It is a read, and a run like any other.

import { getAccessToken, qbQuery } from './qb.js';
import { tokenKeeper } from './replaceitem.js';
import { getSetting, setSetting } from './settings.js';
import { digitsOf, splitInvoices, num, loadSheet } from './cpr.js';
import { loadAdvance } from './advance.js';
import { readDateColumns } from './voidsheet.js';
import { listSheets, listSheetsIn, fileInfo, listTabs, readTab } from './sheets.js';

// In the order a reason is trusted: an order that came back explains the open
// invoice whatever else is written about it, and a blogger's free product least.
export const KINDS = [
  { key: 'return',   label: 'Returned' },
  { key: 'cpr',      label: 'Paid in a CPR' },
  { key: 'advance',  label: 'Advance payment' },
  { key: 'issue',    label: 'Issue (damage / replace)' },
  { key: 'blogger',  label: 'Blogger order' }
];
// the three that are linked and read by a page of their own
const OWN = ['cpr', 'advance', 'return'];
const RANK = new Map(KINDS.map((k, i) => [k.key, i]));
const LABEL = new Map(KINDS.map(k => [k.key, k.label]));

// the sheet and QuickBooks are said to agree within this much, as everywhere else
const SAME = 10;

/* ==================== reading a sheet ==================== */

// One line of a sheet - [order, amount, note] - as the rows it stands for. `only`
// is the set of order numbers anyone is asking about; a live sheet is long and
// nearly all of it is nobody's business in this audit.
function rowsOf(cell, only) {
  const c = Array.isArray(cell) ? cell : [];
  const orders = splitInvoices(c[0]);
  if (!orders.length) return [];
  // a parcel carrying several orders has one amount for all of them, which
  // belongs to none of them in particular
  const amount = orders.length === 1 && String(c[1] ?? '').trim() !== '' ? num(c[1]) : null;
  const note = String(c[2] ?? '').trim().slice(0, 160);
  const out = [];
  orders.forEach(o => {
    const d = digitsOf(o);
    if (d && (!only || only.has(d))) out.push({ d, a: amount, n: note });
  });
  return out;
}

/* ==================== the invoices to audit ==================== */

// "91349172 1500" / "#91349172,1500" / "91349172<TAB>1,500" - one per line
export function parsePasted(text) {
  const out = [];
  String(text || '').split(/\r?\n/).forEach(line => {
    const t = line.trim();
    if (!t) return;
    const m = t.match(/^[#\s]*([0-9][0-9\-]*)\s*[\t ,;]*\s*([0-9][0-9,]*(?:\.[0-9]+)?)?/);
    if (!m) return;
    out.push({ doc: m[1], amount: m[2] ? num(m[2]) : null });
  });
  return out;
}

function shiftDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function readWindow(realmId, getToken, a, b, depth) {
  const out = [];
  let begin = 1, cap = false;
  while (true) {
    const q = await qbQuery(realmId, await getToken(false),
      'SELECT Id, DocNumber, TxnDate, TotalAmt, Balance, CustomerRef FROM Invoice ' +
      "WHERE Balance > '0' AND TxnDate >= '" + a + "' AND TxnDate <= '" + b + "' " +
      'STARTPOSITION ' + begin + ' MAXRESULTS 1000');
    const arr = q.Invoice || [];
    arr.forEach(inv => {
      const total = Number(inv.TotalAmt || 0);
      out.push({
        id: inv.Id, doc: inv.DocNumber || '', date: inv.TxnDate || '',
        customer: inv.CustomerRef ? (inv.CustomerRef.name || '') : '',
        total, amount: Number(inv.Balance === undefined ? total : inv.Balance)
      });
    });
    if (arr.length < 1000) break;
    begin += 1000;
    if (begin > 9000) { cap = true; break; }
  }
  if (cap && depth < 8 && a !== b) {
    const days = Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
    const mid = shiftDays(a, Math.floor(days / 2));
    return (await readWindow(realmId, getToken, a, mid, depth + 1))
      .concat(await readWindow(realmId, getToken, shiftDays(mid, 1), b, depth + 1));
  }
  return out;
}

/* ==================== looking them up ==================== */

function indexOf(sources) {
  const by = new Map();
  sources.forEach(s => s.rows.forEach(r => {
    if (!by.has(r.d)) by.set(r.d, []);
    by.get(r.d).push({ kind: s.kind, source: s.name, amount: r.a, note: r.n });
  }));
  return by;
}

export function audit(invoices, sources) {
  const by = indexOf(sources);
  const rows = invoices.map(inv => {
    const d = digitsOf(inv.doc);
    const hits = (by.get(d) || []).map(h => ({
      ...h,
      label: LABEL.get(h.kind),
      differs: inv.amount != null && h.amount != null && Math.abs(inv.amount - h.amount) > SAME
    }));
    hits.sort((x, y) => RANK.get(x.kind) - RANK.get(y.kind));
    return {
      doc: inv.doc, date: inv.date || '', customer: inv.customer || '',
      amount: inv.amount, hits,
      main: hits.length ? hits[0].kind : ''
    };
  });

  const byKind = {};
  KINDS.forEach(k => { byKind[k.key] = { count: 0, amount: 0 }; });
  const none = { count: 0, amount: 0 };
  rows.forEach(r => {
    const t = r.main ? byKind[r.main] : none;
    t.count++; t.amount += r.amount || 0;
  });
  return { rows, byKind, none, total: rows.length };
}

/* ==================== sheets that live in Google Drive ==================== */

// Each kind of sheet can be pointed at a Drive folder or one Google Sheet, the way
// Receive payments and Advance payments are: the link is saved once, which
// workbooks (and tabs) to read are ticked once, and which columns hold the order,
// the amount and the reason are said once. They are read live at every audit, so
// what somebody wrote in the sheet this morning is what is looked up.
const LINKS = 'audit:links';

export async function getLinks(realmId) {
  return (await getSetting(realmId, LINKS, {})) || {};
}

function idOf(link) {
  const m = String(link || '').trim().match(/[-\w]{25,}/);
  return m ? m[0] : '';
}

export async function saveLink(realmId, kind, link) {
  if (!RANK.has(kind)) throw new Error('Say which sheet this is');
  const root = idOf(link);
  if (!root) throw new Error('Paste the link to the folder or sheet');
  const all = await getLinks(realmId);
  // a new place has its own workbooks and columns
  all[kind] = { root, books: [], cols: null };
  await setSetting(realmId, LINKS, all);
  return all[kind];
}

export async function dropLink(realmId, kind) {
  const all = await getLinks(realmId);
  delete all[kind];
  await setSetting(realmId, LINKS, all);
}

// what is behind a link: every workbook under a folder, or the one sheet
export async function booksAt(root) {
  let books = [];
  try { books = await listSheets(root); } catch (e) { /* not a folder, then */ }
  if (!books.length) {
    const info = await fileInfo(root);
    if (info && info.mimeType !== 'application/vnd.google-apps.folder') {
      books = [{
        id: info.id, name: info.name, path: '',
        excel: info.mimeType !== 'application/vnd.google-apps.spreadsheet'
      }];
    }
  }
  return books.map(b => ({ id: b.id, name: b.name, path: b.path || '', excel: !!b.excel }));
}

export async function tabTitles(id, excel) {
  return (await listTabs(id, !!excel)).map(t => t.title);
}

export async function savePick(realmId, kind, body) {
  const all = await getLinks(realmId);
  if (!all[kind]) throw new Error('Save the link first');
  all[kind].books = (Array.isArray(body.books) ? body.books : [])
    .filter(b => b && b.id)
    .map(b => ({
      id: String(b.id), name: String(b.name || ''), excel: !!b.excel,
      tabs: Array.isArray(b.tabs) && b.tabs.length ? b.tabs.map(String) : null
    }));
  const c = body.cols || {};
  all[kind].cols = c.order ? {
    order: String(c.order), amount: String(c.amount || ''), note: String(c.note || '')
  } : null;
  await setSetting(realmId, LINKS, all);
  return all[kind];
}

const norm = v => String(v ?? '').replace(/[​-‍﻿ ]/g, '').trim().toLowerCase();

// The header of a tab is not always its first row - sheets keep a title or a
// total above it. The busiest of the first rows is taken to be it.
export async function headerOf(id, tab, excel) {
  const values = await readTab(id, tab, !!excel);
  let best = -1, most = 0;
  values.slice(0, 15).forEach((r, i) => {
    const n = (r || []).filter(c => String(c ?? '').trim() !== '').length;
    if (n > most) { most = n; best = i; }
  });
  if (best < 0) return { header: [], row: 0 };
  return { header: (values[best] || []).map(c => String(c ?? '').trim()), row: best };
}

function rowsFromTab(values, cols, only) {
  const want = norm(cols.order);
  let at = -1;
  for (let i = 0; i < Math.min(values.length, 15); i++) {
    if ((values[i] || []).some(c => norm(c) === want)) { at = i; break; }
  }
  if (at < 0) return null;                          // a tab laid out some other way
  const head = values[at].map(norm);
  const o = head.indexOf(want);
  const a = cols.amount ? head.indexOf(norm(cols.amount)) : -1;
  const n = cols.note ? head.indexOf(norm(cols.note)) : -1;
  const out = [];
  for (let i = at + 1; i < values.length; i++) {
    const r = values[i] || [];
    rowsOf([r[o], a >= 0 ? r[a] : '', n >= 0 ? r[n] : ''], only).forEach(x => out.push(x));
  }
  return out;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Google says no now and then, and allows only so many reads a minute
async function patiently(work, stopped) {
  const waits = [4000, 12000, 30000];
  for (let at = 0; ; at++) {
    try { return await work(); } catch (e) {
      if (at >= waits.length || stopped()) throw e;
      await sleep(waits[at]);
    }
  }
}

/* ==================== the three sheets that have a page of their own ==================== */

// CPR, advance and return sheets are already linked, and already understood, by
// Receive payments, Advance payments and Void invoices. The audit reads them the
// way those pages do - the same folder, the same way of finding the columns - so
// nothing is told twice. What the page sends is only what to search this time:
//
//   cpr      folders: [{ id, company, name }]   the month folders picked, as Find orders
//   advance  books:   [{ id, name, excel, tabs }]
//   return   { id, name, excel, tabs, from, to }

// One courier writes its sheets the same way for every account, so the first
// word of the folder name is enough to know which columns to use.
function cprCols(all, company) {
  if (all[company]) return all[company];
  const word = String(company || '').trim().split(/[\s\-]+/)[0].toLowerCase();
  return all[word] || null;
}

function cprRows(rows, only, company) {
  const out = [];
  rows.forEach(r => {
    (r.invoices || []).forEach(inv => {
      const d = digitsOf(inv);
      if (!d || (only && !only.has(d))) return;
      out.push({
        d,
        // a parcel carrying several orders has one amount for all of them
        a: (r.invoices || []).length === 1 ? (r.amount || null) : null,
        n: [company, r.status, r.cprNumber ? 'CPR ' + r.cprNumber : ''].filter(Boolean).join(' - ').slice(0, 160)
      });
    });
  });
  return out;
}

function advanceRows(rows, only) {
  const out = [];
  rows.forEach(r => {
    splitInvoices(r.invoice).forEach(inv => {
      const d = digitsOf(inv);
      if (!d || (only && !only.has(d))) return;
      out.push({
        d, a: r.amount || null,
        n: [r.date, r.name, r.note].filter(Boolean).join(' - ').slice(0, 160)
      });
    });
  });
  return out;
}

function returnRows(days, only, from, to) {
  const out = [];
  (days || []).forEach(day => {
    if (from && day.date && day.date < from) return;
    if (to && day.date && day.date > to) return;
    (day.numbers || []).forEach(n => {
      const d = digitsOf(n);
      if (d && (!only || only.has(d))) out.push({ d, a: null, n: 'Returned' + (day.date ? ' on ' + day.date : '') });
    });
  });
  return out;
}

/* ==================== the run ==================== */

// `input` is either { from, to } - read the open invoices from QuickBooks - or
// { invoices: [{ doc, amount }] }, which is already in hand. `kinds` is where to
// look: the sheets of those kinds, linked or attached, and no others.
export function auditRead(realmId, input) {
  const fromBooks = !!(input && input.from);
  const kinds = (Array.isArray(input && input.kinds) ? input.kinds : []).filter(k => RANK.has(k));
  let given = [];

  if (!kinds.length) throw new Error('Tick at least one place to look in');
  if (fromBooks) {
    if (!input.to) throw new Error('Choose both dates first');
    if (input.from > input.to) throw new Error('The first date is after the last one');
  } else {
    given = (Array.isArray(input && input.invoices) ? input.invoices : [])
      .map(x => ({ doc: String(x.doc || '').trim(), amount: x.amount == null || x.amount === '' ? null : num(x.amount) }))
      .filter(x => digitsOf(x.doc));
    if (!given.length) throw new Error('There are no invoice numbers to look up');
  }

  // one tab, read the way the sheet's own page reads it
  async function tabStep(run, it, where, read, rowsOf2) {
    await sleep(1100);
    let d;
    try {
      d = await patiently(read, () => run.stop);
    } catch (e) {
      return { msg: 'SKIPPED ' + where + '   ' + String(e.message).slice(0, 160) };
    }
    const rows = rowsOf2(d);
    if (rows.length) run.data.live.push({ kind: it.kind, name: where, rows });
    return { found: rows.length > 0, msg: where + '   ' + (rows.length ? 'found ' + rows.length : 'nothing here') };
  }

  // a CPR workbook: every tab of it, as Find orders reads one
  async function cprStep(run, it) {
    const where = it.company + ' / ' + it.month + ' / ' + it.file.name;
    let tabs;
    await sleep(1100);
    try {
      tabs = await patiently(() => listTabs(it.file.id, it.file.excel), () => run.stop);
    } catch (e) {
      return { msg: 'SKIPPED ' + where + '   ' + String(e.message).slice(0, 160) };
    }
    const cols = cprCols(run.data.findCols, it.company);
    let found = 0, trouble = 0;
    for (const t of tabs) {
      await sleep(1100);
      let d;
      try {
        d = await patiently(() => loadSheet(it.file.id, t.title, it.file.excel, cols), () => run.stop);
      } catch (e) { trouble++; continue; }
      const rows = cprRows(d.rows, run.data.only, it.company);
      if (rows.length) {
        run.data.live.push({ kind: 'cpr', name: where + ' / ' + t.title, rows });
        found += rows.length;
      }
    }
    return {
      found: found > 0,
      msg: where + '   ' + (found ? 'found ' + found : 'nothing here') +
        (trouble ? '   (' + trouble + ' tab' + (trouble === 1 ? '' : 's') + ' could not be read)' : '')
    };
  }

  return {
    label: fromBooks ? 'open invoices ' + input.from + ' to ' + input.to : given.length + ' invoices',
    steps: 0,

    async plan(run) {
      const links = await getLinks(realmId);
      const queue = [];

      if (fromBooks) {
        const windows = [];
        let at = input.from;
        while (at <= input.to && windows.length < 400) {
          let end = shiftDays(at, 6);
          if (end > input.to) end = input.to;
          windows.push([at, end]);
          at = shiftDays(end, 1);
        }
        windows.forEach(w => queue.push({ t: 'w', w }));
        run.data.getToken = tokenKeeper(() => getAccessToken(realmId));
      } else {
        queue.push({ t: 'g' });
      }

      const places = (input && input.places) || {};
      run.data.findCols = (await getSetting(realmId, 'find:cols', {})) || {};
      run.data.advCols = (await getSetting(realmId, 'adv:cols', null)) || null;

      if (kinds.includes('cpr') && places.cpr) {
        const seen = new Set();
        for (const f of (places.cpr.folders || [])) {
          if (!f || !f.id || seen.has(f.id)) continue;
          seen.add(f.id);
          const files = await patiently(() => listSheetsIn(String(f.id)), () => run.stop);
          files.forEach(file => queue.push({
            t: 'c', kind: 'cpr', company: String(f.company || ''), month: String(f.name || ''), file
          }));
        }
      }
      if (kinds.includes('advance') && places.advance) {
        for (const b of (places.advance.books || [])) {
          if (!b || !b.id) continue;
          const tabs = b.tabs && b.tabs.length ? b.tabs
            : await patiently(() => tabTitles(b.id, b.excel), () => run.stop);
          tabs.forEach(tab => queue.push({ t: 'a', kind: 'advance', book: b, tab }));
        }
      }
      if (kinds.includes('return') && places.return && places.return.id) {
        const r = places.return;
        const tabs = r.tabs && r.tabs.length ? r.tabs
          : await patiently(() => tabTitles(r.id, r.excel), () => run.stop);
        tabs.forEach(tab => queue.push({ t: 'r', kind: 'return', book: r, tab, from: r.from || '', to: r.to || '' }));
      }

      for (const kind of kinds) {
        if (OWN.includes(kind)) continue;
        const l = links[kind];
        if (!l) throw new Error('"' + LABEL.get(kind) + '" is not linked yet - the admin links it');
        const mine = places[kind] && places[kind].books;
        const chosen = mine && mine.length ? mine : (l.books || []);
        if (!chosen.length) throw new Error('Choose the workbooks to search for "' + LABEL.get(kind) + '"');
        if (!l.cols) throw new Error('The admin has not said which columns hold the order number for "' + LABEL.get(kind) + '"');
        for (const b of chosen) {
          const tabs = b.tabs && b.tabs.length ? b.tabs
            : await patiently(() => tabTitles(b.id, b.excel), () => run.stop);
          tabs.forEach(tab => queue.push({ t: 's', kind, book: b, tab, cols: l.cols }));
        }
      }
      if (!queue.some(q => q.t !== 'w' && q.t !== 'g')) {
        throw new Error('Nothing is chosen to search in the places you ticked');
      }

      run.data.queue = queue;
      run.data.live = [];
      run.data.got = [];
      run.data.only = null;
      run.steps = queue.length;
    },

    async step(run) {
      const it = run.data.queue[run.cursor];
      if (!it) { run.ended = true; return { done: true }; }

      if (it.t === 'g') {
        run.data.got = given;
        return { count: given.length, msg: given.length + ' invoices to look up' };
      }

      if (it.t === 'w') {
        const got = await readWindow(realmId, run.data.getToken, it.w[0], it.w[1], 0);
        run.data.got.push(...got);
        return {
          count: got.length, found: got.length > 0,
          msg: it.w[0] + ' to ' + it.w[1] + ': ' + got.length + ' open'
        };
      }

      // a tab of a sheet, now that the invoices it is read for are known
      if (!run.data.only) run.data.only = new Set(run.data.got.map(x => digitsOf(x.doc)));

      if (it.t === 'c') return cprStep(run, it);
      if (it.t === 'a') return tabStep(run, it, it.book.name + ' / ' + it.tab,
        () => loadAdvance(it.book.id, it.tab, it.book.excel, run.data.advCols),
        d => advanceRows(d.rows, run.data.only));
      if (it.t === 'r') return tabStep(run, it, it.book.name + ' / ' + it.tab,
        () => readDateColumns(it.book.id, it.tab, it.book.excel),
        d => returnRows(d.days, run.data.only, it.from, it.to));

      const where = it.book.name + ' / ' + it.tab;
      await sleep(1100);
      let values;
      try {
        values = await patiently(() => readTab(it.book.id, it.tab, it.book.excel), () => run.stop);
      } catch (e) {
        return { msg: 'SKIPPED ' + where + '   ' + String(e.message).slice(0, 160) };
      }
      const rows = rowsFromTab(values, it.cols, run.data.only);
      if (rows === null) {
        return { msg: 'SKIPPED ' + where + '   no "' + it.cols.order + '" column in it' };
      }
      if (rows.length) run.data.live.push({ kind: it.kind, name: where, rows });
      return { found: rows.length > 0, msg: where + '   ' + (rows.length ? 'found ' + rows.length : 'nothing here') };
    },

    async finish(run) {
      const res = audit(run.data.got, run.data.live);
      res.sources = kinds.map(k => LABEL.get(k));
      res.fromBooks = fromBooks;
      res.partial = run.cursor < (run.steps || 0);
      return res;
    },

    endLine(run) {
      return 'Looked ' + run.data.got.length + ' invoices up in ' + kinds.map(k => LABEL.get(k)).join(', ') + '.';
    }
  };
}
