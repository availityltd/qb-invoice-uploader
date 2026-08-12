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

export function toISO(v) {
  if (!v) return null;
  const s = clean(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  let m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) {
    // couriers write m/d/yyyy — swap when the first number can only be a day
    let a = Number(m[1]), b = Number(m[2]);
    let mo = a, da = b;
    if (a > 12) { mo = b; da = a; }
    return `${m[3]}-${String(mo).padStart(2, '0')}-${String(da).padStart(2, '0')}`;
  }
  m = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
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

    rows.push({
      sheetRow: r + 1,                       // 1-based, matches the sheet
      invoice,
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
      variants.push(`'#${d}'`, `'${d}'`);
    });
    if (!variants.length) continue;

    const q = await qbQuery(realmId, token,
      `SELECT Id, DocNumber, TxnDate, TotalAmt, Balance, CustomerRef, SyncToken ` +
      `FROM Invoice WHERE DocNumber IN (${variants.join(',')}) MAXRESULTS 1000`);

    (q.Invoice || []).forEach(inv => {
      const d = digitsOf(inv.DocNumber);
      if (!d) return;
      const total = Number(inv.TotalAmt || 0);
      const bal = Number(inv.Balance === undefined ? total : inv.Balance);
      const prev = found.get(d);
      // an unpaid copy is the one worth paying
      if (!prev || (prev.balance <= 0.005 && bal > 0.005)) {
        found.set(d, {
          id: inv.Id,
          doc: inv.DocNumber || '',
          date: inv.TxnDate || '',
          total,
          balance: bal,
          customerId: inv.CustomerRef ? inv.CustomerRef.value : null,
          customerName: inv.CustomerRef ? (inv.CustomerRef.name || '') : ''
        });
      }
    });
  }

  return found;
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

export { listFolders, listSheetsIn, listTabs, paintRows, getSetting, setSetting, recordRun };
