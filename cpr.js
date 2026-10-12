import { listFolders, listSheetsIn, listTabs, readTab, paintRows } from './sheets.js';
import { getSetting, setSetting, recordRun } from './settings.js';
import { getAccessToken, qbQuery } from './qb.js';

const API = 'https://quickbooks.api.intuit.com';

/* ==================== small helpers ==================== */

export function clean(s) {
  return String(s ?? '').replace(/[\u200B-\u200D\uFEFF\u00A0]/g, '').trim();
}

export function num(v) {
  const n = parseFloat(String(v ?? '').replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? 0 : n;
}

export function digitsOf(v) {
  return String(v ?? '').replace(/[^0-9]/g, '').replace(/^0+(?=[0-9])/, '');
}

// One parcel can carry several orders - the courier writes them in one cell,
// "91302583 , 91302588", and the COD is the two added up. Every number in the
// cell is pulled out so all of them can be settled together.
export function splitInvoices(cell) {
  const s = clean(cell);
  if (!s) return [];
  return s
    .split(/[\s,;/|]+/)
    .map(x => clean(x))
    .filter(x => digitsOf(x).length >= 4);
}

const MONTHS = {
  jan:1, feb:2, mar:3, apr:4, may:5, jun:6,
  jul:7, aug:8, sep:9, oct:10, nov:11, dec:12
};

export function toISO(v) {
  if (v === null || v === undefined || v === '') return null;

  // Excel keeps dates as a count of days since 1899-12-30
  const asNum = Number(String(v).trim());
  if (!isNaN(asNum) && asNum > 20000 && asNum < 80000) {
    const ms = Math.round((asNum - 25569) * 86400000);
    return new Date(ms).toISOString().slice(0, 10);
  }

  let s = clean(v);
  if (!s) return null;

  // drop any time that came along for the ride
  s = s.replace(/[T ]\d{1,2}:\d{2}(:\d{2})?(\.\d+)?\s*(am|pm)?.*$/i, '').trim();

  const pad = n => String(n).padStart(2, '0');

  // 2026-07-15
  let m = s.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;

  // 15/07/2026 or 7/15/2026 - couriers use both
  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (m) {
    let a = Number(m[1]), b = Number(m[2]);
    let mo = a, da = b;
    if (a > 12) { mo = b; da = a; }
    return `${m[3]}-${pad(mo)}-${pad(da)}`;
  }

  // 15-Jul-2026 or 15 July 2026
  m = s.match(/^(\d{1,2})[\s\-]([A-Za-z]{3,})[\s\-](\d{4})$/);
  if (m) {
    const mo = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (mo) return `${m[3]}-${pad(mo)}-${pad(m[1])}`;
  }

  // Jul 15, 2026
  m = s.match(/^([A-Za-z]{3,})[\s\-](\d{1,2}),?[\s\-](\d{4})$/);
  if (m) {
    const mo = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (mo) return `${m[3]}-${pad(mo)}-${pad(m[2])}`;
  }

  // last resort - let the browser engine try
  const d = new Date(s);
  if (!isNaN(d.getTime()) && d.getFullYear() > 1990 && d.getFullYear() < 2100) {
    return d.toISOString().slice(0, 10);
  }

  return null;
}

/* ==================== column detection ==================== */

const HINTS = {
  invoice: ['order id', 'order no', 'order number', 'order #', 'reference no', 'reference number',
            'ref no', 'consignee order', 'customer reference', 'order ref', 'shopify order'],
  cpr:     ['cpr', 'cpr no', 'cpr number', 'cpr n', 'invoice_no', 'invoice no', 'settlement no',
            'payment no', 'cpr#'],
  cprDate: ['cpr date', 'cpr d', 'settlement date', 'payment date', 'invoice date', 'cpr_date'],
  amount:  ['collection', 'collection amount', 'cod amount', 'amount', 'cod', 'collected amount',
            'net amount', 'payable amount', 'amount payable'],
  status:  ['status', 'order status', 'delivery status', 'shipment status', 'current status',
            'consignment status']
};

function headerIndex(header, list) {
  const low = header.map(h => clean(h).toLowerCase());
  for (const want of list) {
    const i = low.indexOf(want);
    if (i >= 0) return i;
  }
  for (const want of list) {
    const i = low.findIndex(h => h && h.includes(want));
    if (i >= 0) return i;
  }
  return -1;
}

// find the row that actually holds the headers — some couriers put a title on top
function findHeaderRow(grid) {
  const limit = Math.min(grid.length, 15);
  let best = 0, bestScore = -1;
  for (let r = 0; r < limit; r++) {
    const row = (grid[r] || []).map(x => clean(x).toLowerCase());
    if (!row.filter(Boolean).length) continue;
    let score = 0;
    Object.values(HINTS).forEach(list => {
      if (list.some(w => row.some(h => h === w || h.includes(w)))) score++;
    });
    score += Math.min(row.filter(Boolean).length, 10) / 100;
    if (score > bestScore) { bestScore = score; best = r; }
  }
  return best;
}

export function detectColumns(header, saved) {
  const pick = (key) => {
    if (saved && saved[key] !== undefined && saved[key] !== null && saved[key] >= 0) {
      return saved[key];
    }
    return headerIndex(header, HINTS[key]);
  };
  return {
    invoice: pick('invoice'),
    cpr:     pick('cpr'),
    cprDate: pick('cprDate'),
    amount:  pick('amount'),
    status:  pick('status')
  };
}

/* ==================== reading a CPR sheet ==================== */

export async function loadSheet(sheetId, tabTitle, excel, saved) {
  const grid = await readTab(sheetId, tabTitle, excel);
  if (!grid.length) throw new Error('That tab is empty');

  const hRow = findHeaderRow(grid);
  const header = (grid[hRow] || []).map(h => clean(h));
  const cols = detectColumns(header, saved);

  const rows = [];
  for (let r = hRow + 1; r < grid.length; r++) {
    const raw = grid[r] || [];
    if (!raw.filter(x => clean(x)).length) continue;

    const invoice = cols.invoice >= 0 ? clean(raw[cols.invoice]) : '';
    const amount  = cols.amount  >= 0 ? num(raw[cols.amount])   : 0;
    const status  = cols.status  >= 0 ? clean(raw[cols.status]) : '';
// courier sheets end with a Total line - it has no order number, skip it
    if (!invoice) continue;
    if (/^(grand )?total/i.test(invoice)) continue;

    const invoices = splitInvoices(invoice);
    if (!invoices.length) continue;

    rows.push({
      sheetRow: r + 1,                       // 1-based, matches the sheet
      invoice,                               // the cell as written
      invoices,                              // every order number inside it
      merged: invoices.length > 1,
      amount,
      status,
      cprNumber: cols.cpr     >= 0 ? clean(raw[cols.cpr])     : '',
      cprDate:   cols.cprDate >= 0 ? toISO(raw[cols.cprDate]) : null
    });
  }

  return { header, cols, rows, headerRow: hRow + 1, width: header.length || 40 };
}

// group the rows by CPR number so the page can offer a picker
export function groupByCpr(rows, hasStatusColumn) {
  const map = new Map();
  rows.forEach(r => {
    const key = r.cprNumber || '(no CPR number)';
    if (!map.has(key)) {
      map.set(key, { cprNumber: r.cprNumber || '', cprDate: r.cprDate || null, rows: [], amount: 0, delivered: 0 });
    }
    const g = map.get(key);
    g.rows.push(r);
    if (!g.cprDate && r.cprDate) g.cprDate = r.cprDate;
    if (isDelivered(r, hasStatusColumn)) { g.delivered++; g.amount += r.amount; }
  });
  return Array.from(map.values())
    .sort((a, b) => (b.cprDate || '').localeCompare(a.cprDate || ''));
}

export function isDelivered(row, hasStatusColumn) {
  if (!hasStatusColumn) return true;                 // no status column = everything delivered
  const s = (row.status || '').toLowerCase();
  if (!s) return true;
  return /deliver/.test(s);                          // Delivered, DELIVERED, delivered-ok...
}

/* ==================== QuickBooks side ==================== */

// pull the invoices these numbers point at, in chunks the API will accept
export async function findInvoices(realmId, token, numbers) {
  const found = new Map();                            // digits -> invoice
  const list = [...new Set(numbers.filter(Boolean))];
  const size = 40;

  for (let i = 0; i < list.length; i += size) {
    const chunk = list.slice(i, i + size);
    const variants = [];
       chunk.forEach(n => {
      const d = digitsOf(n);
      if (!d) return;
      // a "-D" copy has the same digits as the original, so the number is
      // asked for as written too - otherwise the two cannot be told apart
      const asIs = clean(n);
      if (asIs && asIs !== d && asIs !== '#' + d) {
        variants.push(`'${asIs}'`);
        if (asIs.charAt(0) !== '#') variants.push(`'#${asIs}'`);
      }
      variants.push(`'#${d}'`, `'${d}'`);
    });
    if (!variants.length) continue;

   const q = await qbQuery(realmId, token,
      `SELECT Id, DocNumber, TxnDate, TotalAmt, Balance, CustomerRef, SyncToken, LinkedTxn ` +
      `FROM Invoice WHERE DocNumber IN (${variants.join(',')}) MAXRESULTS 1000`);

       (q.Invoice || []).forEach(inv => {
      const doc = clean(inv.DocNumber);
      const d = digitsOf(inv.DocNumber);
      if (!d) return;

      // filed under the number as written as well, so "#91304573-D" finds the
      // copy and not the original it was made from
      const asKey = doc.replace(/^#/, '');
      if (asKey && asKey !== d) {
        found.set(asKey, {
          id: inv.Id,
          doc: inv.DocNumber || '',
          date: inv.TxnDate || '',
          total: Number(inv.TotalAmt || 0),
          balance: Number(inv.Balance === undefined ? inv.TotalAmt : inv.Balance),
          customerId: inv.CustomerRef ? inv.CustomerRef.value : null,
          customerName: inv.CustomerRef ? (inv.CustomerRef.name || '') : '',
          paymentIds: (inv.LinkedTxn || [])
            .filter(t => t.TxnType === 'Payment').map(t => String(t.TxnId))
        });
        return;
      }
      const total = Number(inv.TotalAmt || 0);
      const bal = Number(inv.Balance === undefined ? total : inv.Balance);
      const prev = found.get(d);
      // an unpaid copy is the one worth paying
      if (!prev || (prev.balance <= 0.005 && bal > 0.005)) {
        // whatever payment is sitting on this invoice - the trail back to a CPR
        const payIds = (inv.LinkedTxn || [])
          .filter(t => t.TxnType === 'Payment')
          .map(t => String(t.TxnId));

        found.set(d, {
          id: inv.Id,
          doc: inv.DocNumber || '',
          date: inv.TxnDate || '',
          total,
          balance: bal,
          customerId: inv.CustomerRef ? inv.CustomerRef.value : null,
          customerName: inv.CustomerRef ? (inv.CustomerRef.name || '') : '',
          paymentIds: payIds
        });
      }
    });
  }

  return found;
}

// What each invoice still owes, this second.
//
// A match was made when the sheet was searched, and the balance it carries is
// the balance of that moment. By the time the money is received - minutes
// later, or while someone else at another desk is receiving their own CPR -
// the invoice may already be part paid or settled. Handing QuickBooks the old
// figure is what leaves money sitting unapplied, or as a credit on the
// customer, on an invoice that reads as received. So the balances are asked
// for again, immediately before the payment goes across.
export async function liveBalances(realmId, token, ids) {
  const out = new Map();                               // id -> balance owed
  const list = [...new Set((ids || []).map(x => String(x || '').replace(/[^0-9]/g, '')).filter(Boolean))];
  const size = 40;

  for (let i = 0; i < list.length; i += size) {
    const chunk = list.slice(i, i + size);
    const q = await qbQuery(realmId, token,
      `SELECT Id, DocNumber, TotalAmt, Balance FROM Invoice ` +
      `WHERE Id IN (${chunk.map(id => `'${id}'`).join(',')}) MAXRESULTS 1000`);

    (q.Invoice || []).forEach(inv => {
      const bal = Number(inv.Balance === undefined ? inv.TotalAmt : inv.Balance);
      out.set(String(inv.Id), Math.round((isFinite(bal) ? bal : 0) * 100) / 100);
    });
  }

  return out;
}

export async function listAccounts(realmId, token) {
  const q = await qbQuery(realmId, token,
    `SELECT Id, Name, AccountType, AccountSubType FROM Account ` +
    `WHERE AccountType IN ('Bank','Other Current Asset') MAXRESULTS 500`);
  return (q.Account || []).map(a => ({
    id: a.Id, name: a.Name, type: a.AccountType, sub: a.AccountSubType || ''
  }));
}

export async function listPaymentMethods(realmId, token) {
  const q = await qbQuery(realmId, token, `SELECT Id, Name FROM PaymentMethod MAXRESULTS 200`);
  return (q.PaymentMethod || []).map(m => ({ id: m.Id, name: m.Name }));
}

// one Payment covering many invoices of the same customer
export async function postPayment(realmId, token, payload) {
  const r = await fetch(`${API}/v3/company/${realmId}/payment?minorversion=70`, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const text = await r.text();
  const tid = r.headers.get('intuit_tid') || null;

  if (!r.ok) {
    let msg = text.slice(0, 300);
    try {
      const f = JSON.parse(text).Fault;
      if (f && f.Error && f.Error.length) msg = `${f.Error[0].Message} | ${f.Error[0].Detail || ''}`;
    } catch (e) {}
    return { ok: false, msg, tid };
  }

  const body = JSON.parse(text);
  return { ok: true, id: body.Payment ? body.Payment.Id : null, tid };
}

// A parcel that was replaced comes back under a second CPR, so the same order
// has to be settled twice. QuickBooks will not take the number twice, so a
// copy is made under "-D" and that is what the second CPR pays.
export async function copyInvoice(realmId, token, invoiceId, suffix) {
  const q = await qbQuery(realmId, token, `SELECT * FROM Invoice WHERE Id = '${invoiceId}'`);
  const src = (q.Invoice || [])[0];
  if (!src) throw new Error('That invoice is not in QuickBooks any more');

  const base = clean(src.DocNumber) || String(invoiceId);

  // -D, then -D2, -D3 if those are taken already
  let doc = '';
  for (let n = 1; n <= 9; n++) {
    const tryDoc = base + (suffix || '-D') + (n === 1 ? '' : n);
    const hit = await qbQuery(realmId, token,
      `SELECT Id FROM Invoice WHERE DocNumber = '${tryDoc}' MAXRESULTS 1`);
    if (!(hit.Invoice || []).length) { doc = tryDoc; break; }
  }
  if (!doc) throw new Error('Too many copies of ' + base + ' already');

   // every line the original had - dropping a discount or a shipping line here
  // is what makes a copy come out at the wrong amount
  const lines = (src.Line || []).filter(l => l.DetailType !== 'SubTotalLineDetail');

  const payload = {
    DocNumber: doc.slice(0, 21),
    TxnDate: src.TxnDate,                 // the original date, so ageing stays true
    CustomerRef: src.CustomerRef,
    Line: lines,
    PrivateNote: `Replacement copy of ${base}` +
                 (src.PrivateNote ? ' - ' + src.PrivateNote : '')
  };
  if (src.SalesTermRef) payload.SalesTermRef = src.SalesTermRef;
  if (src.DueDate) payload.DueDate = src.DueDate;
  if (src.CurrencyRef) payload.CurrencyRef = src.CurrencyRef;
  if (src.TxnTaxDetail) payload.TxnTaxDetail = src.TxnTaxDetail;
  if (src.BillAddr) payload.BillAddr = src.BillAddr;
  if (src.ShipAddr) payload.ShipAddr = src.ShipAddr;

  if (!payload.Line.length) throw new Error('That invoice has no lines to copy');

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
  if (!r.ok) {
    let msg = text.slice(0, 300);
    try {
      const f = JSON.parse(text).Fault;
      if (f && f.Error && f.Error.length) msg = `${f.Error[0].Message} | ${f.Error[0].Detail || ''}`;
    } catch (e) {}
    throw new Error(msg);
  }

  const made = JSON.parse(text).Invoice;
  return {
    id: made.Id,
    doc: made.DocNumber,
    total: Number(made.TotalAmt || 0),
    from: base
  };
}

export { listFolders, listSheetsIn, listTabs, paintRows, getSetting, setSetting, recordRun };
// Every payment we post carries the CPR number in PaymentRefNum, so one
// sweep of the payments tells us which CPRs are already done - no need to
// check thousands of invoices one by one.
export async function paymentsByCpr(realmId, token, fromDate, toDate) {
  const out = new Map();

  let where = '';
  if (fromDate && toDate) {
    where = `WHERE TxnDate >= '${fromDate}' AND TxnDate <= '${toDate}' `;
  }

  let start = 1;
  while (true) {
    const q = await qbQuery(realmId, token,
      `SELECT Id, TxnDate, TotalAmt, PaymentRefNum, DepositToAccountRef, PrivateNote ` +
      `FROM Payment ${where}STARTPOSITION ${start} MAXRESULTS 1000`);

    const arr = q.Payment || [];
    arr.forEach(p => {
      const ref = clean(p.PaymentRefNum);
      if (!ref) return;

      if (!out.has(ref)) {
        out.set(ref, { cpr: ref, count: 0, amount: 0, ids: [], dates: [], accounts: [] });
      }
      const g = out.get(ref);
      g.count++;
      g.amount += Number(p.TotalAmt || 0);
      g.ids.push(p.Id);
      if (p.TxnDate && g.dates.indexOf(p.TxnDate) < 0) g.dates.push(p.TxnDate);

      const acc = p.DepositToAccountRef;
      if (acc && acc.value) {
        const hit = g.accounts.find(a => a.id === String(acc.value));
        if (!hit) g.accounts.push({ id: String(acc.value), name: acc.name || '' });
      }
    });

    if (arr.length < 1000) break;
    start += 1000;
    if (start > 9000) break;
  }

  const obj = {};
  out.forEach((v, k) => {
    obj[k] = {
      cpr: v.cpr,
      count: v.count,
      amount: Math.round(v.amount * 100) / 100,
      ids: v.ids,
      dates: v.dates,
      accounts: v.accounts
    };
  });
  return obj;
}
// Look up payments by their own ids - the ids come off the invoices' LinkedTxn.
// This is how we spot a CPR that was received under the wrong number, or with
// no number at all: the invoice still leads us to the payment behind it.
export async function paymentsByIds(realmId, token, paymentIds) {
  const ids = [...new Set((paymentIds || []).map(String).filter(Boolean))];
  if (!ids.length) return [];

  const seen = new Map();

  for (let i = 0; i < ids.length; i += 40) {
    const list = ids.slice(i, i + 40).map(x => `'${x}'`).join(',');
    let q;
    try {
      q = await qbQuery(realmId, token,
        `SELECT Id, TxnDate, TotalAmt, PaymentRefNum, DepositToAccountRef, PrivateNote ` +
        `FROM Payment WHERE Id IN (${list}) MAXRESULTS 1000`);
    } catch (e) {
      continue;
    }
    (q.Payment || []).forEach(p => {
      if (seen.has(p.Id)) return;
      seen.set(p.Id, {
        id: p.Id,
        date: p.TxnDate || '',
        amount: Number(p.TotalAmt || 0),
        ref: clean(p.PaymentRefNum),
        note: clean(p.PrivateNote),
        accountId: p.DepositToAccountRef ? String(p.DepositToAccountRef.value) : '',
        accountName: p.DepositToAccountRef ? (p.DepositToAccountRef.name || '') : ''
      });
    });
  }

  return [...seen.values()];
}
