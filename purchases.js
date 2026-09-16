// What was bought: the orders placed and the bills entered against them.
//
// The products page can say a thing sold although it was never bought, and can
// put a cost on an item, but neither of those puts the cost into the books.
// QuickBooks works cost of sales out from what was actually bought - so the
// purchase is the repair, and this is where one is looked at and made.
//
// An order is a promise and changes nothing in the ledger. A bill is the money
// owed and is what brings stock in at a cost. They are the same shape otherwise,
// so they are read and written through the same pair of functions.

import { qbQuery } from './qb.js';

const API = 'https://quickbooks.api.intuit.com';

const round2 = n => Math.round(n * 100) / 100;
const quote = s => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

export const KINDS = {
  PurchaseOrder: { key: 'PurchaseOrder', path: 'purchaseorder', label: 'Purchase order' },
  Bill:          { key: 'Bill',          path: 'bill',          label: 'Bill' }
};

export const kindOf = k => KINDS[k] || KINDS.PurchaseOrder;

/* ==================== who it is with ==================== */

export async function listVendors(realmId, token) {
  const out = [];
  let start = 1;

  while (true) {
    const q = await qbQuery(realmId, token,
      `SELECT Id, DisplayName, Active FROM Vendor WHERE Active IN (true, false) STARTPOSITION ${start} MAXRESULTS 1000`);
    const arr = q.Vendor || [];
    arr.forEach(v => out.push({
      id: String(v.Id), name: v.DisplayName || '', active: v.Active !== false
    }));
    if (arr.length < 1000) break;
    start += 1000;
    if (start > 9000) break;
  }

  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// Which account the money is owed on. A bill goes to Accounts Payable, and a
// company can have more than one.
export async function listPayables(realmId, token) {
  const q = await qbQuery(realmId, token,
    `SELECT Id, Name, AccountType FROM Account WHERE AccountType = 'Accounts Payable' AND Active = true MAXRESULTS 100`);
  return (q.Account || []).map(a => ({ id: String(a.Id), name: a.Name || '' }));
}

/* ==================== what is already there ==================== */

// One order or bill as the page shows it: who it is with, what it is worth, what
// is on it, and - for an order - how much of it has actually arrived.
function docRow(kind, txn) {
  const lines = (txn.Line || [])
    .filter(l => l.ItemBasedExpenseLineDetail)
    .map(l => {
      const d = l.ItemBasedExpenseLineDetail;
      const qty = Number(d.Qty || 0);
      return {
        id: String(l.Id || ''),
        item: d.ItemRef ? String(d.ItemRef.value) : '',
        itemName: d.ItemRef ? (d.ItemRef.name || '') : '',
        desc: l.Description || '',
        qty,
        rate: Number(d.UnitPrice || (qty ? Number(l.Amount || 0) / qty : 0)) || 0,
        amount: Number(l.Amount || 0),
        received: l.Received === undefined ? null : Number(l.Received)
      };
    });

  // a line with no item is an expense line - it never reaches the stock, which
  // is the whole reason a bill can exist and the cost still not be there
  const other = (txn.Line || [])
    .filter(l => l.AccountBasedExpenseLineDetail)
    .map(l => ({
      account: (l.AccountBasedExpenseLineDetail.AccountRef || {}).name || '',
      desc: l.Description || '',
      amount: Number(l.Amount || 0)
    }));

  return {
    kind: kind.key,
    id: String(txn.Id),
    doc: txn.DocNumber || '',
    date: txn.TxnDate || '',
    due: txn.DueDate || '',
    vendor: txn.VendorRef ? (txn.VendorRef.name || '') : '',
    vendorId: txn.VendorRef ? String(txn.VendorRef.value) : '',
    memo: txn.PrivateNote || '',
    currency: txn.CurrencyRef ? txn.CurrencyRef.value : '',
    total: Number(txn.TotalAmt || 0),
    balance: txn.Balance === undefined ? null : Number(txn.Balance),
    status: kind.key === 'PurchaseOrder' ? (txn.POStatus || '') : '',
    // an order that became a bill says so, and that is what says it is done with
    linked: (txn.LinkedTxn || []).map(t => ({ id: String(t.TxnId), kind: t.TxnType })),
    itemLines: lines.length,
    itemQty: round2(lines.reduce((s, l) => s + l.qty, 0)),
    itemValue: round2(lines.reduce((s, l) => s + l.amount, 0)),
    otherValue: round2(other.reduce((s, l) => s + l.amount, 0)),
    lines,
    other
  };
}

export async function readDocs(realmId, token, kindKey, opts = {}, onStep) {
  const kind = kindOf(kindKey);
  const { from, to } = opts;
  const out = [];
  let start = 1;

  while (true) {
    const where = (from && to)
      ? ` WHERE TxnDate >= '${quote(from)}' AND TxnDate <= '${quote(to)}'`
      : '';
    const q = await qbQuery(realmId, token,
      `SELECT * FROM ${kind.key}${where} ORDERBY TxnDate DESC STARTPOSITION ${start} MAXRESULTS 500`);
    const arr = q[kind.key] || [];

    arr.forEach(txn => out.push(docRow(kind, txn)));
    if (onStep) onStep({ read: out.length });
    if (arr.length < 500) break;
    start += 500;
    if (start > 9000) break;
  }

  return out;
}

export async function readOne(realmId, token, kindKey, id) {
  const kind = kindOf(kindKey);
  const q = await qbQuery(realmId, token,
    `SELECT * FROM ${kind.key} WHERE Id = '${quote(id)}'`);
  const txn = (q[kind.key] || [])[0];
  if (!txn) throw new Error(kind.label + ' ' + id + ' is not in QuickBooks');
  return docRow(kind, txn);
}

/* ==================== making one ==================== */

// The lines as QuickBooks wants them. Every line carries an item, because a
// purchase that does not carry an item brings no stock in and leaves the cost of
// sales exactly as wrong as it was.
function itemLines(lines) {
  return (lines || []).map((l, i) => {
    const qty = Number(l.qty || 0);
    const rate = Number(l.rate || 0);
    if (!l.itemId) throw new Error('Line ' + (i + 1) + ' has no product on it');
    if (!(qty > 0)) throw new Error('Line ' + (i + 1) + ' has no quantity');
    if (!(rate >= 0)) throw new Error('Line ' + (i + 1) + ' has no rate');

    return {
      DetailType: 'ItemBasedExpenseLineDetail',
      Amount: round2(qty * rate),
      Description: l.desc || undefined,
      ItemBasedExpenseLineDetail: {
        ItemRef: { value: String(l.itemId) },
        Qty: qty,
        UnitPrice: rate,
        BillableStatus: 'NotBillable'
      }
    };
  });
}

export async function createDoc(realmId, token, kindKey, body) {
  const kind = kindOf(kindKey);

  if (!body.vendorId) throw new Error('Pick who it is with');
  const lines = itemLines(body.lines);
  if (!lines.length) throw new Error('Put at least one product on it');

  const payload = {
    VendorRef: { value: String(body.vendorId) },
    TxnDate: body.date || undefined,
    DocNumber: body.doc || undefined,
    PrivateNote: body.memo || undefined,
    Line: lines
  };

  if (body.currency) payload.CurrencyRef = { value: String(body.currency) };
  if (body.apAccountId) payload.APAccountRef = { value: String(body.apAccountId) };
  if (kind.key === 'Bill' && body.due) payload.DueDate = body.due;

  const res = await fetch(`${API}/v3/company/${realmId}/${kind.path}?minorversion=70`, {
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

  const made = data[kind.key] || {};
  return {
    kind: kind.key,
    id: String(made.Id || ''),
    doc: made.DocNumber || '',
    date: made.TxnDate || '',
    total: Number(made.TotalAmt || 0)
  };
}

/* ==================== the paper behind it ==================== */

// The supplier's own bill or order, kept against the transaction in QuickBooks.
// Whoever looks at this in a year wants to see the paper it came from, and a
// number typed into a note is not that.
//
// QuickBooks takes an attachment as a multipart upload: a piece of JSON saying
// what it belongs to, and the file itself beside it.
export async function attachFile(realmId, token, kindKey, txnId, file) {
  const kind = kindOf(kindKey);
  if (!file || !file.buffer) throw new Error('No file came through');

  const meta = {
    AttachableRef: [{
      EntityRef: { value: String(txnId), type: kind.key },
      IncludeOnSend: false
    }],
    FileName: file.originalname || 'attachment',
    ContentType: file.mimetype || 'application/octet-stream'
  };

  const form = new FormData();
  form.append('file_metadata_01', new Blob([JSON.stringify(meta)], { type: 'application/json' }),
              'metadata.json');
  form.append('file_content_01', new Blob([file.buffer], { type: meta.ContentType }),
              meta.FileName);

  const res = await fetch(`${API}/v3/company/${realmId}/upload?minorversion=70`, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' },
    body: form
  });

  const text = await res.text();
  let data = {};
  try { data = JSON.parse(text); } catch (e) { /* left as it came */ }

  if (!res.ok) {
    const f = data.Fault && data.Fault.Error && data.Fault.Error[0];
    throw new Error(f ? (f.Message + (f.Detail ? ' - ' + f.Detail : '')) : text.slice(0, 300));
  }

  // one file in, one answer out - and the answer says whether that one took
  const one = ((data.AttachableResponse || [])[0]) || {};
  if (one.Fault) {
    const f = (one.Fault.Error || [])[0] || {};
    throw new Error(f.Message ? (f.Message + (f.Detail ? ' - ' + f.Detail : '')) : 'QuickBooks refused the file');
  }

  const made = one.Attachable || {};
  return { id: String(made.Id || ''), name: made.FileName || meta.FileName,
           size: Number(made.Size || (file.buffer ? file.buffer.length : 0)) };
}

// What is already hanging off one transaction.
export async function listAttachments(realmId, token, kindKey, txnId) {
  const kind = kindOf(kindKey);
  const q = await qbQuery(realmId, token,
    `SELECT * FROM Attachable WHERE AttachableRef.EntityRef.Type = '${quote(kind.key)}'
       AND AttachableRef.EntityRef.Value = '${quote(txnId)}' MAXRESULTS 50`);

  return (q.Attachable || []).map(a => ({
    id: String(a.Id), name: a.FileName || '', size: Number(a.Size || 0),
    type: a.ContentType || '', at: a.MetaData ? a.MetaData.CreateTime : ''
  }));
}
