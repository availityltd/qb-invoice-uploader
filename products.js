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

const API = 'https://quickbooks.api.intuit.com';

const round2 = n => Math.round(n * 100) / 100;

const num = v => {
  const f = parseFloat(String(v == null ? '' : v).replace(/[^0-9.\-]/g, ''));
  return isNaN(f) ? 0 : f;
};

// Two items are the same product to the person reading the report when the name
// is the same but for case, spacing and punctuation.
export const looseName = s =>
  String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, '');

// Which shade or number of a product an item is. A lipstick comes in forty
// colours, each its own SKU, and very often each with the same description - so
// two items that read alike are not twins unless they are the same shade. This
// takes the last piece of the name and of the SKU - after the last space, slash
// or dash - with the bracketed SKU off the name and leading zeros off a number:
// "Blush - 02" and "7004-109/B-20/2" both come to 2, "BB Cream Fair" and
// "7601-162/Fair" both to fair, and shade 3 never meets shade 4.
export function variantsOf(it) {
  const out = new Set();
  const take = v => {
    const s = String(v == null ? '' : v).replace(/\([^)]*\)?\s*$/, '').trim();
    if (!s) return;
    const last = s.split(/[\s\/\-]+/).filter(Boolean).pop();
    if (!last) return;
    let k = last.toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (/^\d+$/.test(k)) k = String(Number(k));
    if (k) out.add(k);
  };
  take(it.name);
  take(it.sku);
  return out;
}

// The same shade, or no way of telling. Where both say which shade they are and
// no shade is shared, they are two products that happen to be written alike.
export function sameVariant(a, b) {
  const va = variantsOf(a), vb = variantsOf(b);
  if (!va.size || !vb.size) return true;
  for (const v of va) if (vb.has(v)) return true;
  return false;
}

// The connector names its item after the SKU - 7301-490/k-15/l-653 - while the
// one made by hand is called "Miss Rose Dream Glide Lipstick 653". Those two are
// one product, and nothing in the name says so. What ties them together is the
// description, the SKU, and the SKU written inside the other one's name.
// The product's name with the parts that only say which one it is taken off: the
// SKU, wherever it sits in the name, and the shade at the end. "Missrose Silk
// Radiance Bb Cream 7601-162/Fair" and "Missrose Silk Radiance BB Cream Fair"
// both come down to "missrosesilkradiancebbcream" - which, with the shade agreeing,
// is how a connector's item and a hand-made one are seen to be one product even
// though neither name nor SKU reads the same.
export function baseName(it) {
  let base = looseName(it.name);
  if (!base) return '';
  const sku = looseName(it.sku);
  if (sku && sku.length > 3) base = base.split(sku).join('');
  variantsOf(it).forEach(v => {
    if (base.length - v.length >= 6 && base.endsWith(v)) base = base.slice(0, -v.length);
  });
  return base;
}

export function twinKeys(it) {
  const keys = [];
  const push = v => { const k = looseName(v); if (k && k.length > 2 && keys.indexOf(k) < 0) keys.push(k); };
  push(it.name);
  push(it.desc);
  push(it.sku);

  // the name without its SKU and shade, tied to the shade itself - two items
  // only meet on this key when both say the same shade, so shade 3 still never
  // meets shade 4
  const base = baseName(it);
  const shades = Array.from(variantsOf(it)).sort();
  if (base.length >= 6 && shades.length) {
    shades.forEach(v => keys.push('base:' + base + ':' + v));
  }
  return keys;
}

/* ==================== the items ==================== */

export async function readItems(realmId, token, onStep) {
  const items = [];
  let start = 1;

  while (true) {
    const q = await qbQuery(realmId, token,
      // QuickBooks hands back only the live ones unless both are asked for, and
      // an item already switched off is exactly what has to be seen here
      `SELECT * FROM Item WHERE Active IN (true, false) STARTPOSITION ${start} MAXRESULTS 1000`);
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
  // Bills and expenses bring stock in, and are what the cost is read from. Orders
  // and vendor credits do not, but they carry the item all the same - and a merge
  // that left them on the item being put away would not be a merge - so they are
  // read for the list of documents only.
  const KINDS = [
    { key: 'Bill',          label: 'Bill',           detail: 'ItemBasedExpenseLineDetail', stock: true },
    { key: 'Purchase',      label: 'Expense',        detail: 'ItemBasedExpenseLineDetail', stock: true },
    { key: 'PurchaseOrder', label: 'Purchase order', detail: 'ItemBasedExpenseLineDetail', stock: false },
    { key: 'VendorCredit',  label: 'Vendor credit',  detail: 'ItemBasedExpenseLineDetail', stock: false }
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
        const onThis = new Map();                  // item -> this document's lines of it
        (txn.Line || []).forEach(l => {
          const d = l[kind.detail];
          if (!d || !d.ItemRef) return;
          const id = String(d.ItemRef.value);
          const qty = Number(d.Qty || 0);
          const amount = Number(l.Amount || 0);
          const rate = Number(d.UnitPrice || (qty ? amount / qty : 0)) || 0;

          const was = by.get(id) ||
            { qty: 0, amount: 0, bills: 0, lastDate: '', lastRate: 0, docs: [], docCount: 0 };
          if (kind.stock) {
            was.qty = round2(was.qty + qty);
            was.amount = round2(was.amount + amount);
            was.bills++;
            const when = txn.TxnDate || '';
            if (when >= was.lastDate) { was.lastDate = when; was.lastRate = round2(rate); }
          }
          by.set(id, was);

          const doc = onThis.get(id) || { qty: 0, amount: 0 };
          doc.qty = round2(doc.qty + qty);
          doc.amount = round2(doc.amount + amount);
          onThis.set(id, doc);
        });

        // one entry per document per item, saying which it is and what is on it
        onThis.forEach((d, id) => {
          const was = by.get(id);
          was.docCount++;
          if (was.docs.length < 60) {
            was.docs.push({
              kind: kind.key, kindLabel: kind.label, id: String(txn.Id),
              doc: String(txn.DocNumber || ''), date: txn.TxnDate || '',
              qty: d.qty, rate: d.qty ? round2(d.amount / d.qty) : 0, amount: d.amount
            });
          }
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
    twinKeys(it).forEach(k => {
      if (!byLoose.has(k)) byLoose.set(k, []);
      byLoose.get(k).push(it);
    });
  });

  // the same item found under two of its own keys is still one item
  const twinsOf = it => {
    const seen = new Set([it.id]);
    const out = [];
    twinKeys(it).forEach(k => {
      (byLoose.get(k) || []).forEach(o => {
        if (seen.has(o.id)) return;
        seen.add(o.id);
        // a shared description is not enough - it has to be the same shade too
        if (!sameVariant(it, o)) return;
        out.push(o);
      });
    });
    return out;
  };

  const rows = items.map(it => {
    const s = sales.get(it.id)     || { qty: 0, amount: 0, cogs: 0 };
    const v = valuation.get(it.id) || null;
    const p = purchases.get(it.id) || { qty: 0, amount: 0, bills: 0, lastDate: '', lastRate: 0 };

    const inventory = it.type === 'Inventory';
    const qty = v ? v.qty : (it.qty === null ? 0 : it.qty);
    const sold = s.qty > 0 || s.amount !== 0;
    const bought = p.bills > 0;
    const twins = twinsOf(it);

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
      docs: p.docs || [], docCount: p.docCount || 0,
      // what the cost would be set to, in the order the evidence is worth
      // trusting: what it was last bought for, what QuickBooks averages it at,
      // what its twin was last bought for, what the item itself already says
      suggest: round2(p.lastRate || (v && v.avg) ||
               (twins.map(t => t.cost).filter(Boolean)[0]) || it.cost || 0),
      twinIds: twins.map(t => t.id),
      twins: [],
      flags
    };
  });

  // Which of a pair to keep is decided by what is hanging off it - the invoices
  // written against it above all - so each twin is listed with its own trade
  // rather than only its name. That cannot be done in the pass above, because a
  // twin's row does not exist yet while it is being written.
  const byId = new Map(rows.map(r => [r.id, r]));

  rows.forEach(r => {
    r.twins = r.twinIds.map(id => {
      const t = byId.get(id);
      if (!t) return null;
      return {
        id: t.id, name: t.name, sku: t.sku, active: t.active, type: t.type,
        qty: t.qty, cost: t.cost, avg: t.avg,
        soldQty: t.soldQty, soldAmount: t.soldAmount, cogs: t.cogs,
        bills: t.bills, boughtQty: t.boughtQty,
        docs: (t.docs || []).slice(0, 12), docCount: t.docCount || 0
      };
    }).filter(Boolean);

    // the one worth keeping, on the evidence: what has been sold against it
    // first, then what has been bought, then which one carries a cost. It is
    // only ever a suggestion - the page lets it be overruled.
    if (r.twins.length) {
      const all = [r].concat(r.twins);

      // A pair where neither one has a cost, a bill or a sale between them has
      // nothing to merge on: whichever is kept, the answer is still no cost.
      // Those are to be filled in first, so they are kept apart from the pairs
      // where one of the two is carrying something worth moving across.
      const carries = t => !!(t.cost || t.bills || t.docCount || t.soldQty || t.qty);
      r.flags.push(all.some(carries) ? 'twin-ready' : 'twin-bare');

      // the one kept holds the stock, so an inventory item always comes before
      // one that cannot - merging into a non-inventory item ends the cost of
      // sales for that product altogether
      const best = all.slice().sort((a, b) =>
        (b.type === 'Inventory' ? 1 : 0) - (a.type === 'Inventory' ? 1 : 0) ||
        (b.soldAmount || 0) - (a.soldAmount || 0) ||
        (b.bills || 0) - (a.bills || 0) ||
        (b.cost ? 1 : 0) - (a.cost ? 1 : 0) ||
        (b.qty || 0) - (a.qty || 0))[0];
      r.keepSuggest = best.id === r.id ? '' : best.id;
    }
  });

  return rows;
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
    // what those sales would have cost at the best cost known for them - which
    // for most of them is nothing, because a cost was never anywhere to be found
    zeroCogsCost: round2(zero.reduce((s, r) => s + r.soldQty * (r.suggest || 0), 0)),
    zeroCogsNoPrice: zero.filter(r => !r.suggest).length,
    noCost: has('no-cost').length,
    negative: neg.length,
    negativeQty: round2(neg.reduce((s, r) => s + r.qty, 0)),
    soldNotBought: has('sold-not-bought').length,
    boughtNotSold: has('bought-not-sold').length,
    notInventory: has('not-inventory').length,
    twins: has('twin').length,
    twinsReady: has('twin-ready').length,
    twinsBare: has('twin-bare').length,
    unused: has('unused').length
  };
}

/* ==================== changing one ==================== */

// The item is read again so the sync token is current, and only the field being
// changed is sent. A sparse update leaves everything else on the item exactly as
// QuickBooks has it - which matters on an inventory item, where the income and
// asset accounts must not be rewritten by accident.
export async function updateItem(realmId, token, id, patch) {
  const q = await qbQuery(realmId, token, `SELECT * FROM Item WHERE Id = '${String(id).replace(/'/g, "\'")}'`);
  const item = (q.Item || [])[0];
  if (!item) throw new Error('Item ' + id + ' is not in QuickBooks any more');

  const body = Object.assign({ Id: item.Id, SyncToken: item.SyncToken, sparse: true }, patch);

  const res = await fetch(`${API}/v3/company/${realmId}/item?minorversion=70`, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify(body)
  });

  const text = await res.text();
  let data = {};
  try { data = JSON.parse(text); } catch (e) { /* left as it came */ }

  if (!res.ok) {
    const f = data.Fault && data.Fault.Error && data.Fault.Error[0];
    throw new Error(f ? (f.Message + (f.Detail ? ' - ' + f.Detail : '')) : text.slice(0, 200));
  }

  return data.Item || {};
}

/* ==================== putting the stock right ==================== */

// Where the other side of the correction goes. Stock that was never there has to
// be written off somewhere, and that somewhere is a cost account - Inventory
// Shrinkage if the company has one, cost of sales otherwise.
export async function listAdjustAccounts(realmId, token) {
  const q = await qbQuery(realmId, token,
    `SELECT Id, Name, AccountType, AccountSubType FROM Account
      WHERE Active = true AND AccountType IN ('Cost of Goods Sold', 'Expense', 'Other Expense')
      MAXRESULTS 300`);

  return (q.Account || [])
    .map(a => ({
      id: String(a.Id), name: a.Name || '', type: a.AccountType || '',
      // the one QuickBooks itself reaches for when stock is written off
      shrinkage: /shrink/i.test(a.Name || '')
    }))
    .sort((a, b) => (b.shrinkage ? 1 : 0) - (a.shrinkage ? 1 : 0) || a.name.localeCompare(b.name));
}

// One item's stock put where it should be. QuickBooks takes the difference, not
// the new figure, so what is asked for here is the quantity it should read and
// the difference is worked out against what it reads now.
export async function adjustStock(realmId, token, opts) {
  const { accountId, date, memo, itemId, from, to } = opts;
  if (!accountId) throw new Error('Pick the account to write it off to');

  const diff = Math.round((Number(to) - Number(from)) * 10000) / 10000;
  if (!diff) throw new Error('That is already what it reads');

  const payload = {
    AdjustAccountRef: { value: String(accountId) },
    TxnDate: date || undefined,
    PrivateNote: memo || undefined,
    Line: [{
      DetailType: 'ItemAdjustmentLineDetail',
      ItemAdjustmentLineDetail: {
        ItemRef: { value: String(itemId) },
        QtyDiff: diff
      }
    }]
  };

  const res = await fetch(`${API}/v3/company/${realmId}/inventoryadjustment?minorversion=70`, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const text = await res.text();
  let data = {};
  try { data = JSON.parse(text); } catch (e) { /* left as it came */ }

  if (!res.ok) {
    const f = data.Fault && data.Fault.Error && data.Fault.Error[0];
    throw new Error(f ? (f.Message + (f.Detail ? ' - ' + f.Detail : '')) : text.slice(0, 300));
  }

  const made = data.InventoryAdjustment || {};
  return { id: String(made.Id || ''), doc: made.DocNumber || '', diff };
}
