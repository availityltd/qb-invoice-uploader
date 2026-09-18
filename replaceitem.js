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
import { looseName, variantsOf, baseName } from './products.js';

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

// A read of the books from April 2025 is over half a million invoices and well
// over an hour of asking QuickBooks. Three things end a read that long if nothing
// stands in their way, and each is met here:
//
//   - the access token lasts an hour. It is fetched again before it runs out, and
//     once more if QuickBooks says it has, and the read goes on.
//   - QuickBooks says no for a moment - too many requests, a gateway timing out,
//     a dropped connection. The same read is asked again after a pause, a few
//     times, before it counts as a failure.
//   - it fails anyway, or is stopped, or the server restarts. What was found is
//     kept, with how far each kind got, and the read carries on from there.
//
// It is also made shorter. A month that runs past QuickBooks' 9,000-row cap is
// read again in weeks, and a week in days - so once a kind has shown it needs
// days, the months after it go straight to days instead of reading 9,000 rows
// twice to find out again. Days are read four at a time; reading does not lock
// anything in QuickBooks, so they do not get in each other's way.

const pauseMs = ms => new Promise(r => setTimeout(r, ms));

// an access token that is fetched again before it runs out
export function tokenKeeper(fetchToken, first) {
  let token = first || null, at = first ? Date.now() : 0;
  return async (force) => {
    if (force || !token || Date.now() - at > 40 * 60 * 1000) {
      token = await fetchToken();
      at = Date.now();
    }
    return token;
  };
}

const AUTH = /\(401\)|authenticat|token.*(expired|invalid)|unauthori/i;
const PASSING = /\(429\)|\(5\d\d\)|throttl|too many|timeout|timed out|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket|fetch failed|network|stream|unavailable|answered without a result/i;

// one query, asked again where the failure was QuickBooks' moment and not the query
async function askPatiently(realmId, getToken, sql, shouldStop) {
  const waits = [2000, 5000, 10000, 20000, 40000];
  for (let attempt = 0; ; attempt++) {
    if (shouldStop && shouldStop()) throw new Error('stopped');
    try {
      return await qbQueryStrict(realmId, await getToken(false), sql);
    } catch (e) {
      if (attempt >= waits.length) throw e;
      if (AUTH.test(e.message)) { await getToken(true); continue; }
      if (PASSING.test(e.message)) { await pauseMs(waits[attempt]); continue; }
      throw e;
    }
  }
}

// One window of one kind, all of it. Says whether it reached the cap.
async function readSpan(realmId, getToken, kind, from, to, keep, onRead, shouldStop) {
  let start = 1;
  while (true) {
    const q = await askPatiently(realmId, getToken,
      `SELECT * FROM ${kind.key} WHERE TxnDate >= '${quote(from)}' AND TxnDate <= '${quote(to)}' ` +
      `STARTPOSITION ${start} MAXRESULTS 1000`, shouldStop);
    const arr = q[kind.key] || [];
    arr.forEach(keep);
    if (onRead) onRead(arr.length);
    if (arr.length < 1000) return false;
    start += 1000;
    if (start > 9000) return true;
  }
}

// `state` holds everything found so far and how far each kind has got. Passed in
// again, the read carries on from there instead of starting over.
export function newScanState(pairs) {
  return {
    rows: [], seen: new Set(), seenNew: new Set(), read: 0,
    onNew: new Map(pairs.filter(p => p.to).map(p => [p.to.id, { txns: 0, lines: 0, qty: 0, kinds: {} }])),
    doneKinds: [], upto: {}, mode: {}
  };
}

export async function scanReplace(realmId, getToken, opts, onStep) {
  const { from, to, pairs } = opts;
  const kinds = KINDS.filter(k => (opts.kinds || []).includes(k.key));
  if (!kinds.length) throw new Error('Tick at least one kind of transaction');

  const map = new Map(pairs.map(p => [p.from.id, p.to]));
  const st = opts.state || newScanState(pairs);
  const stop = opts.shouldStop;

  const keepFor = kind => txn => {
    const k = kind.key + '|' + txn.Id;
    // Where the item taking the place is already in use. Nothing is changed on
    // these; they are counted because "none found" on its own does not say
    // whether the old item was never there or the transactions were already on
    // the new one - and those call for different things.
    if (!st.seenNew.has(k)) {
      const touched = new Set();
      (txn.Line || []).forEach(l => {
        const d = l[kind.detail];
        const id = d && d.ItemRef ? String(d.ItemRef.value) : '';
        const g = id && st.onNew.get(id);
        if (!g) return;
        g.lines++;
        g.qty = round2(g.qty + Number(d.Qty || 0));
        if (!touched.has(id)) {
          touched.add(id);
          g.txns++;
          g.kinds[kind.label] = (g.kinds[kind.label] || 0) + 1;
        }
      });
      if (touched.size) st.seenNew.add(k);
    }

    if (st.seen.has(k)) return;
    const hits = hitsOf(kind, txn, map);
    if (!hits.length) return;
    st.seen.add(k);
    st.rows.push({
      kind: kind.key, kindLabel: kind.label, qbId: String(txn.Id),
      doc: String(txn.DocNumber || ''), date: txn.TxnDate || '', name: whoOf(kind, txn),
      total: Number(txn.TotalAmt || 0), hits,
      hitTotal: round2(hits.reduce((s, h) => s + h.amount, 0)),
      state: 'ready', note: ''
    });
  };
  const counted = n => { st.read += n; };
  const step = (kind, upto) => {
    st.upto[kind.key] = upto;
    if (onStep) onStep({ kind: kind.key, upto, found: st.rows.length, read: st.read });
  };

  for (const kind of kinds) {
    if (st.doneKinds.includes(kind.key)) continue;
    const keep = keepFor(kind);
    // carry on the day after the last window this kind finished
    let cursor = st.upto[kind.key] ? addDays(st.upto[kind.key], 1) : from;
    let mode = st.mode[kind.key] || 'month';

    while (cursor <= to) {
      if (stop && stop()) throw new Error('stopped');
      let end = monthEnd(cursor);
      if (end > to) end = to;

      if (mode === 'month') {
        const full = await readSpan(realmId, getToken, kind, cursor, end, keep, counted, stop);
        if (!full) { step(kind, end); cursor = addDays(end, 1); continue; }
        mode = st.mode[kind.key] = 'week';
      }

      if (mode === 'week') {
        let w = cursor, fell = false;
        while (w <= end) {
          let wEnd = addDays(w, 6);
          if (wEnd > end) wEnd = end;
          const full = await readSpan(realmId, getToken, kind, w, wEnd, keep, counted, stop);
          if (full) {
            // this week needs days, and so will the rest of this kind
            mode = st.mode[kind.key] = 'day';
            cursor = w;
            fell = true;
            break;
          }
          step(kind, wEnd);
          w = addDays(wEnd, 1);
        }
        if (!fell) { cursor = addDays(end, 1); continue; }
      }

      // day by day, four at a time, up to the end of this month
      let d = cursor;
      while (d <= end) {
        const batch = [];
        for (let i = 0; i < 4 && d <= end; i++) { batch.push(d); d = addDays(d, 1); }
        const capped = await Promise.all(batch.map(day =>
          readSpan(realmId, getToken, kind, day, day, keep, counted, stop)));
        const over = batch.filter((day, i) => capped[i]);
        if (over.length) {
          throw new Error('More than 9,000 ' + kind.label.toLowerCase() + 's on ' + over[0] +
                          ' - QuickBooks will not hand over that many from one day');
        }
        step(kind, batch[batch.length - 1]);
      }
      cursor = addDays(end, 1);
    }

    st.doneKinds.push(kind.key);
  }

  const rows = st.rows.slice().sort((a, b) =>
    (a.date || '').localeCompare(b.date || '') || a.doc.localeCompare(b.doc));
  return { rows, read: st.read, onNew: Object.fromEntries(st.onNew) };
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

  const t0 = Date.now();
  const q = await qbQueryStrict(realmId, token,
    `SELECT * FROM ${kind.key} WHERE Id = '${quote(txnId)}'`);
  const readMs = Date.now() - t0;
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

  const t1 = Date.now();
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
  // the write is where QuickBooks works the stock cost of the product out again
  // for everything after this date, and so where the time goes - measured on its
  // own, so a slow run can be seen for what it is
  const writeMs = Date.now() - t1;
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
    readMs, writeMs,
    lines: changed,
    total: Number(out.TotalAmt === undefined ? (txn.TotalAmt || 0) : out.TotalAmt),
    before: Number(txn.TotalAmt || 0)
  };
}

/* ==================== pairs from a Shopify export ==================== */

// Shopify's product export, one row per variant, read into what matters here:
// the SKU of every variant that is live in the store, what it costs, and what it
// is called. The header names are Shopify's own; a row with no SKU is a product
// line without a variant and is left out.
export function shopifyVariants(rows) {
  if (!rows.length) throw new Error('The file is empty');
  const head = Object.keys(rows[0]).reduce((m, k) => { m[k.trim().toLowerCase()] = k; return m; }, {});
  const col = (...names) => { for (const n of names) if (head[n]) return head[n]; return null; };

  const cSku = col('variant sku', 'sku');
  if (!cSku) throw new Error('No "Variant SKU" column - export it from Shopify: Products, Export, CSV');
  const cStatus = col('status');
  const cTitle = col('title');
  const cHandle = col('handle');
  const cOpt = col('option1 value');
  const cCost = col('cost per item', 'variant cost');

  // the title is on the first row of a product only; its variants below leave it
  // blank, so it is carried down by handle
  const titleOf = {};
  const statusOf = {};
  const out = new Map();
  let skipped = 0;

  rows.forEach(r => {
    const handle = cHandle ? String(r[cHandle] || '').trim() : '';
    if (cTitle && r[cTitle]) titleOf[handle] = String(r[cTitle]).trim();
    if (cStatus && r[cStatus]) statusOf[handle] = String(r[cStatus]).trim().toLowerCase();

    const sku = String(r[cSku] || '').trim();
    if (!sku) return;
    const status = statusOf[handle] || '';
    // only what is live in the store is kept
    if (cStatus && status && status !== 'active') { skipped++; return; }
    if (out.has(sku.toLowerCase())) return;

    const cost = cCost ? Number(String(r[cCost] || '').replace(/[^0-9.\-]/g, '')) : 0;
    out.set(sku.toLowerCase(), {
      sku,
      title: (titleOf[handle] || handle) + (cOpt && r[cOpt] && r[cOpt] !== 'Default Title' ? ' - ' + r[cOpt] : ''),
      cost: isFinite(cost) && cost > 0 ? cost : null
    });
  });

  return { variants: Array.from(out.values()), skipped };
}

// For every variant live in Shopify: the item in QuickBooks that carries its SKU
// is the one kept, and every twin of it - the same product, the same shade, found
// by name, description or SKU - becomes a pair that moves onto it. Nothing is
// guessed: a SKU that matches no item, or more than one, is set aside to be
// looked at, and an item that is itself live in Shopify is never merged away.
// Why two items were taken for the same product, in words, with how far it is
// worth trusting. A pair is only ever made where one of the three things an item
// is known by - its name, its description, its SKU - reads exactly the same on
// both once case, spaces and punctuation are set aside. Which of them matched,
// and what the shade came to on each side, is the difference between a match
// worth running and one worth looking at first.
export function matchWhy(keep, dup) {
  const fields = it => [['name', it.name], ['SKU', it.sku], ['description', it.desc]];
  const found = [];

  fields(keep).forEach(([ka, va]) => fields(dup).forEach(([kb, vb]) => {
    const a = looseName(va), b = looseName(vb);
    if (!a || a.length <= 2 || a !== b) return;
    found.push({ on: ka === kb ? ('the same ' + ka) : (keep === dup ? ka : ka + ' = ' + kb), text: String(va).trim(), ka, kb });
  }));

  const vk = Array.from(variantsOf(keep)), vd = Array.from(variantsOf(dup));
  const shared = vk.filter(v => vd.indexOf(v) > -1);
  const shade = shared.length ? 'same shade (' + shared.join(', ') + ')'
              : (!vk.length || !vd.length) ? 'shade not shown on one of them'
              : 'different shades';

  // a SKU or a name that reads the same is the product itself; a description
  // alone is often the same line for forty shades of the same lipstick
  const best = found.filter(f => f.ka !== 'description' && f.kb !== 'description')[0] || found[0] || null;
  const onNameOrSku = !!(best && best.ka !== 'description' && best.kb !== 'description');
  // one item's full name written word for word as the other's description is a
  // copy made from it, not a line two products happen to share - so with the
  // shade agreeing it is as clear as a matching name. Only description against
  // description is the loose one, because forty shades often carry the same line.
  const nameAgainstDesc = !!(best && !onNameOrSku && (best.ka === 'name' || best.kb === 'name'));
  let on = best ? best.on : '';
  let text = best ? best.text : '';
  let strength = !best ? 'none'
               : ((onNameOrSku || nameAgainstDesc) && shared.length) ? 'strong'
               : (onNameOrSku || nameAgainstDesc) ? 'fair'
               : shared.length ? 'fair'
               : 'weak';

  // nothing read the same outright, but the names agree once the SKU and the
  // shade are taken off them - "…BB Cream Fair" beside "…Bb Cream 7601-162/Fair"
  const bk = baseName(keep), bd = baseName(dup);
  if (bk && bk === bd && bk.length >= 6 && shared.length) {
    const sk = looseName(keep.sku), sd = looseName(dup.sku);
    // one SKU inside the other, or only one of them has a SKU at all, says they
    // are the same line of stock; two unrelated SKUs is worth a second look
    const related = !sk || !sd || sk.indexOf(sd) > -1 || sd.indexOf(sk) > -1;
    // said as what it is: the product is the same and the shade is the same. The
    // SKU and the shade come off the name only so the rest of it can be compared -
    // the shade itself is checked first, and two shades that differ never meet
    const near = { on: 'same product name (its SKU set aside) and the same shade',
                   text: String(keep.name || '').trim(), strength: related ? 'strong' : 'fair' };
    if (!best || strength === 'weak' || (!onNameOrSku && near.strength === 'strong')) {
      on = near.on; text = near.text; strength = near.strength;
    }
    found.push({ on: near.on });
  }

  return {
    on, text,
    all: found.map(f => f.on),
    keepShades: vk, dupShades: vd, shade, strength
  };
}

export function pairsFromShopify(variants, items, helpers) {
  const { twinKeys, sameVariant } = helpers;
  const norm = s => looseName(s);

  const bySku = new Map();
  items.forEach(it => {
    const k = norm(it.sku);
    if (!k) return;
    if (!bySku.has(k)) bySku.set(k, []);
    bySku.get(k).push(it);
  });

  const byKey = new Map();
  items.forEach(it => twinKeys(it).forEach(k => {
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(it);
  }));

  const liveSkus = new Set(variants.map(v => norm(v.sku)));
  const keepers = new Map();                     // item id -> variant
  const pairs = [], bad = [];
  let line = 0;

  variants.forEach(v => {
    line++;
    let hits = (bySku.get(norm(v.sku)) || []);
    // several items with this SKU: the active inventory one is the keeper if
    // there is exactly one
    if (hits.length > 1) {
      const live = hits.filter(h => h.active && h.type === 'Inventory');
      if (live.length === 1) hits = live;
    }
    if (!hits.length) {
      bad.push({ line, raw: v.sku + ' - ' + v.title, why: 'no item in QuickBooks carries this SKU' });
      return;
    }
    if (hits.length > 1) {
      bad.push({ line, raw: v.sku + ' - ' + v.title,
        why: hits.length + ' items carry this SKU: ' + hits.map(h => h.name).join(' | ') + ' - replace these by hand' });
      return;
    }
    keepers.set(hits[0].id, v);
  });

  const taken = new Map();                       // duplicate id -> keeper it went to
  keepers.forEach((v, keepId) => {
    const keep = items.find(i => i.id === keepId);
    const seen = new Set([keep.id]);
    twinKeys(keep).forEach(k => (byKey.get(k) || []).forEach(o => {
      if (seen.has(o.id)) return;
      seen.add(o.id);
      if (!sameVariant(keep, o)) return;
      // an item live in Shopify under its own SKU is a product, not a duplicate
      if (keepers.has(o.id) || liveSkus.has(norm(o.sku))) return;
      if (taken.get(o.id) === 'both') return;
      if (taken.has(o.id)) {
        const other = items.find(i => i.id === taken.get(o.id));
        bad.push({ line: 0, raw: o.name,
          why: 'looks like a duplicate of both ' + other.name + ' and ' + keep.name + ' - left alone' });
        // take it back out of the first pair too
        const i = pairs.findIndex(p => p.from.id === o.id);
        if (i > -1) pairs.splice(i, 1);
        taken.set(o.id, 'both');
        return;
      }
      taken.set(o.id, keep.id);
      pairs.push({
        line: pairs.length + 1,
        from: { id: o.id, name: o.name, sku: o.sku, type: o.type, active: o.active },
        to: { id: keep.id, name: keep.name, sku: keep.sku, type: keep.type, active: keep.active,
              shopCost: v.cost, shopSku: v.sku, shopTitle: v.title },
        why: matchWhy(keep, o)
      });
    }));
  });

  // stock never goes onto an item that does not hold it
  const safe = pairs.filter(p => {
    if (p.from.type === 'Inventory' && p.to.type !== 'Inventory') {
      bad.push({ line: 0, raw: p.from.name + ' → ' + p.to.name,
        why: 'the item kept does not hold stock and the duplicate does - left alone' });
      return false;
    }
    return true;
  });

  return { pairs: safe, bad, keepers: keepers.size };
}
