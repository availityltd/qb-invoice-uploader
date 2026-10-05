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
import { digitsOf, splitInvoices, num } from './cpr.js';

// In the order a reason is trusted: an order that came back explains the open
// invoice whatever else is written about it, and a blogger's free product least.
export const KINDS = [
  { key: 'return',   label: 'Returned' },
  { key: 'cpr',      label: 'Paid in a CPR' },
  { key: 'advance',  label: 'Advance payment' },
  { key: 'issue',    label: 'Issue (damage / replace)' },
  { key: 'blogger',  label: 'Blogger order' }
];
const RANK = new Map(KINDS.map((k, i) => [k.key, i]));
const LABEL = new Map(KINDS.map(k => [k.key, k.label]));

// the sheet and QuickBooks are said to agree within this much, as everywhere else
const SAME = 10;

const KEY = 'audit:sources';
const MAX_ROWS = 60000;

/* ==================== the sources ==================== */

export async function listSources(realmId) {
  const all = (await getSetting(realmId, KEY, [])) || [];
  return all;
}

// what the page is shown: everything but the rows themselves
export function describe(src) {
  return {
    id: src.id, kind: src.kind, label: LABEL.get(src.kind) || src.kind,
    name: src.name, orders: src.rows.length, withAmount: src.rows.filter(r => r.a != null).length,
    total: Math.round(src.rows.reduce((t, r) => t + (r.a || 0), 0)),
    cols: src.cols || null, at: src.at
  };
}

// `rows` arrive as [order, amount, note] from either a CSV or a paste box
export async function addSource(realmId, body) {
  const kind = String(body.kind || '');
  if (!RANK.has(kind)) throw new Error('Say which sheet this is');
  const name = String(body.name || '').trim().slice(0, 120) || LABEL.get(kind);
  const raw = Array.isArray(body.rows) ? body.rows : [];

  const rows = [];
  raw.forEach(r => {
    const cell = Array.isArray(r) ? r : [];
    const orders = splitInvoices(cell[0]);
    if (!orders.length) return;
    // a parcel carrying several orders has one amount for all of them, which
    // belongs to none of them in particular
    const amount = orders.length === 1 && String(cell[1] ?? '').trim() !== '' ? num(cell[1]) : null;
    const note = String(cell[2] ?? '').trim().slice(0, 160);
    orders.forEach(o => {
      const d = digitsOf(o);
      if (d) rows.push({ d, a: amount, n: note });
    });
  });
  if (!rows.length) throw new Error('No order numbers were found in what was sent');

  const all = await listSources(realmId);
  const held = all.reduce((t, s) => t + s.rows.length, 0);
  if (held + rows.length > MAX_ROWS) {
    throw new Error('That is more than the ' + MAX_ROWS + ' rows kept at once - remove an older sheet first');
  }

  const src = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    kind, name, rows,
    cols: body.cols && typeof body.cols === 'object' ? {
      order: String(body.cols.order || ''), amount: String(body.cols.amount || ''),
      note: String(body.cols.note || '')
    } : null,
    at: new Date().toISOString()
  };
  all.push(src);
  await setSetting(realmId, KEY, all);
  return describe(src);
}

export async function removeSource(realmId, id) {
  const all = await listSources(realmId);
  const left = all.filter(s => s.id !== id);
  if (left.length === all.length) throw new Error('That sheet is not there any more');
  await setSetting(realmId, KEY, left);
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

// A week of open invoices at a time, so Stop takes effect within one and what
// was read until then is still audited.
function openInvoicesFrom(realmId, from, to, run) {
  const windows = [];
  let at = from;
  while (at <= to && windows.length < 400) {
    let end = shiftDays(at, 6);
    if (end > to) end = to;
    windows.push([at, end]);
    at = shiftDays(end, 1);
  }
  run.data.windows = windows;
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

/* ==================== the run ==================== */

// `input` is either { from, to } - read the open invoices from QuickBooks - or
// { invoices: [{ doc, amount }] }, which is already in hand.
export function auditRead(realmId, input) {
  const fromBooks = !!(input && input.from);
  let given = [];

  if (fromBooks) {
    if (!input.to) throw new Error('Choose both dates first');
    if (input.from > input.to) throw new Error('The first date is after the last one');
  } else {
    given = (Array.isArray(input && input.invoices) ? input.invoices : [])
      .map(x => ({ doc: String(x.doc || '').trim(), amount: x.amount == null || x.amount === '' ? null : num(x.amount) }))
      .filter(x => digitsOf(x.doc));
    if (!given.length) throw new Error('There are no invoice numbers to look up');
  }

  return {
    label: fromBooks ? 'open invoices ' + input.from + ' to ' + input.to : given.length + ' invoices',
    steps: 0,

    async plan(run) {
      run.data.sources = await listSources(realmId);
      if (!run.data.sources.length) throw new Error('Attach at least one sheet first');
      run.data.got = [];
      if (fromBooks) {
        openInvoicesFrom(realmId, input.from, input.to, run);
        run.steps = run.data.windows.length;
        run.data.getToken = tokenKeeper(() => getAccessToken(realmId));
      } else {
        run.steps = 1;
      }
    },

    async step(run) {
      if (!fromBooks) {
        // nothing to read; the look-up itself is the finish
        if (run.cursor >= 1) { run.ended = true; return { done: true }; }
        run.data.got = given;
        return { count: given.length, msg: given.length + ' invoices to look up' };
      }
      const w = run.data.windows[run.cursor];
      if (!w) { run.ended = true; return { done: true }; }
      const got = await readWindow(realmId, run.data.getToken, w[0], w[1], 0);
      run.data.got.push(...got);
      return {
        count: got.length, found: got.length > 0,
        msg: w[0] + ' to ' + w[1] + ': ' + got.length + ' open'
      };
    },

    async finish(run) {
      const res = audit(run.data.got, run.data.sources);
      res.sources = run.data.sources.map(describe);
      res.fromBooks = fromBooks;
      res.partial = run.cursor < (run.steps || 0);
      return res;
    },

    endLine(run) {
      return 'Looked ' + run.counted + ' invoices up in ' + (run.data.sources || []).length + ' sheet(s).';
    }
  };
}
