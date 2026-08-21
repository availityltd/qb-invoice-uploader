import { readTab } from './sheets.js';
import { clean, num, toISO } from './cpr.js';
import { qbQuery } from './qb.js';

const API = 'https://quickbooks.api.intuit.com';

/* ==================== finding the charge columns ==================== */

// Couriers name these things a dozen different ways
const HINTS = {
  cpr:     ['cpr', 'cpr no', 'cpr number', 'cpr n', 'invoice_no', 'invoice no',
            'settlement no', 'payment no', 'cpr#'],
  cprDate: ['cpr date', 'cpr d', 'settlement date', 'payment date', 'invoice date', 'cpr_date'],
    charges: ['shipping_charges', 'shipping charges', 'amount_ti', 'delivery charges',
            'delivery charge', 'service charges', 'service charge', 'courier charges',
            'charges', 'freight', 'fuel surcharge', 'delivery fee', 'transaction fee'],
  charges2:['gst', 'amount_fs', 'sales tax on services', 'service tax', 'fed', 'surcharge'],
  charges3:['amount_wr', 'weight charges', 'weight charge', 'handling', 'other charges'],
  wht:     ['withholding income tax', 'wht', 'w.h.t', 'income tax', 'wh income tax',
            'withholding tax', 'tax deducted'],
  wst:     ['withholding sale tax', 'withholding sales tax', 'wst', 'sales tax',
            'sale tax', 'gst', 'st withheld']
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
  const limit = Math.min(grid.length, 15);
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

export function detectChargeColumns(header, saved) {
  const pick = key => {
    if (saved && saved[key] !== undefined && saved[key] !== null && saved[key] >= 0) {
      return saved[key];
    }
    return headerIndex(header, HINTS[key]);
  };
   return {
    cpr:      pick('cpr'),
    cprDate:  pick('cprDate'),
    charges:  pick('charges'),
        charges2: pick('charges2'),      // couriers split the charge across
    charges3: pick('charges3'),      // as many as three columns
    wht:      pick('wht'),
    wst:      pick('wst')
  };
}

/* ==================== reading the sheet ==================== */

// A row that only carries a word like Total is a summary line, not data.
// We add the rows up ourselves and never trust a total someone typed.
function looksLikeTotal(cells) {
  const words = cells.map(c => clean(c).toLowerCase()).filter(Boolean);
  if (!words.length) return false;
  return words.some(w => /^(grand\s+)?total\b/.test(w) && w.length < 22);
}

export async function loadCharges(sheetId, tab, excel, saved) {
  const grid = await readTab(sheetId, tab, excel);
  if (!grid.length) throw new Error('That tab is empty');

  const hRow = findHeaderRow(grid);
  const header = (grid[hRow] || []).map(h => clean(h));
  const cols = detectChargeColumns(header, saved);

  const groups = new Map();
  let skippedTotals = 0;

  for (let r = hRow + 1; r < grid.length; r++) {
    const raw = grid[r] || [];
    if (!raw.filter(x => clean(x)).length) continue;

    if (looksLikeTotal(raw)) { skippedTotals++; continue; }

    const cprNumber = cols.cpr >= 0 ? clean(raw[cols.cpr]) : '';
    const key = cprNumber || '(no CPR number)';

    if (!groups.has(key)) {
      groups.set(key, {
        cprNumber,
        cprDate: null,
        rows: 0,
        charges: 0,
        wht: 0,
        wst: 0,
        sample: []
      });
    }

    const g = groups.get(key);
           // the delivery charge can sit in one column or be split across three
    const charges = (cols.charges  >= 0 ? num(raw[cols.charges])  : 0) +
                    (cols.charges2 >= 0 ? num(raw[cols.charges2]) : 0) +
                    (cols.charges3 >= 0 ? num(raw[cols.charges3]) : 0);
    const wht     = cols.wht     >= 0 ? num(raw[cols.wht])     : 0;
    const wst     = cols.wst     >= 0 ? num(raw[cols.wst])     : 0;

    g.rows++;
    g.charges += charges;
    g.wht += wht;
    g.wst += wst;

    if (!g.cprDate && cols.cprDate >= 0) {
      const d = toISO(raw[cols.cprDate]);
      if (d) g.cprDate = d;
    }

    // a few rows kept back so the page can show what was read
    if (g.sample.length < 5) {
      g.sample.push({ sheetRow: r + 1, charges, wht, wst });
    }
  }

  const list = [...groups.values()].map(g => ({
    cprNumber: g.cprNumber,
    key: g.cprNumber || '(no CPR number)',
    cprDate: g.cprDate,
    rows: g.rows,
    charges: Math.round(g.charges * 100) / 100,
    wht: Math.round(g.wht * 100) / 100,
    wst: Math.round(g.wst * 100) / 100,
    total: Math.round((g.charges + g.wht + g.wst) * 100) / 100,
    sample: g.sample
  })).sort((a, b) => (b.cprDate || '').localeCompare(a.cprDate || ''));

  return { header, cols, headerRow: hRow + 1, cprs: list, skippedTotals };
}

/* ==================== the QuickBooks side ==================== */

// every account a journal line could point at
export async function listAllAccounts(realmId, token) {
  const out = [];
  let start = 1;

  while (true) {
    const q = await qbQuery(realmId, token,
      `SELECT Id, Name, AccountType, AccountSubType, FullyQualifiedName ` +
      `FROM Account WHERE Active = true STARTPOSITION ${start} MAXRESULTS 1000`);
    const arr = q.Account || [];
    arr.forEach(a => out.push({
      id: a.Id,
      name: a.FullyQualifiedName || a.Name,
      type: a.AccountType,
      sub: a.AccountSubType || ''
    }));
    if (arr.length < 1000) break;
    start += 1000;
    if (start > 5000) break;
  }

  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// has this CPR already been journalled? DocNumber carries the CPR number
export async function findJournal(realmId, token, cprNumber) {
  const ref = String(cprNumber || '').replace(/'/g, "\\'");
  if (!ref) return null;

  const q = await qbQuery(realmId, token,
    `SELECT Id, DocNumber, TxnDate, TotalAmt FROM JournalEntry ` +
    `WHERE DocNumber = '${ref}' MAXRESULTS 5`);

  const j = (q.JournalEntry || [])[0];
  if (!j) return null;

  return {
    id: j.Id,
    doc: j.DocNumber,
    date: j.TxnDate,
    amount: Number(j.TotalAmt || 0)
  };
}

export async function postJournal(realmId, token, payload) {
  const r = await fetch(`${API}/v3/company/${realmId}/journalentry?minorversion=70`, {
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
      if (f && f.Error && f.Error.length) {
        msg = `${f.Error[0].Message || ''} | ${f.Error[0].Detail || ''}`.trim();
      }
    } catch (e) {}
    return { ok: false, msg, tid };
  }

  const body = JSON.parse(text);
  return { ok: true, id: body.JournalEntry ? body.JournalEntry.Id : null, tid };
}
