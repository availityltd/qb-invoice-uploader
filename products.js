// What the books say about the products themselves, rather than about one sale.
//
// A cost that was never put on an item does not stop anything: the item sells,
// the invoice is right, and the Profit and Loss quietly carries no cost against
// it. Months later the gross profit is wrong and nothing points at why. The same
// goes for stock gone negative, for one product living as two items because a
// connector made a second one, and for an item that sells although it was never
// bought.
//
// None of that is in a query. Qty and cost only come out of QuickBooks' own
// reports, so this reads four things - the items, what they sold, what the stock
// is worth, what was bought - and puts them side by side, one row per item.

import { qbQuery, qbReport } from './qb.js';

const round2 = n => Math.round(n * 100) / 100;

const num = v => {
  const f = parseFloat(String(v == null ? '' : v).replace(/[^0-9.\-]/g, ''));
  return isNaN(f) ? 0 : f;
};

// Two items are the same product to the person reading the report when the name
// is the same but for case, spacing and punctuation.
export const looseName = s =>
  String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, '');

/* ==================== the items ==================== */

export async function readItems(realmId, token, onStep) {
  const items = [];
  let start = 1;

  while (true) {
    const q = await qbQuery(realmId, token,
      `SELECT * FROM Item STARTPOSITION ${start} MAXRESULTS 1000`);
    const arr = q.Item || [];
    arr.forEach(it => {
      items.push({
        id: String(it.Id),
        name: it.FullyQualifiedName || it.Name || '',
        sku: it.Sku || '',
        type: it.Type || '',
        active: it.Active !== false,
        cost: it.PurchaseCost === undefined ? null : Number(it.PurchaseCost),
        price: it.UnitPrice === undefined ? null : Number(it.UnitPrice),
        qty: it.QtyOnHand === undefined ? null : Number(it.QtyOnHand),
        startDate: it.InvStartDate || '',
        desc: it.Description || ''
      });
    });
    if (onStep) onStep({ items: items.length });
    if (arr.length < 1000) break;
    start += 1000;
    if (start > 40000) break;
  }

  return items;
}

/* ==================== reading a report ==================== */

// A report comes back as sections holding rows holding sections. Only the rows
// that carry an item are wanted, and an item row is the one whose first cell has
// an id - that id is what everything else is joined on.
export function flattenReport(report) {
  const out = [];

  const walk = row => {
    if (!row) return;
    if (Array.isArray(row)) return row.forEach(walk);
    if (row.ColData) {
      const first = row.ColData[0] || {};
      if (first.id) out.push({ id: String(first.id), label: first.value || '', cells: row.ColData });
    }
    if (row.Rows) walk(row.Rows.Row);
    if (row.Header) walk(row.Header);
  };

  walk(((report || {}).Rows || {}).Row);
  return out;
}

// Which cell holds what. The report names its own columns, but those titles come
// back empty often enough that the shape of the row has to be trusted as well.
export function columnsOf(report, want) {
  const cols = (((report || {}).Columns || {}).Column || [])
    .map(c => String(c.ColTitle || c.ColType || '').toLowerCase());

  const find = names => {
    for (const n of names) {
      const i = cols.findIndex(c => c && c.indexOf(n) > -1);
      if (i > -1) return i;
    }
    return -1;
  };

  const at = {};
  Object.keys(want).forEach(k => { at[k] = find(want[k]); });
  return { cols, at };
}

// The sales report: what each item sold, what it brought in, and what it cost.
export async function readItemSales(realmId, token, from, to) {
  const report = await qbReport(realmId, token, 'ItemSales', {
    start_date: from, end_date: to, accounting_method: 'Accrual'
  });

  const { cols, at } = columnsOf(report, {
    qty:    ['qty', 'quantity'],
    amount: ['amount', 'sales'],
    cogs:   ['cogs', 'cost of goods']
  });

  const rows = flattenReport(report);
  const by = new Map();

  rows.forEach(r => {
    const c = r.cells;
    // where the titles were empty, the row itself says the shape: name, qty,
    // amount, % of sales, average price, cost of goods, gross profit, margin
    const iQty  = at.qty    > 0 ? at.qty    : (c.length >= 8 ? 1 : -1);
    const iAmt  = at.amount > 0 ? at.amount : (c.length >= 8 ? 2 : -1);
    const iCogs = at.cogs   > 0 ? at.cogs   : (c.length >= 8 ? 5 : -1);
    if (iQty < 0) return;

    const was = by.get(r.id) || { qty: 0, amount: 0, cogs: 0 };
    was.qty    = round2(was.qty    + num((c[iQty]  || {}).value));
    was.amount = round2(was.amount + num((c[iAmt]  || {}).value));
    was.cogs   = round2(was.cogs   + num((c[iCogs] || {}).value));
    by.set(r.id, was);
  });

  return { by, columns: cols, rows: rows.length };
}

// What the stock is worth now, and what QuickBooks worked the average cost out
// to be - which is the cost a sale actually carries.
export async function readValuation(realmId, token, asOf) {
  const report = await qbReport(realmId, token, 'InventoryValuationSummary',
    asOf ? { start_date: asOf, end_date: asOf } : {});

  const { cols, at } = columnsOf(report, {
    sku:   ['sku'],
    qty:   ['qty', 'quantity'],
    asset: ['asset'],
    avg:   ['avg', 'average']
  });

  const rows = flattenReport(report);
  const by = new Map();

  rows.forEach(r => {
    const c = r.cells;
    const iSku   = at.sku   > 0 ? at.sku   : (c.length >= 5 ? 1 : -1);
    const iQty   = at.qty   > 0 ? at.qty   : (c.length >= 5 ? 2 : -1);
    const iAsset = at.asset > 0 ? at.asset : (c.length >= 5 ? 3 : -1);
    const iAvg   = at.avg   > 0 ? at.avg   : (c.length >= 5 ? 4 : -1);
    if (iQty < 0) return;

    by.set(r.id, {
      sku:   iSku > 0 ? String((c[iSku] || {}).value || '') : '',
      qty:   num((c[iQty]   || {}).value),
      asset: num((c[iAsset] || {}).value),
      avg:   num((c[iAvg]   || {}).value)
    });
  });

  return { by, columns: cols, rows: rows.length };
}

/* ==================== what was bought ==================== */

// QuickBooks will not hand a purchases-by-item report to an app - it answers
// that one with a permission error - so the bills and the card purchases are
// read instead and their item lines counted. This is what says an item was
// bought at all, and what it was last bought for: the cost to put on the items
// that never had one.
export async function readPurchases(realmId, token, from, to, onStep) {
  const KINDS = [
    { key: 'Bill',     detail: 'ItemBasedExpenseLineDetail' },
    { key: 'Purchase', detail: 'ItemBasedExpenseLineDetail' }
  ];

  const by = new Map();
  let read = 0;

  for (const kind of KINDS) {
    let start = 1;

    while (true) {
      const where = (from && to)
        ? ` WHERE TxnDate >= '${from}' AND TxnDate <= '${to}'`
        : '';
      const q = await qbQuery(realmId, token,
        `SELECT * FROM ${kind.key}${where} ORDERBY TxnDate STARTPOSITION ${start} MAXRESULTS 500`);
      const arr = q[kind.key] || [];

      arr.forEach(txn => {
        read++;
        (txn.Line || []).forEach(l => {
          const d = l[kind.detail];
          if (!d || !d.ItemRef) return;
          const id = String(d.ItemRef.value);
          const qty = Number(d.Qty || 0);
          const amount = Number(l.Amount || 0);
          const rate = Number(d.UnitPrice || (qty ? amount / qty : 0)) || 0;

          const was = by.get(id) ||
            { qty: 0, amount: 0, bills: 0, lastDate: '', lastRate: 0 };
          was.qty = round2(was.qty + qty);
          was.amount = round2(was.amount + amount);
          was.bills++;
          const when = txn.TxnDate || '';
          if (when >= was.lastDate) { was.lastDate = when; was.lastRate = round2(rate); }
          by.set(id, was);
        });
      });

      if (onStep) onStep({ kind: kind.key, read, items: by.size });
      if (arr.length < 500) break;
      start += 500;
      if (start > 9000) break;
    }
  }

  return { by, read };
}

/* ==================== one row per item ==================== */

// Everything known about an item in one place, with the trouble it is in spelled
// out rather than left to be worked out from the numbers.
export function buildRows(items, sales, valuation, purchases) {
  const byLoose = new Map();
  items.forEach(it => {
    const k = looseName(it.name);
    if (!k) return;
    if (!byLoose.has(k)) byLoose.set(k, []);
    byLoose.get(k).push(it);
  });

  return items.map(it => {
    const s = sales.get(it.id)     || { qty: 0, amount: 0, cogs: 0 };
    const v = valuation.get(it.id) || null;
    const p = purchases.get(it.id) || { qty: 0, amount: 0, bills: 0, lastDate: '', lastRate: 0 };

    const inventory = it.type === 'Inventory';
    const qty = v ? v.qty : (it.qty === null ? 0 : it.qty);
    const sold = s.qty > 0 || s.amount !== 0;
    const bought = p.bills > 0;
    const twins = (byLoose.get(looseName(it.name)) || []).filter(o => o.id !== it.id);

    const flags = [];
    if (inventory && sold && s.cogs === 0) flags.push('zero-cogs');
    if (inventory && !it.cost && !(v && v.avg) && !bought) flags.push('no-cost');
    if (inventory && qty < 0) flags.push('negative');
    if (inventory && sold && !bought) flags.push('sold-not-bought');
    if (inventory && bought && !sold) flags.push('bought-not-sold');
    if (!inventory && sold) flags.push('not-inventory');
    if (twins.length) flags.push('twin');
    if (it.active && !sold && !bought && !qty) flags.push('unused');

    return {
      id: it.id, name: it.name, sku: it.sku, type: it.type, active: it.active,
      cost: it.cost, price: it.price,
      qty, asset: v ? v.asset : 0, avg: v ? v.avg : 0,
      soldQty: s.qty, soldAmount: s.amount, cogs: s.cogs,
      boughtQty: p.qty, boughtAmount: p.amount, bills: p.bills,
      lastBought: p.lastDate, lastRate: p.lastRate,
      // what the cost would be set to, in the order the evidence is worth
      // trusting: what it was last bought for, what QuickBooks averages it at,
      // what its twin was last bought for, what the item itself already says
      suggest: round2(p.lastRate || (v && v.avg) ||
               (twins.map(t => t.cost).filter(Boolean)[0]) || it.cost || 0),
      twins: twins.map(t => ({ id: t.id, name: t.name, sku: t.sku, qty: t.qty, cost: t.cost })),
      flags
    };
  });
}

// The headline: how many items are in each kind of trouble, and what the trouble
// is worth where that can be said.
export function summarise(rows) {
  const has = f => rows.filter(r => r.flags.includes(f));
  const zero = has('zero-cogs');
  const neg = has('negative');

  return {
    items: rows.length,
    active: rows.filter(r => r.active).length,
    inventory: rows.filter(r => r.type === 'Inventory').length,
    zeroCogs: zero.length,
    zeroCogsSales: round2(zero.reduce((s, r) => s + r.soldAmount, 0)),
    // what those sales would have cost at the best cost known for them
    zeroCogsCost: round2(zero.reduce((s, r) => s + r.soldQty * (r.suggest || 0), 0)),
    noCost: has('no-cost').length,
    negative: neg.length,
    negativeQty: round2(neg.reduce((s, r) => s + r.qty, 0)),
    soldNotBought: has('sold-not-bought').length,
    boughtNotSold: has('bought-not-sold').length,
    notInventory: has('not-inventory').length,
    twins: has('twin').length,
    unused: has('unused').length
  };
}
