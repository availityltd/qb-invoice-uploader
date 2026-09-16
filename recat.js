// Move a transaction from one expense category to another, and change nothing
// else.
//
// A Profit and Loss line is only ever the sum of the account each transaction
// line was posted to. When the grocery run was booked to Travel, nothing about
// the payment itself is wrong - the date, the payee, the bank account, the
// amount, the VAT and the attachment are all right. One field is wrong.
//
// QuickBooks on screen makes you open the transaction, retype the category and
// save it, one at a time. This reads each transaction, puts the new AccountRef
// on the lines that carry the old one, and hands every other field back exactly
// as it came - payee, payment account, date, memo, amount, VAT code, class,
// customer, billable state, attachments, the lot.

import { qbQuery, qbQueryStrict } from './qb.js';

const API = 'https://quickbooks.api.intuit.com';

// Where an account can sit on a line, one entry per kind of transaction that
// shows up under an expense heading on the P&L.
export const KINDS = [
  { key: 'Purchase',         path: 'purchase',         label: 'Expense',
    detail: 'AccountBasedExpenseLineDetail' },
  { key: 'Bill',             path: 'bill',             label: 'Bill',
    detail: 'AccountBasedExpenseLineDetail' },
  { key: 'VendorCredit',     path: 'vendorcredit',     label: 'Vendor credit',
    detail: 'AccountBasedExpenseLineDetail' },
  { key: 'CreditCardCredit', path: 'creditcardcredit', label: 'Credit card credit',
    detail: 'AccountBasedExpenseLineDetail' },
  { key: 'Deposit',          path: 'deposit',          label: 'Deposit',
    detail: 'DepositLineDetail' },
  { key: 'JournalEntry',     path: 'journalentry',     label: 'Journal entry',
    detail: 'JournalEntryLineDetail' }
];

export const kindOf = key => KINDS.filter(k => k.key === key)[0] || null;

const quote = s => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

export function shiftDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function monthEnd(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0))
    .toISOString().slice(0, 10);
}

/* ==================== the account list ==================== */

// Every account a line can be posted to, with its type, so an expense can be
// told from a cost of sales and the two are not mixed up by name alone.
export async function listAccounts(realmId, token) {
  const out = [];
  let start = 1;

  while (true) {
    const q = await qbQuery(realmId, token,
      `SELECT Id, Name, FullyQualifiedName, AccountType, AccountSubType, Classification, Active ` +
      `FROM Account STARTPOSITION ${start} MAXRESULTS 1000`);
    const arr = q.Account || [];
    arr.forEach(a => out.push({
      id: String(a.Id),
      name: a.FullyQualifiedName || a.Name,
      type: a.AccountType || '',
      sub: a.AccountSubType || '',
      group: a.Classification || '',
      active: a.Active !== false
    }));
    if (arr.length < 1000) break;
    start += 1000;
    if (start > 9000) break;
  }

  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/* ==================== reading the lines ==================== */

// The account-carrying lines of one transaction, whatever kind it is. Lines
// that carry a product rather than a category are left out - there is no
// category on them to change.
export function linesOf(kind, txn) {
  return (txn.Line || [])
    .filter(l => l[kind.detail] && l[kind.detail].AccountRef)
    .map(l => {
      const d = l[kind.detail];
      return {
        id: String(l.Id || ''),
        accountId: String(d.AccountRef.value),
        account: String(d.AccountRef.name || ''),
        description: l.Description || '',
        amount: Number(l.Amount || 0),
        posting: d.PostingType || '',
        vat: (d.TaxCodeRef && d.TaxCodeRef.value) || ''
      };
    });
}

// Who the transaction is with. Each kind keeps that in a different place, and a
// journal entry keeps it on a line or nowhere at all.
function nameOf(kind, txn) {
  if (kind.key === 'Purchase') return (txn.EntityRef && txn.EntityRef.name) || '';
  if (kind.key === 'Bill' || kind.key === 'VendorCredit' || kind.key === 'CreditCardCredit') {
    return (txn.VendorRef && txn.VendorRef.name) || '';
  }
  if (kind.key === 'Deposit') {
    const l = (txn.Line || []).filter(x => x.DepositLineDetail && x.DepositLineDetail.Entity)[0];
    return l ? (l.DepositLineDetail.Entity.name || '') : '';
  }
  const j = (txn.Line || []).filter(x => x.JournalEntryLineDetail &&
                                         x.JournalEntryLineDetail.Entity &&
                                         x.JournalEntryLineDetail.Entity.EntityRef)[0];
  return j ? (j.JournalEntryLineDetail.Entity.EntityRef.name || '') : '';
}

// The bank or payable side of the transaction - the split column on the report.
// It is shown so it is plain that this is not what moves.
function payFrom(kind, txn) {
  if (kind.key === 'Purchase' || kind.key === 'Deposit' || kind.key === 'CreditCardCredit') {
    return (txn.AccountRef && txn.AccountRef.name) || '';
  }
  if (kind.key === 'Bill' || kind.key === 'VendorCredit') {
    return (txn.APAccountRef && txn.APAccountRef.name) || '';
  }
  return '';
}

// An expense, a cheque and a card payment are all a Purchase underneath, and
// the staff reading this screen tell them apart by those names.
function labelOf(kind, txn) {
  if (kind.key !== 'Purchase') return kind.label;
  if (txn.Credit) return 'Refund';
  if (txn.PaymentType === 'Check') return 'Cheque';
  if (txn.PaymentType === 'CreditCard') return 'Credit card expense';
  return 'Expense';
}

// One row per transaction that carries the account, saying which of its lines
// carry it and what those lines are worth. Nothing is changed here.
export function planTxn(kind, txn, accountId) {
  const lines = linesOf(kind, txn);
  const hits = lines.filter(l => l.accountId === String(accountId));
  if (!hits.length) return null;

  return {
    kind: kind.key,
    kindLabel: labelOf(kind, txn),
    qbId: String(txn.Id),
    doc: String(txn.DocNumber || ''),
    date: txn.TxnDate || '',
    name: nameOf(kind, txn),
    payFrom: payFrom(kind, txn),
    memo: txn.PrivateNote || txn.Memo || '',
    total: Number(txn.TotalAmt || 0),
    lineCount: lines.length,
    hits,
    hitTotal: Math.round(hits.reduce((s, l) => s + l.amount, 0) * 100) / 100,
    state: 'ready',
    note: hits.length === lines.length
      ? 'the whole transaction'
      : hits.length + ' of ' + lines.length + ' lines'
  };
}

// The same row, but carrying every account line rather than only the ones
// under one category. Picking by description needs to see them all first.
export function planAnyTxn(kind, txn) {
  const lines = linesOf(kind, txn);
  if (!lines.length) return null;

  return {
    kind: kind.key,
    kindLabel: labelOf(kind, txn),
    qbId: String(txn.Id),
    doc: String(txn.DocNumber || ''),
    date: txn.TxnDate || '',
    name: nameOf(kind, txn),
    payFrom: payFrom(kind, txn),
    memo: txn.PrivateNote || txn.Memo || '',
    total: Number(txn.TotalAmt || 0),
    lineCount: lines.length,
    lines
  };
}

/* ==================== finding them ==================== */

// QuickBooks will not filter on an account sitting inside a line, so the only
// way to the transactions behind a P&L figure is to read the date range and
// keep the ones that carry the account. A month at a time, a week at a time if
// a month runs past the 9,000 row cap.
export async function readWindow(realmId, token, kind, from, to, keep) {
  let start = 1;
  let hitCap = false;

  while (true) {
    // strict, because a refusal that comes back looking like an empty month is
    // how a whole scan ends up saying nothing was there
    const q = await qbQueryStrict(realmId, token,
      `SELECT * FROM ${kind.key} WHERE TxnDate >= '${from}' AND TxnDate <= '${to}' ` +
      `STARTPOSITION ${start} MAXRESULTS 1000`);
    const arr = q[kind.key] || [];
    arr.forEach(keep);
    if (arr.length < 1000) break;
    start += 1000;
    if (start > 9000) { hitCap = true; break; }
  }

  return hitCap;
}

// `onStep` is called after every window so the page can show where the scan has
// got to - this reads a year of books and that is not instant.
export async function scanAccount(realmId, token, opts, onStep) {
  const { from, to, accountId } = opts;
  const kinds = (opts.kinds && opts.kinds.length)
    ? KINDS.filter(k => opts.kinds.includes(k.key))
    : KINDS;

  const rows = [];
  const seen = new Set();                        // a window walked twice
  let read = 0;

  for (const kind of kinds) {
    let cursor = from, windows = 0;

    while (cursor <= to && windows < 60) {
      let end = monthEnd(cursor);
      if (end > to) end = to;

      const keep = txn => {
        read++;
        const row = planTxn(kind, txn, accountId);
        if (!row) return;
        const k = kind.key + '|' + row.qbId;
        if (seen.has(k)) return;
        seen.add(k);
        rows.push(row);
      };

      const hitCap = await readWindow(realmId, token, kind, cursor, end, keep);

      // that month was too busy - walk it a week at a time instead
      if (hitCap) {
        let sub = cursor;
        while (sub <= end) {
          let subEnd = shiftDays(sub, 6);
          if (subEnd > end) subEnd = end;
          await readWindow(realmId, token, kind, sub, subEnd, keep);
          sub = shiftDays(subEnd, 1);
        }
      }

      if (onStep) onStep({ kind: kind.key, upto: end, found: rows.length, read });
      cursor = shiftDays(end, 1);
      windows++;
    }
  }

  rows.sort((a, b) => (a.date || '').localeCompare(b.date || '') ||
                      a.doc.localeCompare(b.doc));
  return { rows, read };
}

/* ==================== changing one ==================== */

// The transaction is read again so the sync token is the current one, the old
// account is swapped for the new one on the lines that carry it, and the whole
// transaction goes back. Every other field on those lines is the field that
// came out of QuickBooks a moment ago, which is what keeps the amount, the VAT
// code and the description where they were.
export async function recatOne(realmId, token, kindKey, txnId, fromId, to) {
  const kind = kindOf(kindKey);
  if (!kind) throw new Error('Unknown transaction type ' + kindKey);

  const q = await qbQuery(realmId, token,
    `SELECT * FROM ${kind.key} WHERE Id = '${quote(txnId)}'`);
  const txn = (q[kind.key] || [])[0];
  if (!txn) throw new Error(kind.label + ' ' + txnId + ' is not in QuickBooks any more');

  let changed = 0;
  const lines = (txn.Line || []).map(l => {
    const d = l[kind.detail];
    if (!d || !d.AccountRef || String(d.AccountRef.value) !== String(fromId)) return l;

    changed++;
    const line = Object.assign({}, l);
    line[kind.detail] = Object.assign({}, d, {
      AccountRef: { value: String(to.id), name: to.name }
    });
    return line;
  });

  if (!changed) {
    throw new Error('That category is no longer on ' + (txn.DocNumber || txnId));
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
