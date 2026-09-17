// Put one product in place of another, on every kind of transaction that carries
// a product, across a range of dates.
//
// One product living as two items is how a bill brings stock in on one while the
// invoices sell it out of the other: the bill's item fills up, the sold item goes
// below zero and sells at no cost. Merging the stock is one answer. The other is
// to put the transactions onto the same item - the bills onto the item the sales
// use, or the sales onto the item the bills use - so that QuickBooks works cost of
// sales out of the purchases that were really behind them.
//
// The swap page does this for invoices picked by number. This does it by product:
// a pasted column of pairs, old item beside new, read across bills, expenses,
// vendor credits, purchase orders, invoices, sales receipts and credit memos.
// Only the item on the line changes. Quantity, rate, amount and description go
// back exactly as they came.
//
// Journal entries and deposits carry no product - an account only - so they are
// not here; the category change covers those.

import { qbQueryStrict } from './qb.js';
import { looseName } from './products.js';

const API = 'https://quickbooks.api.intuit.com';
const quote = s => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const round2 = n => Math.round(n * 100) / 100;

// purchase-side lines keep the item under one detail, sales-side under another
export const KINDS = [
  { key: 'Bill',          path: 'bill',          label: 'Bill',           detail: 'ItemBasedExpenseLineDetail', side: 'buy' },
  { key: 'Purchase',      path: 'purchase',      label: 'Expense',        detail: 'ItemBasedExpenseLineDetail', side: 'buy' },
  { key: 'VendorCredit',  path: 'vendorcredit',  label: 'Vendor credit',  detail: 'ItemBasedExpenseLineDetail', side: 'buy' },
  { key: 'PurchaseOrder', path: 'purchaseorder', label: 'Purchase order', detail: 'ItemBasedExpenseLineDetail', side: 'buy' },
  { key: 'Invoice',       path: 'invoice',       label: 'Invoice',        detail: 'SalesItemLineDetail',        side: 'sell' },
  { key: 'SalesReceipt',  path: 'salesreceipt',  label: 'Sales receipt',  detail: 'SalesItemLineDetail',        side: 'sell' },
  { key: 'CreditMemo',    path: 'creditmemo',    label: 'Credit memo',    detail: 'SalesItemLineDetail',        side: 'sell' }
];

export const kindOf = k => KINDS.filter(x => x.key === k)[0] || null;

/* ==================== the pairs ==================== */

// A pasted block, one pair to a line: the item going, then the item taking its
// place. Excel copies two columns with a tab between them; an arrow or a pipe
// is taken as well for a pair typed by hand. A comma is not, because product
// names have commas in them.
export function parsePairs(text) {
  const out = [];
  String(text || '').split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    let parts = line.split('\t');
    if (parts.length < 2) parts = line.split(/\s*(?:->|→|=>|\|)\s*/);
    parts = parts.map(p => p.trim()).filter(Boolean);
    out.push({ line: i + 1, raw: line, from: parts[0] || '', to: parts[1] || '' });
  });
  return out;
}

// Each side of a pair found among the items, whole - on the name, the SKU, or
// the name with its bracketed SKU taken off - and never on part of a name,
// because a wrong match here rewrites a year of transactions onto the wrong
// product.
export function resolvePairs(pairs, items) {
  const index = new Map();
  const add = (k, it) => {
    if (!k) return;
    if (!index.has(k)) index.set(k, []);
    if (index.get(k).indexOf(it) < 0) index.get(k).push(it);
  };
  items.forEach(it => {
    add(looseName(it.name), it);
    add(looseName(it.sku), it);
    add(looseName(String(it.name || '').replace(/\([^)]*\)\s*$/, '')), it);
  });

  const find = text => {
    const hits = index.get(looseName(text)) || [];
    if (hits.length === 1) return { item: hits[0] };
    if (!hits.length) return { why: 'not an item in QuickBooks' };
    // two items answering to one name is exactly the trouble being fixed, so
    // the one meant is not guessed at
    return { why: 'matches ' + hits.length + ' items: ' + hits.map(h => h.name).join(' | ') };
  };

  const ok = [], bad = [];
  const seenFrom = new Set();

  pairs.forEach(p => {
    if (!p.from || !p.to) { bad.push(Object.assign({}, p, { why: 'needs the old item and the new one, side by side' })); return; }
    const f = find(p.from), t = find(p.to);
    if (!f.item) { bad.push(Object.assign({}, p, { why: 'old item ' + f.why })); return; }
    if (!t.item) { bad.push(Object.assign({}, p, { why: 'new item ' + t.why })); return; }
    if (f.item.id === t.item.id) { bad.push(Object.assign({}, p, { why: 'both sides are the same item' })); return; }
    if (seenFrom.has(f.item.id)) { bad.push(Object.assign({}, p, { why: 'this old item is already paired above' })); return; }
    // an item being replaced that is also a replacement - or the other way round -
    // would be moved twice in one run, depending on the order transactions are
    // read in. Checked against the pairs already kept, in the order pasted, so one
    // bad line does not take a good one down with it.
    if (ok.some(k => k.to.id === f.item.id)) {
      bad.push(Object.assign({}, p, { why: 'the old item is the new item of a pair above - do these in two runs' })); return;
    }
    if (ok.some(k => k.from.id === t.item.id)) {
      bad.push(Object.assign({}, p, { why: 'the new item is being replaced by a pair above - do these in two runs' })); return;
    }
    seenFrom.add(f.item.id);

    ok.push({
      line: p.line,
      from: { id: f.item.id, name: f.item.name, sku: f.item.sku, type: f.item.type, active: f.item.active },
      to:   { id: t.item.id, name: t.item.name, sku: t.item.sku, type: t.item.type, active: t.item.active }
    });
  });

  bad.sort((a, b) => a.line - b.line);
  return { ok, bad };
}

// One item, as the pages show it, read by its id.
export async function itemById(realmId, token, id) {
  const q = await qbQueryStrict(realmId, token, `SELECT * FROM Item WHERE Id = '${quote(id)}'`);
  const it = (q.Item || [])[0];
  if (!it) throw new Error('That product is not in QuickBooks any more');
  return {
    id: String(it.Id), name: it.FullyQualifiedName || it.Name || '', sku: it.Sku || '',
    type: it.Type || '', active: it.Active !== false,
    qty: it.QtyOnHand === undefined ? null : Number(it.QtyOnHand),
    cost: it.PurchaseCost === undefined ? null : Number(it.PurchaseCost)
  };
}

/* ==================== finding them ==================== */

function iso(d) { return d.toISOString().slice(0, 10); }
function addDays(s, n) { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return iso(d); }
function monthEnd(s) {
  const d = new Date(s + 'T00:00:00Z');
  return iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)));
}

// The item lines on a transaction that carry one of the old items.
function hitsOf(kind, txn, map) {
  return (txn.Line || [])
    .filter(l => l[kind.detail] && l[kind.detail].ItemRef && map.has(String(l[kind.detail].ItemRef.value)))
    .map(l => {
      const d = l[kind.detail];
      return {
        lineId: String(l.Id || ''),
        fromId: String(d.ItemRef.value),
        // the item taking its place can be chosen after the read, once it is
        // clear where the old one is
        toId: (map.get(String(d.ItemRef.value)) || {}).id || '',
        qty: Number(d.Qty || 0),
        amount: Number(l.Amount || 0)
      };
    });
}

function whoOf(kind, txn) {
  const ref = txn.VendorRef || txn.CustomerRef || txn.EntityRef;
  return ref ? (ref.name || '') : '';
}

// One window of one kind. QuickBooks stops handing rows over past 9,000 in a
// query, so a window that reaches it is said to have, and is read again in
// smaller pieces - which for a month of invoices here means a day at a time.
async function readSpan(realmId, token, kind, from, to, keep, onRead, shouldStop) {
  let start = 1;
  while (true) {
    // a month of invoices is dozens of reads, so stopping is looked at before
    // every one of them rather than only between months
    if (shouldStop && shouldStop()) throw new Error('stopped');
    const q = await qbQueryStrict(realmId, token,
      `SELECT * FROM ${kind.key} WHERE TxnDate >= '${quote(from)}' AND TxnDate <= '${quote(to)}' ` +
      `STARTPOSITION ${start} MAXRESULTS 1000`);
    const arr = q[kind.key] || [];
    arr.forEach(keep);
    if (onRead) onRead(arr.length);
    if (arr.length < 1000) return false;
    start += 1000;
    if (start > 9000) return true;
  }
}

export async function scanReplace(realmId, token, opts, onStep) {
  const { from, to, pairs } = opts;
  const kinds = KINDS.filter(k => (opts.kinds || []).includes(k.key));
  if (!kinds.length) throw new Error('Tick at least one kind of transaction');

  const map = new Map(pairs.map(p => [p.from.id, p.to]));
  const rows = [];
  const seen = new Set();
  let read = 0;

  // Where the item taking the place is already in use. Nothing is changed on
  // these; they are counted because "none found" on its own does not say
  // whether the old item was never there or the transactions were already on
  // the new one - and those call for different things.
  const onNew = new Map(pairs.filter(p => p.to).map(p => [p.to.id, { txns: 0, lines: 0, qty: 0, kinds: {} }]));
  const seenNew = new Set();

  const keepFor = kind => txn => {
    const k = kind.key + '|' + txn.Id;
    if (!seenNew.has(k)) {
      const touched = new Set();
      (txn.Line || []).forEach(l => {
        const d = l[kind.detail];
        const id = d && d.ItemRef ? String(d.ItemRef.value) : '';
        const g = id && onNew.get(id);
        if (!g) return;
        g.lines++;
        g.qty = round2(g.qty + Number(d.Qty || 0));
        if (!touched.has(id)) {
          touched.add(id);
          g.txns++;
          g.kinds[kind.label] = (g.kinds[kind.label] || 0) + 1;
        }
      });
      if (touched.size) seenNew.add(k);
    }

    if (seen.has(k)) return;
    const hits = hitsOf(kind, txn, map);
    if (!hits.length) return;
    seen.add(k);
    rows.push({
      kind: kind.key, kindLabel: kind.label, qbId: String(txn.Id),
      doc: String(txn.DocNumber || ''), date: txn.TxnDate || '', name: whoOf(kind, txn),
      total: Number(txn.TotalAmt || 0), hits,
      hitTotal: round2(hits.reduce((s, h) => s + h.amount, 0)),
      state: 'ready', note: ''
    });
  };
  const counted = n => { read += n; };

  for (const kind of kinds) {
    const keep = keepFor(kind);
    let cursor = from;

    while (cursor <= to) {
      if (opts.shouldStop && opts.shouldStop()) throw new Error('stopped');
      let end = monthEnd(cursor);
      if (end > to) end = to;

      // a month first; a week where the month is too full; a day where the week is
      const monthFull = await readSpan(realmId, token, kind, cursor, end, keep, counted, opts.shouldStop);
      if (monthFull) {
        let w = cursor;
        while (w <= end) {
          let wEnd = addDays(w, 6);
          if (wEnd > end) wEnd = end;
          const weekFull = await readSpan(realmId, token, kind, w, wEnd, keep, counted, opts.shouldStop);
          if (weekFull) {
            let d = w;
            while (d <= wEnd) {
              const dayFull = await readSpan(realmId, token, kind, d, d, keep, counted, opts.shouldStop);
              if (dayFull) {
                throw new Error('More than 9,000 ' + kind.label.toLowerCase() + 's on ' + d +
                                ' - QuickBooks will not hand over that many from one day');
              }
              d = addDays(d, 1);
            }
          }
          w = addDays(wEnd, 1);
          if (onStep) onStep({ kind: kind.key, upto: wEnd, found: rows.length, read });
        }
      }

      if (onStep) onStep({ kind: kind.key, upto: end, found: rows.length, read });
      cursor = addDays(end, 1);
    }
  }

  rows.sort((a, b) => (a.date || '').localeCompare(b.date || '') || a.doc.localeCompare(b.doc));
  return { rows, read, onNew: Object.fromEntries(onNew) };
}

/* ==================== changing one ==================== */

// The transaction is read again so the sync token is current, the new item goes
// on the lines carrying an old one, and the whole transaction goes back with
// every other field as QuickBooks handed it over a moment ago.
export async function replaceOne(realmId, token, kindKey, txnId, pairs) {
  const kind = kindOf(kindKey);
  if (!kind) throw new Error('Unknown transaction type ' + kindKey);
  if (pairs.some(p => !p.to)) throw new Error('Pick the product to put on it first');
  const map = new Map(pairs.map(p => [p.from.id, p.to]));

  const q = await qbQueryStrict(realmId, token,
    `SELECT * FROM ${kind.key} WHERE Id = '${quote(txnId)}'`);
  const txn = (q[kind.key] || [])[0];
  if (!txn) throw new Error(kind.label + ' ' + txnId + ' is not in QuickBooks any more');

  let changed = 0;
  const lines = (txn.Line || [])
    // a subtotal line is worked out by QuickBooks and refused if sent back
    .filter(l => l.DetailType !== 'SubTotalLineDetail')
    .map(l => {
      const d = l[kind.detail];
      if (!d || !d.ItemRef) return l;
      const to = map.get(String(d.ItemRef.value));
      if (!to) return l;

      changed++;
      const line = Object.assign({}, l);
      line[kind.detail] = Object.assign({}, d, { ItemRef: { value: String(to.id), name: to.name } });
      return line;
    });

  if (!changed) {
    throw new Error('None of those products is on ' + (txn.DocNumber || txnId) + ' any more');
  }

  const payload = Object.assign({}, txn, { Line: lines, sparse: false });
  // the lines add up to what they did before, so the totals are left for
  // QuickBooks to work out rather than sent back stale
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
    lines: changed,
    total: Number(out.TotalAmt === undefined ? (txn.TotalAmt || 0) : out.TotalAmt),
    before: Number(txn.TotalAmt || 0)
  };
}
