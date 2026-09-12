// Take the shipping charge off invoices that are pasted in by hand.
//
// Merge payments works the shipping out for itself: a group of orders went as
// one parcel, the courier charged shipping once, and the difference between the
// invoices and the COD says how many shipping lines have to go. That is the
// right answer when there is a CPR to check against.
//
// Sometimes there is no CPR and no arithmetic to do - someone already knows
// which invoices were written with a shipping line that should not be there.
// This is that: paste the numbers, see the shipping line sitting on each one,
// and take it off. Nothing else on the invoice is touched, and nothing goes
// back to QuickBooks until the list has been seen and the button pressed.

import { parseNumbers, readInvoices } from './swapitem.js';
import { looksLikeShipping } from './mergeqb.js';

export { parseNumbers };

const round2 = n => Math.round(n * 100) / 100;

// One row per invoice found, saying which of its lines are the shipping and
// what they are worth. Nothing is changed here.
export function planInvoice(inv, pastedAs) {
  const lines = (inv.Line || [])
    .filter(l => l.DetailType === 'SalesItemLineDetail')
    .map(l => {
      const d = l.SalesItemLineDetail || {};
      return {
        id: String(l.Id || ''),
        item: d.ItemRef ? String(d.ItemRef.name || '') : '',
        description: l.Description || '',
        amount: Number(l.Amount || 0),
        shipping: looksLikeShipping(l)
      };
    });

  const hits = lines.filter(l => l.shipping);
  const total = Number(inv.TotalAmt || 0);
  const balance = Number(inv.Balance === undefined ? total : inv.Balance);
  const paid = balance <= 0.005 && total > 0;

  return {
    qbId: String(inv.Id),
    doc: String(inv.DocNumber || ''),
    pastedAs,
    date: inv.TxnDate || '',
    customer: inv.CustomerRef ? (inv.CustomerRef.name || '') : '',
    total,
    balance,
    paid,
    lineCount: lines.length,
    hits,
    hitTotal: round2(hits.reduce((s, l) => s + l.amount, 0)),
    // an invoice that is nothing but shipping cannot be stripped - that would
    // leave it empty, and QuickBooks refuses an invoice with no lines
    state: hits.length && hits.length < lines.length ? 'ready' : 'noship',
    note: !hits.length
      ? 'No shipping line on this invoice'
      : hits.length === lines.length
        ? 'The invoice is nothing but shipping - taking it off would leave it empty'
        : paid
          ? 'Already paid - taking the shipping off leaves the customer in credit'
          : hits.length + (hits.length === 1 ? ' shipping line' : ' shipping lines')
  };
}

// The whole pasted list against QuickBooks.
export async function buildPlan(realmId, token, numbers) {
  const found = await readInvoices(realmId, token, numbers);
  const rows = [];

  numbers.forEach(n => {
    const list = found.get(n.key) || [];
    if (!list.length) {
      rows.push({
        qbId: null, doc: n.raw, pastedAs: n.raw, state: 'missing',
        note: 'Not in QuickBooks', hits: [], hitTotal: 0,
        date: '', customer: '', total: 0, balance: 0, paid: false, lineCount: 0
      });
      return;
    }
    // the same number can sit on two invoices - a -D copy of a parcel settled
    // twice - so both are shown rather than one being picked for the user
    list.forEach(inv => rows.push(planInvoice(inv, n.raw)));
  });

  return rows;
}
