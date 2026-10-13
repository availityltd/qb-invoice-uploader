// Putting products into QuickBooks - one at a time, or a list of them at once.
//
// This is the one piece of work in this app that makes something in the books
// that was not there before, rather than correcting something that was. An item
// made wrong is not a wrong screen: it is a product that sells at no cost, or
// stock sitting in the wrong account, and it is found months later by somebody
// reading a gross profit that makes no sense.
//
// So the shape of this is: say what will happen, then do it.
//
//   - A list is read and lined up against what QuickBooks already has, by name
//     and by code, BEFORE anything is written. A row that would clash is shown
//     as a row that will be left alone, not discovered halfway through a run.
//   - Every row is checked for the things QuickBooks will refuse - a name it
//     already holds, a missing name, an account it does not have - and those
//     are said on the screen, in the row, in advance.
//   - What is written is written one item at a time, each one saying whether it
//     took, so a list of four hundred does not fail as one thing.
//
// The list people actually have is QuickBooks' own Products and Services import
// sheet, and it already says everything: the type of each row, the accounts by
// name, the date the stock counts from. So those are read off the row and used,
// and what is chosen on the screen is only what a row leaves out.

import { qbQuery } from './qb.js';
import XLSX from 'xlsx';

const API = 'https://quickbooks.api.intuit.com';

export const TYPES = {
  Inventory:    { key: 'Inventory',    label: 'Inventory — stock is counted and costed',
                  needs: ['income', 'cogs', 'asset'] },
  NonInventory: { key: 'NonInventory', label: 'Non-inventory — bought and sold, no stock kept',
                  needs: ['income'] },
  Service:      { key: 'Service',      label: 'Service — nothing physical',
                  needs: ['income'] }
};

// "Non-inventory", "Non inventory", "noninventory" are one thing written three
// ways, and QuickBooks' own sheet writes the first of them.
export function readType(v, fallback) {
  const t = String(v || '').toLowerCase().replace(/[^a-z]/g, '');
  if (t === 'inventory') return 'Inventory';
  if (t === 'noninventory') return 'NonInventory';
  if (t === 'service') return 'Service';
  return TYPES[fallback] ? fallback : 'Inventory';
}

/* ==================== the accounts a product sits on ==================== */

const flat = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const code = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

export async function readAccounts(realmId, token) {
  const q = await qbQuery(realmId, token,
    `SELECT Id, Name, FullyQualifiedName, AccountType, AccountSubType FROM Account
      WHERE Active = true MAXRESULTS 1000`);

  const all = (q.Account || []).map(a => ({
    id: String(a.Id),
    name: a.Name || '',
    full: a.FullyQualifiedName || a.Name || '',
    type: a.AccountType || '',
    sub: a.AccountSubType || ''
  }));

  // by name and by the full "Parent:Child" name, because the sheet may write
  // either one
  const by = new Map();
  all.forEach(a => {
    if (!by.has(flat(a.name))) by.set(flat(a.name), []);
    by.get(flat(a.name)).push(a);
    if (flat(a.full) !== flat(a.name)) {
      if (!by.has(flat(a.full))) by.set(flat(a.full), []);
      by.get(flat(a.full)).push(a);
    }
  });

  return { all, by };
}

const WANTS = {
  income: a => a.type === 'Income',
  cogs:   a => a.type === 'Cost of Goods Sold' || a.type === 'Expense' || a.type === 'Other Expense',
  asset:  a => a.sub === 'Inventory' || a.type === 'Other Current Asset'
};

// A name off the sheet, turned into the account it means - or into the reason
// it could not be. A name that matches an account of the wrong kind is not a
// near miss to be quietly accepted: income booked to an asset is a wrong set of
// books that balances.
export function findAccount(accounts, name, want) {
  const asked = flat(name);
  if (!asked) return { id: '', why: '' };

  const rows = accounts.by.get(asked) || [];
  if (!rows.length) return { id: '', why: 'There is no account called "' + name + '"' };

  const fit = rows.filter(WANTS[want] || (() => true));
  if (!fit.length) {
    return { id: '', why: '"' + name + '" is a ' + rows[0].type + ' account, which is not where that belongs' };
  }

  return { id: fit[0].id, why: '' };
}

// Three lists for the screen, with QuickBooks' own usual choice marked in each.
export function itemAccountLists(accounts) {
  const pick = (ok, usual) => {
    const list = accounts.all.filter(ok).sort((a, b) => a.full.localeCompare(b.full));
    const first = list.filter(r => usual.test(r.name))[0];
    return {
      list: list.map(a => ({ id: a.id, name: a.full })),
      usual: first ? first.id : (list[0] ? list[0].id : '')
    };
  };

  return {
    income: pick(WANTS.income, /^sales$|sales of product income/i),
    cogs:   pick(a => a.type === 'Cost of Goods Sold', /cost of (sales|goods sold)/i),
    asset:  pick(WANTS.asset, /^inventory( asset)?$/i)
  };
}

/* ==================== what is already there ==================== */

// Everything QuickBooks holds, by name and by code. Both matter: a name it
// already has is refused outright, and a code it already has is almost always
// the same product being made a second time - which is the duplicate this app
// spends a whole page cleaning up afterwards.
export async function readExisting(realmId, token) {
  const byName = new Map();
  const bySku = new Map();
  let count = 0;
  let start = 1;

  while (true) {
    const q = await qbQuery(realmId, token,
      `SELECT * FROM Item WHERE Active IN (true, false) STARTPOSITION ${start} MAXRESULTS 1000`);
    const arr = q.Item || [];
    arr.forEach(it => {
      count++;
      const row = { id: String(it.Id), name: it.FullyQualifiedName || it.Name || '',
                    sku: it.Sku || '', active: it.Active !== false };
      if (row.name) byName.set(flat(row.name), row);
      if (it.Name) byName.set(flat(it.Name), row);
      if (row.sku) bySku.set(code(row.sku), row);
    });
    if (arr.length < 1000) break;
    start += 1000;
    if (start > 40000) break;
  }

  return { byName, bySku, count };
}

/* ==================== reading a list off a file ==================== */

// What a column is, by what it is called. The first pattern of each is the
// heading QuickBooks' own Products and Services sheet uses, so that sheet needs
// nothing changed; the rest are what a list written by hand tends to say.
const HEADERS = {
  name:     [/^product\/?\s*service\s*name$/i, /^(item|product)?\s*name$/i, /^title$/i, /^product$/i, /^item$/i],
  desc:     [/^sales\s*desc/i, /^desc/i, /^detail/i],
  sku:      [/^sku$/i, /^code$/i, /^item\s*code$/i, /^product\s*code$/i, /^barcode$/i, /^article$/i],
  type:     [/^type$/i, /^item\s*type$/i, /^product\s*type$/i],
  price:    [/^sales\s*price\s*\/?\s*rate$/i, /^(unit\s*)?price$/i, /^sale[s]?\s*price$/i, /^rate$/i, /^mrp$/i, /^retail$/i],
  income:   [/^income\s*account$/i],
  pdesc:    [/^purchase\s*desc/i],
  cost:     [/^purchase\s*cost$/i, /^cost$/i, /^buying\s*(price|cost)$/i, /^landed\s*cost$/i],
  expense:  [/^expense\s*account$/i, /^cost\s*of\s*(sales|goods)/i],
  qty:      [/^quantity\s*on\s*hand$/i, /^(qty|quantity)\b/i, /^stock$/i, /^opening\s*(qty|stock|balance)$/i, /^on\s*hand$/i],
  reorder:  [/^reorder\s*point$/i],
  asset:    [/^inventory\s*asset\s*account$/i, /^asset\s*account$/i],
  asOf:     [/^quantity\s*as[\s-]*of\s*date$/i, /^as[\s-]*of\s*date$/i, /^(start|opening)\s*date$/i]
};

export function parseList(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', raw: false, cellDates: false });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) throw new Error('There is no sheet in that file');

  const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });

  // the first row that has more than one thing written across it is the header;
  // a title typed above the table is not
  let at = 0;
  while (at < grid.length && grid[at].filter(c => String(c).trim()).length < 2) at++;
  if (at >= grid.length) throw new Error('Nothing in that file reads like a table');

  const headers = grid[at].map(h => String(h == null ? '' : h).trim());
  const rows = grid.slice(at + 1)
    .filter(r => r.some(c => String(c).trim()))
    .map(r => headers.map((_, i) => String(r[i] == null ? '' : r[i]).trim()));

  return { sheet: wb.SheetNames[0], headers, rows };
}

export function guessColumns(headers) {
  const map = {};
  const taken = {};

  Object.keys(HEADERS).forEach(field => {
    map[field] = -1;
    for (let i = 0; i < headers.length; i++) {
      if (taken[i]) continue;
      if (HEADERS[field].some(re => re.test(headers[i]))) {
        map[field] = i;
        taken[i] = true;
        return;
      }
    }
  });

  return map;
}

/* ==================== reading what is in a cell ==================== */

const money = v => {
  const n = Number(String(v == null ? '' : v).replace(/[^\d.\-]/g, ''));
  return isFinite(n) ? Math.round(n * 100) / 100 : 0;
};

const MONTHS = 'jan feb mar apr may jun jul aug sep oct nov dec'.split(' ');

// A date as a sheet writes one. Where the two halves cannot be told apart -
// 1/1/2026, 5/6/2026 - the month is taken first, which is the order QuickBooks'
// own sheet is written in. The plan shows the date it read in words, so an order
// read the wrong way round is visible before anything is written rather than
// after a month has moved.
export function readDate(v) {
  const s = String(v || '').trim();
  if (!s) return { date: '', sure: true };

  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return { date: iso(+m[1], +m[2], +m[3]), sure: true };

  m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/);
  if (m) {
    let a = +m[1], b = +m[2];
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    if (a > 12 && b <= 12) return { date: iso(y, b, a), sure: true };   // only one way to read it
    if (b > 12 && a <= 12) return { date: iso(y, a, b), sure: true };
    return { date: iso(y, a, b), sure: a === b };                        // month first
  }

  const d = new Date(s);
  if (!isNaN(d.getTime())) return { date: iso(d.getFullYear(), d.getMonth() + 1, d.getDate()), sure: true };

  return { date: '', sure: false, bad: true };
}

function iso(y, m, d) {
  if (!(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return '';
  const p = n => (n < 10 ? '0' : '') + n;
  return y + '-' + p(m) + '-' + p(d);
}

export function dateInWords(ymd) {
  const m = String(ymd || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return '';
  return Number(m[3]) + ' ' + MONTHS[Number(m[2]) - 1].replace(/^./, c => c.toUpperCase()) + ' ' + m[1];
}

/* ==================== what will happen ==================== */

// Every row, said out loud before anything is written: what it will be called,
// what it will carry, which accounts it will sit on, and - where it will not be
// made at all - why not.
export function planRows(rows, map, opts, existing, accounts) {
  const at = (r, f) => (map[f] >= 0 ? r[map[f]] : '');

  const seenName = new Map();
  const seenSku = new Map();

  return rows.map((r, i) => {
    const name = String(at(r, 'name') || '').trim();
    const sku = String(at(r, 'sku') || '').trim();
    const kind = readType(at(r, 'type'), opts.type);

    const sales = String(at(r, 'desc') || '').trim();
    const buys = String(at(r, 'pdesc') || '').trim();

    const when = readDate(at(r, 'asOf'));

    const out = {
      at: i + 1,
      name, sku, type: kind,
      desc: sales || buys,
      pdesc: buys || sales,
      price: money(at(r, 'price')),
      cost: money(at(r, 'cost')),
      qty: kind === 'Inventory' ? money(at(r, 'qty')) : 0,
      reorder: map.reorder >= 0 && String(at(r, 'reorder')).trim() !== '' ? money(at(r, 'reorder')) : null,
      startDate: when.date || opts.startDate || '',
      dateSaid: '',
      dateSure: when.sure,
      incomeId: '', cogsId: '', assetId: '',
      make: true, why: ''
    };

    out.dateSaid = dateInWords(out.startDate);

    const stop = why => { if (out.make) { out.make = false; out.why = why; } };

    /* ---- the name, which is the one thing QuickBooks will not do without ---- */
    if (!name && !sku) stop('Nothing on this row');
    else if (!name) stop('No name — QuickBooks will not make a product without one');
    else if (name.length > 100) stop('That name is longer than QuickBooks allows (100 letters)');
    else if (/:/.test(name)) stop('A colon in a name is how QuickBooks writes a sub-item, so it cannot be in one');
    else if (existing.byName.has(flat(name))) stop('QuickBooks already has a product with that name');
    else if (sku && existing.bySku.has(code(sku))) {
      stop('That code is already on ' + existing.bySku.get(code(sku)).name);
    }
    else if (seenName.has(flat(name))) stop('The same name is on row ' + seenName.get(flat(name)) + ' of this list');
    else if (sku && seenSku.has(code(sku))) stop('The same code is on row ' + seenSku.get(code(sku)) + ' of this list');

    /* ---- the accounts: the sheet's own where it names them ---- */
    const pick = (field, want, fallback, what) => {
      const named = String(at(r, field) || '').trim();
      if (named) {
        const found = findAccount(accounts, named, want);
        if (found.id) return found.id;
        stop(found.why);
        return '';
      }
      if (fallback) return fallback;
      stop('No ' + what + ' on this row, and none chosen above');
      return '';
    };

    out.incomeId = pick('income', 'income', opts.incomeId, 'income account');
    if (kind === 'Inventory') {
      out.cogsId = pick('expense', 'cogs', opts.cogsId, 'cost of sales account');
      out.assetId = pick('asset', 'asset', opts.assetId, 'account for the stock');
      if (when.bad) stop('The date on this row could not be read');
      else if (!out.startDate) stop('No date for the stock to start from, and none chosen above');
    } else {
      // not stock, but still something that was bought
      const named = String(at(r, 'expense') || '').trim();
      if (named) {
        const found = findAccount(accounts, named, 'cogs');
        if (found.id) out.cogsId = found.id; else stop(found.why);
      } else {
        out.cogsId = opts.cogsId || '';
      }
    }

    if (out.make) {
      seenName.set(flat(name), i + 1);
      if (sku) seenSku.set(code(sku), i + 1);
    }

    return out;
  });
}

/* ==================== writing one ==================== */

async function qbPost(realmId, token, payload) {
  const res = await fetch(`${API}/v3/company/${realmId}/item?minorversion=70`, {
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
    throw new Error(f ? (f.Message + (f.Detail ? ' — ' + f.Detail : '')) : text.slice(0, 200));
  }

  return data.Item || {};
}

// `row` is a row the plan has already been through, so its accounts, its type
// and its date are decided. Nothing is worked out again here.
export async function createItem(realmId, token, row) {
  const kind = TYPES[row.type] ? row.type : 'Inventory';
  const name = String(row.name || '').trim();
  if (!name) throw new Error('A product needs a name');

  const body = { Name: name, Type: kind, Active: true };

  if (row.sku) body.Sku = String(row.sku).trim();

  // QuickBooks keeps a selling description and a buying one. A product whose
  // bill says nothing while its invoice says everything is the thing people
  // complain about on the purchases page, so both are written.
  if (row.desc) body.Description = String(row.desc).trim();
  if (row.pdesc) body.PurchaseDesc = String(row.pdesc).trim();

  if (row.price) body.UnitPrice = Number(row.price);
  if (row.cost) body.PurchaseCost = Number(row.cost);

  if (!row.incomeId) throw new Error('No income account for this one');
  body.IncomeAccountRef = { value: String(row.incomeId) };

  if (kind === 'Inventory') {
    if (!row.cogsId) throw new Error('No cost of sales account for this one');
    if (!row.assetId) throw new Error('No account for the stock of this one');
    if (!row.startDate) throw new Error('No date for the stock to start from');

    body.ExpenseAccountRef = { value: String(row.cogsId) };
    body.AssetAccountRef = { value: String(row.assetId) };
    body.TrackQtyOnHand = true;
    body.QtyOnHand = Number(row.qty || 0);
    body.InvStartDate = String(row.startDate).slice(0, 10);
    if (row.reorder !== null && row.reorder !== undefined && row.reorder !== '') {
      body.ReorderPoint = Number(row.reorder);
    }
  } else if (row.cogsId) {
    body.ExpenseAccountRef = { value: String(row.cogsId) };
  }

  const made = await qbPost(realmId, token, body);

  return {
    id: String(made.Id || ''),
    name: made.Name || name,
    sku: made.Sku || row.sku || '',
    type: made.Type || kind
  };
}
