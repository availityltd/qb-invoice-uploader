// The QuickBooks half of Merge payments.
//
// A group of orders left the warehouse as one parcel, so the courier charged
// its shipping once and collected one COD. QuickBooks, having been written one
// invoice per order, carries a shipping line on every one of them - which is
// exactly the difference between what the invoices add up to and what the
// sheet says was collected. This works out how many of those shipping lines
// have to go for the two to agree, and nothing here changes anything: the plan
// is read first and applied only when it is asked for.

import { qbQuery } from './qb.js';
import { clean, digitsOf } from './cpr.js';

const API = 'https://quickbooks.api.intuit.com';

// "Default Shipping Product", SKU Shipping, 199 a parcel - named plainly enough
// that the name is what finds it, in whichever of the three places it is written
export const looksLikeShipping = line => {
  const d = line.SalesItemLineDetail || {};
  const item = d.ItemRef ? String(d.ItemRef.name || '') : '';
  return /shipping|delivery|courier|freight/i.test(item + ' ' + (line.Description || ''));
};

/* ==================== reading ==================== */

// the invoices behind these order numbers, lines and all
export async function invoicesWithLines(realmId, token, numbers) {
  const found = new Map();                           // digits -> invoice
  const list = [...new Set(numbers.filter(Boolean))];
  const size = 25;                                   // whole invoices are heavy

  for (let i = 0; i < list.length; i += size) {
    const variants = [];
    list.slice(i, i + size).forEach(n => {
      const d = digitsOf(n);
      if (!d) return;
      variants.push(`'#${d}'`, `'${d}'`);
    });
    if (!variants.length) continue;

    const q = await qbQuery(realmId, token,
      `SELECT * FROM Invoice WHERE DocNumber IN (${variants.join(',')}) MAXRESULTS 1000`);

    (q.Invoice || []).forEach(inv => {
      const d = digitsOf(inv.DocNumber);
      if (!d) return;

      const total = Number(inv.TotalAmt || 0);
      const balance = Number(inv.Balance === undefined ? total : inv.Balance);
      const prev = found.get(d);
      // an unpaid one is the one worth working on
      if (prev && !(prev.balance <= 0.005 && balance > 0.005)) return;

      const lines = (inv.Line || [])
        .filter(l => l.DetailType === 'SalesItemLineDetail')
        .map(l => ({
          id: String(l.Id || ''),
          item: l.SalesItemLineDetail && l.SalesItemLineDetail.ItemRef
            ? String(l.SalesItemLineDetail.ItemRef.name || '')
            : '',
          description: clean(l.Description),
          amount: Number(l.Amount || 0),
          shipping: looksLikeShipping(l)
        }));

      found.set(d, {
        id: String(inv.Id),
        doc: clean(inv.DocNumber),
        date: inv.TxnDate || '',
        syncToken: String(inv.SyncToken || '0'),
        total,
        balance,
        customerId: inv.CustomerRef ? inv.CustomerRef.value : null,
        customerName: inv.CustomerRef ? (inv.CustomerRef.name || '') : '',
        paymentIds: (inv.LinkedTxn || [])
          .filter(t => t.TxnType === 'Payment').map(t => String(t.TxnId)),
        lines,
        shipping: lines.filter(l => l.shipping)
      });
    });
  }

  return found;
}

/* ==================== the plan ==================== */

const NEAR = 1;               // a rupee either way is rounding, not a difference

// How many shipping lines have to come off for the invoices to agree with the
// COD. The dearest go first, and every count is tried, so six invoices whose
// difference is five shipping charges is answered with five, not six.
export function planStrip(diff, shippingLines) {
  if (Math.abs(diff) <= NEAR) return { need: 0, strip: [] };
  if (diff < 0) return null;                          // the sheet collected more, not less

  const sorted = shippingLines.slice().sort((a, b) => b.amount - a.amount);
  let run = 0;
  for (let k = 1; k <= sorted.length; k++) {
    run += sorted[k - 1].amount;
    if (Math.abs(diff - run) <= NEAR) return { need: k, strip: sorted.slice(0, k) };
  }
  return null;
}

// one group against one sheet row
export function planGroup(entry, invoices) {
  const parts = entry.orders.map(o => ({
    order: o.order,
    placed: o.at || null,                 // when the shop took the order
    customer: o.customer || '',
    inv: invoices.get(o.digits) || null
  }));

  const missing = parts.filter(p => !p.inv).map(p => p.order);
  const here = parts.filter(p => p.inv);

  const qbTotal = round(here.reduce((s, p) => s + p.inv.total, 0));
  const owed = round(here.reduce((s, p) => s + p.inv.balance, 0));
  const paid = here.filter(p => p.inv.balance <= 0.005);
  const cod = round(entry.cod || 0);
  const diff = round(qbTotal - cod);

  const shipping = [];
  here.forEach(p => p.inv.shipping.forEach(l => shipping.push({
    invoiceId: p.inv.id, doc: p.inv.doc, order: p.order,
    lineId: l.id, item: l.item, amount: l.amount
  })));

  const plan = {
    id: entry.id,
    customer: entry.customer,
    phone: entry.phone,
    sheetRow: entry.sheetRow,
    cell: entry.cell,
    cprNumber: entry.cprNumber,
    whole: !!entry.whole,
    // what tied these orders together, so the grouping can be seen and not
    // just taken on trust
    agree: entry.agree || [],
    day: (entry.orders[0] || {}).date || null,
    orders: entry.orders.map(o => o.order),
    invoices: here.map(p => ({
      order: p.order, doc: p.inv.doc, qbId: p.inv.id,
      date: p.inv.date,
      placed: p.placed,
      customer: p.customer,
      total: p.inv.total, balance: p.inv.balance,
      shipping: p.inv.shipping.map(l => ({ lineId: l.id, item: l.item, amount: l.amount }))
    })),
    missing,
    qbTotal, owed, cod, diff,
    paidAlready: paid.length,
    shippingLines: shipping.length
  };

  if (missing.length) {
    plan.state = 'missing';
    plan.note = missing.length + ' of these orders are not in QuickBooks';
    return plan;
  }
  if (paid.length) {
    plan.state = 'paid';
    plan.note = paid.length + ' of these invoices are already paid';
    return plan;
  }

  const strip = planStrip(diff, shipping);
  if (!strip) {
    plan.state = 'stuck';
    plan.note = diff < 0
      ? 'The sheet collected ' + Math.abs(diff) + ' more than the invoices come to'
      : 'No number of shipping charges adds up to ' + diff;
    return plan;
  }

  plan.strip = strip.strip;
  plan.stripTotal = round(strip.strip.reduce((s, l) => s + l.amount, 0));
  if (!strip.need) {
    plan.state = 'agrees';
    plan.note = 'The invoices already come to what the sheet collected';
  } else {
    plan.state = 'fix';
    plan.note = 'Taking the shipping charge off ' + strip.need + ' of these ' +
      plan.invoices.length + ' invoices clears ' + diff;
  }
  return plan;
}

export function round(n) { return Math.round(Number(n || 0) * 100) / 100; }

/* ==================== the remark that goes in the sheet ==================== */

export function remarkFor(plan) {
  if (plan.state === 'agrees') {
    return plan.orders.length + ' orders in one parcel - the invoices agree with the COD';
  }
  if (plan.state === 'fix') {
    return plan.orders.length + ' orders in one parcel - shipping charged once, so the ' +
      'shipping was taken off ' + plan.strip.length + ' of the ' + plan.invoices.length +
      ' invoices (' + plan.stripTotal + ') to clear ' + plan.diff;
  }
  return plan.note || '';
}

/* ==================== changing an invoice ==================== */

// QuickBooks replaces the whole line list, so the invoice is read again, the
// shipping lines named in the plan are dropped, and what is left is sent back
// with the sync token it came with. Anything else on the invoice is untouched.
export async function stripShipping(realmId, token, invoiceId, lineIds) {
  const q = await qbQuery(realmId, token, `SELECT * FROM Invoice WHERE Id = '${invoiceId}'`);
  const inv = (q.Invoice || [])[0];
  if (!inv) throw new Error('Invoice ' + invoiceId + ' is not in QuickBooks any more');

  const wanted = new Set(lineIds.map(String));
  const keep = (inv.Line || []).filter(l =>
    l.DetailType !== 'SubTotalLineDetail' && !wanted.has(String(l.Id || '')));

  if (keep.length === (inv.Line || []).filter(l => l.DetailType !== 'SubTotalLineDetail').length) {
    throw new Error('The shipping line is not on ' + (inv.DocNumber || invoiceId) + ' any more');
  }
  if (!keep.length) throw new Error('That would leave ' + (inv.DocNumber || invoiceId) + ' empty');

  const payload = Object.assign({}, inv, { Line: keep, sparse: false });
  // the totals are what the lines add up to - sending the old ones back is how
  // an update comes out at the amount it started with, or is refused outright
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
    doc: clean(out.DocNumber),
    total: Number(out.TotalAmt || 0),
    balance: Number(out.Balance === undefined ? out.TotalAmt : out.Balance)
  };
}
