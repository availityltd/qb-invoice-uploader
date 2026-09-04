import { listTabs, readTab } from './sheets.js';
import { clean, num, digitsOf, toISO } from './cpr.js';
import { qbQuery } from './qb.js';

/* ==================== reading the sheet ==================== */
// The advance sheet runs day by day: a full-width band carrying the date,
// then that day's rows beneath it, until the next band comes along.

const HINTS = {
  invoice: ['order number', 'order no', 'order id', 'order #', 'invoice number', 'invoice no'],
  amount:  ['amount paid', 'paid amount', 'amount received', 'received amount', 'amount'],
  payable: ['payable amount', 'payable', 'total amount', 'order amount'],
  name:    ['account holder name', 'account holder', 'customer name', 'name'],
  note:    ['comments', 'comment', 'remarks', 'note'],
  bank:    ['bank', 'bank name', 'account', 'paid into', 'received in'],
  posted:  ['accounts department', 'accounts dept', 'posted', 'posted by', 'entered by']
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

function findHeaderRow(grid) {
  const limit = Math.min(grid.length, 10);
  let best = 0, bestScore = -1;
  for (let r = 0; r < limit; r++) {
    const row = (grid[r] || []).map(x => clean(x).toLowerCase());
    if (!row.filter(Boolean).length) continue;
    let score = 0;
    Object.values(HINTS).forEach(list => {
      if (list.some(w => row.some(h => h === w || h.includes(w)))) score++;
    });
    if (score > bestScore) { bestScore = score; best = r; }
  }
  return best;
}

export function detectColumns(header, saved) {
  const pick = key => {
    if (saved && saved[key] !== undefined && saved[key] !== null && saved[key] >= 0) {
      return saved[key];
    }
    return headerIndex(header, HINTS[key]);
  };
  return {
    invoice: pick('invoice'),
    amount:  pick('amount'),
    payable: pick('payable'),
    name:    pick('name'),
    note:    pick('note'),
    bank:    pick('bank'),
    posted:  pick('posted')
  };
}

// a band is a row with a date on it and nothing else worth reading
function bandDate(row, cols) {
  const filled = (row || []).map(x => clean(x)).filter(Boolean);
  if (filled.length !== 1) return null;

  const inv = cols.invoice >= 0 ? clean(row[cols.invoice]) : '';
  if (inv && /^\d{5,}$/.test(inv.replace(/^#/, ''))) return null;

  return toISO(filled[0]);
}

export async function loadAdvance(sheetId, tab, excel, saved) {
  const grid = await readTab(sheetId, tab, excel);
  if (!grid.length) throw new Error('That tab is empty');

  const hRow = findHeaderRow(grid);
  const header = (grid[hRow] || []).map(h => clean(h));
  const cols = detectColumns(header, saved);

  const rows = [];
  const days = new Map();
  let day = null;

  for (let r = hRow + 1; r < grid.length; r++) {
    const raw = grid[r] || [];
    if (!raw.filter(x => clean(x)).length) continue;

    const band = bandDate(raw, cols);
    if (band) { day = band; continue; }

    const invoice = cols.invoice >= 0 ? clean(raw[cols.invoice]) : '';
    if (!invoice) continue;
    if (/^(grand )?total/i.test(invoice)) continue;
    if (!digitsOf(invoice)) continue;

    const amount = cols.amount >= 0 ? num(raw[cols.amount]) : 0;
    if (amount <= 0) continue;                       // nothing was paid on this row

    rows.push({
      sheetRow: r + 1,
      date: day,
      invoice,
      amount,
      payable: cols.payable >= 0 ? num(raw[cols.payable]) : 0,
      name: cols.name >= 0 ? clean(raw[cols.name]) : '',
      note: cols.note >= 0 ? clean(raw[cols.note]) : '',
      bank: cols.bank >= 0 ? clean(raw[cols.bank]) : '',
      posted: cols.posted >= 0 ? clean(raw[cols.posted]) : ''
    });

    if (day) {
      if (!days.has(day)) days.set(day, { date: day, count: 0, amount: 0 });
      const d = days.get(day);
      d.count++;
      d.amount += amount;
    }
  }

  const dayList = [...days.values()]
    .map(d => ({ date: d.date, count: d.count, amount: Math.round(d.amount * 100) / 100 }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return { header, cols, rows, days: dayList, headerRow: hRow + 1 };
}

/* ==================== the QuickBooks side ==================== */

// same lookup as the CPR side - QB keeps #91329111 and 91329111 apart
export async function findForAdvance(realmId, token, numbers) {
  const found = new Map();
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
      `      `SELECT Id, DocNumber, TxnDate, TotalAmt, Balance, CustomerRef, LinkedTxn ` + ` +
      `FROM Invoice WHERE DocNumber IN (${variants.join(',')}) MAXRESULTS 1000`);

    (q.Invoice || []).forEach(inv => {
      const d = digitsOf(inv.DocNumber);
      if (!d) return;
      const total = Number(inv.TotalAmt || 0);
      const bal = Number(inv.Balance === undefined ? total : inv.Balance);
      const prev = found.get(d);
      // the copy still owing money is the one worth paying into
      if (!prev || (prev.balance <= 0.005 && bal > 0.005)) {
        found.set(d, {
          id: inv.Id,
          doc: inv.DocNumber || '',
          date: inv.TxnDate || '',
          total,
          balance: bal,
          customerId: inv.CustomerRef ? inv.CustomerRef.value : null,
          customerName: inv.CustomerRef ? (inv.CustomerRef.name || '') : ''
                    paymentIds: (inv.LinkedTxn || [])
            .filter(t => t.TxnType === 'Payment').map(t => String(t.TxnId)),
        });
      }
    });
  }

  return found;
}

// "1-15 July, 2026" from a pair of dates - what goes in the memo
export function spanLabel(from, to) {
  const MONTHS = ['January','February','March','April','May','June',
                  'July','August','September','October','November','December'];
  const a = new Date(from + 'T00:00:00Z');
  const b = new Date(to + 'T00:00:00Z');
  if (isNaN(a.getTime()) || isNaN(b.getTime())) return `${from} to ${to}`;

  const da = a.getUTCDate(), db = b.getUTCDate();
  const ma = a.getUTCMonth(), mb = b.getUTCMonth();
  const ya = a.getUTCFullYear(), yb = b.getUTCFullYear();

  if (ma === mb && ya === yb) {
    return da === db
      ? `${da} ${MONTHS[ma]}, ${ya}`
      : `${da}-${db} ${MONTHS[ma]}, ${ya}`;
  }
  if (ya === yb) return `${da} ${MONTHS[ma]} - ${db} ${MONTHS[mb]}, ${ya}`;
  return `${da} ${MONTHS[ma]} ${ya} - ${db} ${MONTHS[mb]} ${yb}`;
}

export { listTabs };
