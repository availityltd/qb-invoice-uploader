// Change the product on an invoice, and change nothing else.
//
// QuickBooks, on screen, treats picking a different product as picking a fresh
// line: the quantity drops to one, the rate becomes the new product's own, the
// description is rewritten. That is right when a line is being written for the
// first time and wrong when a hundred invoices were simply written against the
// wrong product. So this reads each invoice, puts the new ItemRef on the lines
// that carry the old one, and sends every other field back exactly as it came -
// quantity, rate, amount, description, tax, service date, the lot.

import { qbQuery } from './qb.js';

const API = 'https://quickbooks.api.intuit.com';

// invoice numbers here are WH1132, SR1341, #91306999 - letters and all - so
// nothing is stripped out. Case and the stray spaces around a pasted column are
// all that is levelled.
export function normDoc(s) {
  return String(s == null ? '' : s).trim().replace(/\s+/g, ' ').toUpperCase();
}

// a pasted block: one number a line, or several to a line separated by commas
export function parseNumbers(text) {
  const seen = new Set();
  const out = [];
  String(text || '').split(/[\r\n,;\t]+/).forEach(part => {
    const raw = part.trim();
    if (!raw) return;
    const key = normDoc(raw);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ raw, key });
  });
  return out;
}

const quote = s => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

const lineItem = l => {
  const d = l.SalesItemLineDetail;
  return d && d.ItemRef ? d.ItemRef : null;
};

/* ==================== reading ==================== */

// The invoices behind the pasted numbers. A number is looked for as it was
// written and with a leading #, because #91306999 and 91306999 are two
// different invoices and we do not know which one was pasted.
export async function readInvoices(realmId, token, numbers, shouldStop) {
  const byKey = new Map();                       // pasted key -> [invoice, ...]
  const size = 20;                               // whole invoices are heavy

  for (let i = 0; i < numbers.length; i += size) {
    if (shouldStop && shouldStop()) throw new Error('Stopped - nothing was changed');
    const slice = numbers.slice(i, i + size);
    const wanted = new Set(slice.map(n => n.key));
    const variants = [];
    slice.forEach(n => {
      variants.push(`'${quote(n.raw)}'`);
      if (n.raw[0] !== '#') variants.push(`'#${quote(n.raw)}'`);
    });

    const q = await qbQuery(realmId, token,
      `SELECT * FROM Invoice WHERE DocNumber IN (${variants.join(',')}) MAXRESULTS 1000`);

    (q.Invoice || []).forEach(inv => {
      const doc = normDoc(inv.DocNumber);
      // it came back for whichever way it was pasted - with the # or without
      const key = wanted.has(doc) ? doc : normDoc(doc.replace(/^#/, ''));
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(inv);
    });
  }

  return byKey;
}

/* ==================== the plan ==================== */

// One row per invoice found, saying which of its lines carry the old product
// and what those lines are worth. Nothing is changed here.
export function planInvoice(inv, fromId, pastedAs) {
  const lines = (inv.Line || [])
    .filter(l => l.DetailType === 'SalesItemLineDetail')
    .map(l => {
      const ref = lineItem(l);
      const d = l.SalesItemLineDetail || {};
      return {
        id: String(l.Id || ''),
        itemId: ref ? String(ref.value) : '',
        item: ref ? String(ref.name || '') : '',
        description: l.Description || '',
        qty: d.Qty === undefined ? null : Number(d.Qty),
        rate: d.UnitPrice === undefined ? null : Number(d.UnitPrice),
        amount: Number(l.Amount || 0)
      };
    });

  const hits = lines.filter(l => l.itemId === String(fromId));

  return {
    qbId: String(inv.Id),
    doc: String(inv.DocNumber || ''),
    pastedAs,
    date: inv.TxnDate || '',
    customer: inv.CustomerRef ? (inv.CustomerRef.name || '') : '',
    total: Number(inv.TotalAmt || 0),
    balance: Number(inv.Balance === undefined ? inv.TotalAmt : inv.Balance),
    lineCount: lines.length,
    hits,
    hitTotal: Math.round(hits.reduce((s, l) => s + l.amount, 0) * 100) / 100,
    state: hits.length ? 'ready' : 'nomatch',
    note: hits.length
      ? hits.length + (hits.length === 1 ? ' line carries' : ' lines carry') + ' that product'
      : 'That product is not on this invoice'
  };
}

// the whole pasted list against QuickBooks
export async function buildPlan(realmId, token, numbers, fromId, shouldStop) {
  const found = await readInvoices(realmId, token, numbers, shouldStop);
  const rows = [];

  numbers.forEach(n => {
    const list = found.get(n.key) || [];
    if (!list.length) {
      rows.push({
        qbId: null, doc: n.raw, pastedAs: n.raw, state: 'missing',
        note: 'Not in QuickBooks', hits: [], hitTotal: 0,
        date: '', customer: '', total: 0, balance: 0, lineCount: 0
      });
      return;
    }
    // the same number can sit on two invoices - a -D copy of a parcel settled
    // twice - so both are shown rather than one being picked for the user
    list.forEach(inv => rows.push(planInvoice(inv, fromId, n.raw)));
  });

  return rows;
}

/* ==================== changing an invoice ==================== */

// The invoice is read again so the sync token is the current one, the old
// product is swapped for the new one on the lines that carry it, and the whole
// invoice goes back. Every other field on those lines is the field that came
// out of QuickBooks a moment ago, which is what keeps the quantity and the
// price where they were.
export async function swapOnInvoice(realmId, token, invoiceId, fromId, to, opts = {}) {
  const q = await qbQuery(realmId, token, `SELECT * FROM Invoice WHERE Id = '${quote(invoiceId)}'`);
  const inv = (q.Invoice || [])[0];
  if (!inv) throw new Error('Invoice ' + invoiceId + ' is not in QuickBooks any more');

  let changed = 0;
  const keep = (inv.Line || [])
    .filter(l => l.DetailType !== 'SubTotalLineDetail')
    .map(l => {
      const ref = lineItem(l);
      if (!ref || String(ref.value) !== String(fromId)) return l;

      changed++;
      const line = Object.assign({}, l);
      line.SalesItemLineDetail = Object.assign({}, l.SalesItemLineDetail, {
        ItemRef: { value: String(to.id), name: to.name }
      });
      // the description is the customer's wording as often as it is the
      // product's, so it stands unless the swap was asked to rewrite it
      if (opts.rewriteDescription) line.Description = to.name;
      return line;
    });

  if (!changed) {
    throw new Error('That product is no longer on ' + (inv.DocNumber || invoiceId));
  }

  const payload = Object.assign({}, inv, { Line: keep, sparse: false });
  // the lines add up to what they added up to before, so the totals are left
  // for QuickBooks to work out rather than sent back stale
  delete payload.TotalAmt;
  delete payload.HomeTotalAmt;
  delete payload.Balance;

  const r = await fetch(`${API}/v3/company/${realmId}/invoice?minorversion=70`, {
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

  const out = data.Invoice || {};
  return {
    id: String(out.Id || invoiceId),
    doc: String(out.DocNumber || inv.DocNumber || ''),
    lines: changed,
    total: Number(out.TotalAmt || 0),
    before: Number(inv.TotalAmt || 0)
  };
}
