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
//     already holds, a missing name, a quantity on a product that does not
//     carry stock - and those are said on the screen, in the row, in advance.
//   - What is written is written one item at a time, each one saying whether it
//     took, so a list of four hundred does not fail as one thing.
//
// Nothing here guesses an account. QuickBooks needs three of them for a product
// that carries stock, and which three is a decision about this company's books,
// so it is asked once on the screen and then used for every row.

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

/* ==================== the accounts a product sits on ==================== */

// Three lists, and QuickBooks' own usual choice marked in each. A company that
// has renamed its accounts gets the list and picks; one that has not finds the
// right three already chosen.
export async function listItemAccounts(realmId, token) {
  const q = await qbQuery(realmId, token,
    `SELECT Id, Name, AccountType, AccountSubType FROM Account
      WHERE Active = true
        AND AccountType IN ('Income', 'Cost of Goods Sold', 'Other Current Asset')
      MAXRESULTS 500`);

  const all = (q.Account || []).map(a => ({
    id: String(a.Id), name: a.Name || '',
    type: a.AccountType || '', sub: a.AccountSubType || ''
  }));

  const pick = (rows, usual) => {
    const list = rows.slice().sort((a, b) => a.name.localeCompare(b.name));
    const first = list.filter(r => usual.test(r.name))[0];
    return { list, usual: first ? first.id : (list[0] ? list[0].id : '') };
  };

  return {
    income: pick(all.filter(a => a.type === 'Income'), /sales of product income/i),
    cogs:   pick(all.filter(a => a.type === 'Cost of Goods Sold'), /cost of goods sold/i),
    // an Other Current Asset that is not the stock account would be a strange
    // place to put stock, and QuickBooks names its own one the same way
    // everywhere, so that is the one reached for
    asset:  pick(all.filter(a => a.sub === 'Inventory' || /inventory asset/i.test(a.name)), /inventory asset/i)
  };
}

/* ==================== what is already there ==================== */

const flat = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const code = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

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
      const row = { id: String(it.Id), name: it.Name || '', sku: it.Sku || '', active: it.Active !== false };
      if (row.name) byName.set(flat(row.name), row);
      if (row.sku) bySku.set(code(row.sku), row);
    });
    if (arr.length < 1000) break;
    start += 1000;
    if (start > 40000) break;
  }

  return { byName, bySku, count };
}

/* ==================== reading a list off a file ==================== */

// What a column is likely to be, by what it is called. A header this does not
// know is left for the person to say, and nothing is guessed twice: a column
// already spoken for cannot be guessed again.
const HEADERS = {
  name:    [/^(item|product)?\s*name$/i, /^title$/i, /^product$/i, /^item$/i, /^description of product$/i],
  sku:     [/^sku$/i, /^code$/i, /^item\s*code$/i, /^product\s*code$/i, /^barcode$/i, /^article$/i],
  desc:    [/^desc/i, /^detail/i, /^sales\s*desc/i],
  price:   [/^(unit\s*)?price$/i, /^sale[s]?\s*price$/i, /^rate$/i, /^mrp$/i, /^retail$/i],
  cost:    [/^cost$/i, /^purchase\s*cost$/i, /^buying\s*(price|cost)$/i, /^landed\s*cost$/i],
  qty:     [/^(qty|quantity)/i, /^stock$/i, /^opening\s*(qty|stock|balance)$/i, /^on\s*hand$/i]
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
    for (let i = 0; i < headers.length; i++) {
      if (taken[i]) continue;
      if (HEADERS[field].some(re => re.test(headers[i]))) {
        map[field] = i;
        taken[i] = true;
        return;
      }
    }
    map[field] = -1;
  });

  return map;
}

/* ==================== what will happen ==================== */

const money = v => {
  const n = Number(String(v == null ? '' : v).replace(/[^\d.\-]/g, ''));
  return isFinite(n) ? Math.round(n * 100) / 100 : 0;
};

// Every row, said out loud before anything is written: what it will be called,
// what it will carry, and - where it will not be made at all - why not.
export function planRows(rows, map, opts, existing) {
  const kind = TYPES[opts.type] ? opts.type : 'Inventory';
  const at = (r, f) => (map[f] >= 0 ? r[map[f]] : '');

  const seenName = new Map();
  const seenSku = new Map();

  return rows.map((r, i) => {
    const name = String(at(r, 'name') || '').trim();
    const sku = String(at(r, 'sku') || '').trim();

    const out = {
      at: i + 1,
      name, sku,
      desc: String(at(r, 'desc') || '').trim(),
      price: money(at(r, 'price')),
      cost: money(at(r, 'cost')),
      qty: kind === 'Inventory' ? money(at(r, 'qty')) : 0,
      make: true, why: ''
    };

    const stop = why => { out.make = false; out.why = why; };

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

export async function createItem(realmId, token, row, opts) {
  const kind = TYPES[opts.type] ? opts.type : 'Inventory';
  const name = String(row.name || '').trim();
  if (!name) throw new Error('A product needs a name');

  const body = {
    Name: name,
    Type: kind,
    Active: true
  };

  if (row.sku) body.Sku = String(row.sku).trim();

  // One wording, written to both sides. QuickBooks keeps a selling description
  // and a buying one, and a product whose bill says nothing while its invoice
  // says everything is the thing people complain about on the purchases page.
  if (row.desc) {
    body.Description = String(row.desc).trim();
    body.PurchaseDesc = String(row.desc).trim();
  }

  if (row.price) body.UnitPrice = Number(row.price);
  if (row.cost) body.PurchaseCost = Number(row.cost);

  body.IncomeAccountRef = { value: String(opts.incomeId) };

  if (kind === 'Inventory') {
    body.ExpenseAccountRef = { value: String(opts.cogsId) };
    body.AssetAccountRef = { value: String(opts.assetId) };
    body.TrackQtyOnHand = true;
    // QuickBooks will not take an inventory item without both of these, and the
    // date it starts from decides which months the stock shows up in
    body.QtyOnHand = Number(row.qty || 0);
    body.InvStartDate = String(opts.startDate || '').slice(0, 10);
    if (!body.InvStartDate) throw new Error('Say the date the stock starts from');
  } else if (opts.cogsId) {
    // not stock, but still something that was bought
    body.ExpenseAccountRef = { value: String(opts.cogsId) };
  }

  const made = await qbPost(realmId, token, body);

  return {
    id: String(made.Id || ''),
    name: made.Name || name,
    sku: made.Sku || row.sku || '',
    type: made.Type || kind
  };
}
