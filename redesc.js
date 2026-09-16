// Change the category on every line that carries the same description, and
// change nothing else.
//
// On the Profit and Loss the description is what tells one charge from another
// - "Paypal Fee", "Stripe Fee", "Revolut Fee" - while the category behind them
// is the same heading for all of them. When a heading needs splitting, or a
// description was booked under the wrong heading from the day it was set up,
// the work is the same edit on hundreds of lines: the description says which
// ones, and only the category moves.
//
// This reads a date range once, gathers every description it finds with what it
// is worth and what it is posted to now, and then puts a new AccountRef on the
// lines carrying the descriptions that were ticked. The date, the payee, the
// bank account, the amount, the VAT code and the description itself are handed
// back exactly as they came.

import { qbQuery } from './qb.js';
import { KINDS, kindOf, planAnyTxn, readWindow, shiftDays, monthEnd } from './recat.js';

const API = 'https://quickbooks.api.intuit.com';

const quote = s => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

// Two descriptions that differ only by case or by the spacing someone typed are
// the same description to the person reading the report.
export function descKey(s) {
  return String(s == null ? '' : s).trim().replace(/\s+/g, ' ').toLowerCase();
}

const round2 = n => Math.round(n * 100) / 100;

/* ==================== finding them ==================== */

// Three ways of saying "these ones". A charge is not always recognisable by
// what is written on the line - plenty are blank, or say the same thing on
// every row - but the payee is there, and so is the heading it sits under.
export const WAYS = [
  { key: 'description', label: 'Description', column: 'Description' },
  { key: 'name',        label: 'Name',        column: 'Name on the transaction' },
  { key: 'account',     label: 'Category',    column: 'Category it is under' }
];

export const wayOf = by => WAYS.filter(w => w.key === by)[0] || WAYS[0];

// What one line is called, whichever way the list is being read. A category is
// keyed by its id rather than its name, because two headings can be written the
// same way under different parents.
export function keyOf(by, row, line) {
  if (by === 'name')    return descKey(row.name);
  if (by === 'account') return line.accountId ? 'acct:' + String(line.accountId) : '';
  return descKey(line.description);
}

export function labelOf(by, row, line) {
  if (by === 'name')    return String(row.name || '').trim();
  if (by === 'account') return String(line.account || '').trim();
  return String(line.description || '').trim();
}

// A ticked heading can be narrowed to some of the categories it sits under -
// Amazon Sales, but only what is in Clearing Account. That comes as the key, this
// mark, and the account id.
export const SUB = '';

// The ticked keys sorted once into the headings taken whole and the headings
// taken only under certain categories.
export function wantOf(keys) {
  if (keys && keys.full) return keys;
  const full = new Set(), narrow = new Map();
  (keys || []).forEach(k => {
    k = String(k);
    const i = k.indexOf(SUB);
    if (i < 0) { full.add(k); return; }
    const head = k.slice(0, i);
    if (!narrow.has(head)) narrow.set(head, new Set());
    narrow.get(head).add(k.slice(i + 1));
  });
  return { full, narrow };
}

// Which lines of a row this run is about: the ones under a ticked heading, and
// - when the scan was narrowed to one category, or the heading was narrowed to
// some of its categories - only the ones sitting under those. Read by name, a
// payee ticked whole means every line of that transaction.
export function linesFor(row, keys, accountId, by) {
  const want = wantOf(keys instanceof Set ? Array.from(keys) : keys);
  return (row.lines || []).filter(l => {
    if (accountId && String(l.accountId) !== String(accountId)) return false;
    const k = keyOf(by || 'description', row, l);
    if (want.full.has(k)) return true;
    const only = want.narrow.get(k);
    return !!only && only.has(String(l.accountId));
  });
}

// A row is kept if it has an account-carrying line - with a description or
// without one, because a blank description is exactly the row that has to be
// found by its payee instead.
function keepable(row, accountId) {
  const lines = (row.lines || []).filter(l =>
    !accountId || String(l.accountId) === String(accountId));
  if (!lines.length) return null;
  return Object.assign({}, row, { lines, state: 'ready', note: '' });
}

// The same walk the category change uses: a month at a time, a week at a time
// when a month runs past the row cap. QuickBooks will not search inside a
// transaction's lines, so the range is read and the descriptions are gathered
// here.
export async function scanDescriptions(realmId, token, opts, onStep) {
  const { from, to, accountId } = opts;
  const kinds = (opts.kinds && opts.kinds.length)
    ? KINDS.filter(k => opts.kinds.includes(k.key))
    : KINDS;

  const rows = [];
  const seen = new Set();
  let read = 0;
  // A bill whose every line is on a product has no category written on it at
  // all - the heading comes from the item. It is read and rightly left out, and
  // counting it is what lets the page say why a year of bills came to nothing.
  let itemOnly = 0;

  for (const kind of kinds) {
    let cursor = from, windows = 0;

    while (cursor <= to && windows < 60) {
      let end = monthEnd(cursor);
      if (end > to) end = to;

      const keep = txn => {
        read++;
        const any = planAnyTxn(kind, txn);
        if (!any) {
          if ((txn.Line || []).some(l => l.ItemBasedExpenseLineDetail)) itemOnly++;
          return;
        }
        const row = keepable(any, accountId);
        if (!row) return;
        const k = kind.key + '|' + row.qbId;
        if (seen.has(k)) return;
        seen.add(k);
        rows.push(row);
      };

      const hitCap = await readWindow(realmId, token, kind, cursor, end, keep);

      if (hitCap) {
        let sub = cursor;
        while (sub <= end) {
          let subEnd = shiftDays(sub, 6);
          if (subEnd > end) subEnd = end;
          await readWindow(realmId, token, kind, sub, subEnd, keep);
          sub = shiftDays(subEnd, 1);
        }
      }

      if (onStep) onStep({ kind: kind.key, upto: end, found: rows.length, read, itemOnly });
      cursor = shiftDays(end, 1);
      windows++;
    }
  }

  rows.sort((a, b) => (a.date || '').localeCompare(b.date || '') ||
                      a.doc.localeCompare(b.doc));
  return { rows, read, itemOnly };
}

/* ==================== one line per heading ==================== */

// What the page shows: one row per description, per payee or per category -
// whichever way is being read - with how many transactions and lines carry it,
// what they add up to, and the categories they sit under now. This is the list
// the change is picked from.
export function groupRows(rows, by) {
  const way = wayOf(by).key;
  const map = new Map();

  (rows || []).forEach(row => {
    const here = new Set();

    (row.lines || []).forEach(l => {
      const key = keyOf(way, row, l);
      if (!key) return;

      let g = map.get(key);
      if (!g) {
        g = {
          key,
          description: labelOf(way, row, l),
          txns: 0, lines: 0, total: 0,
          first: row.date || '', last: row.date || '',
          accounts: [], changed: 0, failed: 0,
          _txns: new Set(), _acc: new Map()
        };
        map.set(key, g);
      }

      g.lines++;
      g.total = round2(g.total + Number(l.amount || 0));
      g._txns.add(row.kind + '|' + row.qbId);
      here.add(key);
      if (row.date) {
        if (!g.first || row.date < g.first) g.first = row.date;
        if (!g.last  || row.date > g.last)  g.last  = row.date;
      }

      const a = g._acc.get(String(l.accountId)) ||
                { id: String(l.accountId), name: l.account || '', lines: 0, total: 0, _txns: new Set() };
      a.lines++;
      a._txns.add(row.kind + '|' + row.qbId);
      a.total = round2(a.total + Number(l.amount || 0));
      g._acc.set(a.id, a);
    });

    // a transaction is counted once against every heading it carried
    if (row.state === 'changed' || row.state === 'failed') {
      here.forEach(key => {
        const g = map.get(key);
        if (!g) return;
        if (row.state === 'changed') g.changed++; else g.failed++;
      });
    }
  });

  return Array.from(map.values()).map(g => {
    g.txns = g._txns.size;
    g.accounts = Array.from(g._acc.values()).map(a => {
      a.txns = a._txns.size;
      delete a._txns;
      return a;
    }).sort((a, b) => b.lines - a.lines);
    delete g._txns; delete g._acc;
    return g;
  }).sort((a, b) => b.lines - a.lines || a.description.localeCompare(b.description));
}

/* ==================== changing one ==================== */

// The transaction is read again so the sync token is current, the new account
// goes on the lines that were picked, and the whole transaction goes back with
// every other field exactly as QuickBooks handed it over.
export async function redescOne(realmId, token, kindKey, txnId, lineIds, to) {
  const kind = kindOf(kindKey);
  if (!kind) throw new Error('Unknown transaction type ' + kindKey);

  const want = new Set((lineIds || []).map(String));
  if (!want.size) throw new Error('No lines were picked on ' + txnId);

  const q = await qbQuery(realmId, token,
    `SELECT * FROM ${kind.key} WHERE Id = '${quote(txnId)}'`);
  const txn = (q[kind.key] || [])[0];
  if (!txn) throw new Error(kind.label + ' ' + txnId + ' is not in QuickBooks any more');

  let changed = 0;
  const lines = (txn.Line || []).map(l => {
    const d = l[kind.detail];
    if (!d || !d.AccountRef || !want.has(String(l.Id || ''))) return l;
    // already where it is being sent - nothing to write on this line
    if (String(d.AccountRef.value) === String(to.id)) return l;

    changed++;
    const line = Object.assign({}, l);
    line[kind.detail] = Object.assign({}, d, {
      AccountRef: { value: String(to.id), name: to.name }
    });
    return line;
  });

  if (!changed) {
    throw new Error('Those lines are already under ' + to.name +
                    ' on ' + (txn.DocNumber || txnId));
  }

  const payload = Object.assign({}, txn, { Line: lines, sparse: false });
  // the lines add up to what they added up to before, so the totals are left
  // for QuickBooks to work out rather than sent back stale
  delete payload.TotalAmt;
  delete payload.HomeTotalAmt;
  delete payload.Balance;

  const r = await fetch(`${API}/v3/company/${realmId}/${kind.path}?minorversion=70`, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const text = await r.text();
  let data = {};
  try { data = JSON.parse(text); } catch (e) { /* left as it came */ }

  if (!r.ok) {
    const f = data.Fault && data.Fault.Error && data.Fault.Error[0];
    throw new Error(f ? (f.Message + (f.Detail ? ' - ' + f.Detail : '')) : text.slice(0, 200));
  }

  const out = data[kind.key] || {};
  return {
    id: String(out.Id || txnId),
    doc: String(out.DocNumber || txn.DocNumber || ''),
    kind: kind.key,
    lines: changed,
    total: Number(out.TotalAmt === undefined ? (txn.TotalAmt || 0) : out.TotalAmt),
    before: Number(txn.TotalAmt || 0)
  };
}
