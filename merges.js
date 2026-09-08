// Shopify exports for a whole month, read together, looking for orders that went
// to the same person. Those are the parcels the courier merges into one booking,
// so their order numbers end up in a single cell of the CPR sheet - and that is
// what tells us which ones to expect there.
//
// Nothing here touches QuickBooks. It reads uploaded files, groups them, and
// then holds the groups up against one CPR sheet.

import XLSX from 'xlsx';
import { clean, num, digitsOf, toISO, loadSheet } from './cpr.js';

/* ==================== what a customer looks like ==================== */

// spelling and punctuation wander from order to order, so everything is
// flattened before two values are called the same
const normName = s => clean(s).toLowerCase().replace(/[^a-z ]+/g, ' ')
  .replace(/\s+/g, ' ').trim();

const normAddr = s => clean(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ')
  .replace(/\s+/g, ' ').trim();

const normEmail = s => clean(s).toLowerCase();

// 0300-1234567, +92 300 1234567 and 923001234567 are one phone
export function normPhone(s) {
  let d = String(s ?? '').replace(/[^0-9]/g, '');
  if (d.length > 10) d = d.slice(-10);
  return d.length >= 7 ? d : '';
}

/* ==================== reading the uploaded files ==================== */

const HINTS = {
  order:    { exact: ['name', 'order', 'order name', 'order number', 'order no', 'order id',
                      'order #', '#', 'invoice no', 'invoice number'],
              like:  ['order number', 'order id', 'order name', 'order #'] },
  customer: { exact: ['shipping name', 'billing name', 'customer name', 'recipient name',
                      'consignee name', 'consignee', 'customer'],
              like:  ['shipping name', 'billing name', 'customer name'] },
  phone:    { exact: ['shipping phone', 'phone', 'billing phone', 'customer phone',
                      'mobile', 'mobile number', 'contact number', 'contact no'],
              like:  ['shipping phone', 'phone', 'mobile', 'contact'] },
  email:    { exact: ['email', 'contact email', 'customer email', 'shipping email'],
              like:  ['email'] },
  address:  { exact: ['shipping address1', 'shipping address 1', 'shipping street',
                      'shipping address', 'address1', 'address 1', 'address'],
              like:  ['shipping address', 'address1', 'address'] },
  address2: { exact: ['shipping address2', 'shipping address 2', 'address2', 'address 2'],
              like:  ['address2'] },
  city:     { exact: ['shipping city', 'city', 'town'], like: ['city'] },
  total:    { exact: ['total', 'order total', 'total price', 'amount', 'cod amount', 'grand total'],
              like:  ['total', 'amount'] },
  date:     { exact: ['created at', 'paid at', 'order date', 'date'],
              like:  ['created at', 'order date'] }
};

function findCol(header, key, taken) {
  const low = header.map(h => clean(h).toLowerCase());
  const free = i => i >= 0 && !taken.has(i);
  for (const want of HINTS[key].exact) {
    const i = low.indexOf(want);
    if (free(i)) return i;
  }
  for (const want of HINTS[key].like) {
    const i = low.findIndex(h => h && h.includes(want));
    if (free(i)) return i;
  }
  return -1;
}

export function detectColumns(header) {
  const taken = new Set();
  const cols = {};
  // order first - in a Shopify export "Name" is the order, "Shipping Name" the buyer
  ['order', 'customer', 'phone', 'email', 'address', 'address2', 'city', 'total', 'date']
    .forEach(key => {
      const i = findCol(header, key, taken);
      cols[key] = i;
      if (i >= 0) taken.add(i);
    });
  return cols;
}

// the header is not always the first line - pick the line that knows the most words
function findHeaderRow(grid) {
  const limit = Math.min(grid.length, 12);
  let best = 0, bestScore = -1;
  for (let r = 0; r < limit; r++) {
    const row = (grid[r] || []).map(x => clean(x).toLowerCase());
    if (!row.filter(Boolean).length) continue;
    let score = 0;
    Object.keys(HINTS).forEach(key => {
      const h = HINTS[key];
      if (row.some(c => h.exact.includes(c) || h.like.some(w => c.includes(w)))) score++;
    });
    score += Math.min(row.filter(Boolean).length, 12) / 100;
    if (score > bestScore) { bestScore = score; best = r; }
  }
  return best;
}

const MAX_ROWS = 300000;

// one uploaded file - its header and its lines, every tab in it stacked up
export function readFile(name, buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', raw: false, cellDates: false });
  let header = [];
  const rows = [];

  for (const sheetName of wb.SheetNames) {
    const grid = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], {
      header: 1, raw: false, defval: '', blankrows: false
    });
    if (!grid.length) continue;

    const hRow = findHeaderRow(grid);
    const head = (grid[hRow] || []).map(h => clean(h));

    // a second tab only joins in if it carries the same columns
    if (!header.length) header = head;
    else if (head.join('|').toLowerCase() !== header.join('|').toLowerCase()) continue;

    for (let r = hRow + 1; r < grid.length; r++) {
      const raw = grid[r] || [];
      if (!raw.filter(x => clean(x)).length) continue;
      rows.push({ sheetRow: r + 1, cells: raw });
      if (rows.length > MAX_ROWS) throw new Error(name + ' is too big to read in one go');
    }
  }

  if (!header.length) throw new Error(name + ' has no readable rows');
  return { name, header, rows, cols: detectColumns(header) };
}

/* ==================== files to one order per line ==================== */

// Shopify writes one line per product, and only the first line of an order
// carries the buyer's details - so the lines are folded back into orders and
// the first thing said about each field is kept.
export function buildOrders(files) {
  const byOrder = new Map();

  files.forEach(f => {
    const c = f.cols || {};
    if (!(c.order >= 0)) return;

    f.rows.forEach(r => {
      const cell = i => (i >= 0 ? clean(r.cells[i]) : '');
      const orderRaw = cell(c.order);
      if (!orderRaw) return;
      if (/^(grand )?total$/i.test(orderRaw)) return;

      const key = f.name + ' ' + orderRaw.toUpperCase();
      if (!byOrder.has(key)) {
        byOrder.set(key, {
          file: f.name,
          order: orderRaw,
          digits: digitsOf(orderRaw),
          sheetRow: r.sheetRow,
          customer: '', address: '', phone: '', email: '',
          total: 0, date: null, lines: 0
        });
      }
      const o = byOrder.get(key);
      o.lines++;

      const addr = [cell(c.address), cell(c.address2), cell(c.city)]
        .filter(Boolean).join(', ');

      if (!o.customer) o.customer = cell(c.customer);
      if (!o.address)  o.address  = addr;
      if (!o.phone)    o.phone    = cell(c.phone);
      if (!o.email)    o.email    = cell(c.email);
      if (!o.total)    o.total    = num(cell(c.total));
      if (!o.date)     o.date     = toISO(cell(c.date));
    });
  });

  return Array.from(byOrder.values()).map(o => Object.assign(o, {
    keys: {
      name:  normName(o.customer),
      addr:  normAddr(o.address),
      phone: normPhone(o.phone),
      email: normEmail(o.email)
    }
  }));
}

/* ==================== grouping ==================== */

const FIELDS = ['name', 'addr', 'phone', 'email'];
const LABEL  = { name: 'name', addr: 'address', phone: 'phone', email: 'email' };

function combos(list, k) {
  if (k === 0) return [[]];
  if (k > list.length) return [];
  const [first, ...rest] = list;
  return combos(rest, k - 1).map(c => [first].concat(c)).concat(combos(rest, k));
}

function finder(n) {
  const parent = new Array(n).fill(0).map((_, i) => i);
  const find = i => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  return {
    find,
    union(a, b) {
      const ra = find(a), rb = find(b);
      if (ra === rb) return false;
      parent[rb] = ra;
      return true;
    }
  };
}

// The strictest reading first: all four details the same. Then any three of
// them, then any two. `minFields` says how far down to go.
export function groupOrders(orders, minFields) {
  const floor = Math.max(2, Math.min(4, Number(minFields) || 4));
  const uf = finder(orders.length);
  const joinTier = new Array(orders.length).fill(0);

  for (let k = 4; k >= floor; k--) {
    combos(FIELDS, k).forEach(set => {
      const buckets = new Map();
      orders.forEach((o, i) => {
        if (set.some(f => !o.keys[f])) return;       // a blank never matches
        const key = set.map(f => o.keys[f]).join('');
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(i);
      });
      buckets.forEach(idx => {
        if (idx.length < 2) return;
        for (let j = 1; j < idx.length; j++) uf.union(idx[0], idx[j]);
        idx.forEach(i => { joinTier[i] = Math.max(joinTier[i], k); });
      });
    });
  }

  const bags = new Map();
  orders.forEach((o, i) => {
    const root = uf.find(i);
    if (!bags.has(root)) bags.set(root, []);
    bags.get(root).push(i);
  });

  const groups = [];
  bags.forEach(idx => {
    if (idx.length < 2) return;
    const members = idx.map(i => orders[i]);
    const first = members[0];

    // what the whole group actually agrees on, not just the pair that joined it
    const agree = FIELDS.filter(f =>
      first.keys[f] && members.every(m => m.keys[f] === first.keys[f]));

    groups.push({
      tier: Math.max.apply(null, idx.map(i => joinTier[i])),
      agree: agree.map(f => LABEL[f]),
      agreeCount: agree.length,
      customer: first.customer,
      address: first.address,
      phone: first.phone,
      email: first.email,
      total: Math.round(members.reduce((s, m) => s + (m.total || 0), 0) * 100) / 100,
      orders: members.map(m => ({
        order: m.order, digits: m.digits, file: m.file, sheetRow: m.sheetRow,
        customer: m.customer, address: m.address, phone: m.phone, email: m.email,
        total: Math.round((m.total || 0) * 100) / 100, date: m.date
      })).sort((a, b) => a.order.localeCompare(b.order, undefined, { numeric: true }))
    });
  });

  groups.sort((a, b) =>
    b.agreeCount - a.agreeCount || b.orders.length - a.orders.length ||
    String(a.customer).localeCompare(String(b.customer)));

  groups.forEach((g, i) => { g.id = i + 1; });
  return groups;
}

/* ==================== holding the groups up to a CPR ==================== */

// Where each group's orders sit in one courier sheet: already written in a
// single cell, spread over several rows, or only partly there.
export async function matchGroupsToSheet(groups, opts) {
  const { sheetId, tab, excel, saved, cpr } = opts;
  const data = await loadSheet(sheetId, tab, excel, saved);

  let rows = data.rows;
  if (cpr) rows = rows.filter(r => (r.cprNumber || '(no CPR number)') === cpr);

  return Object.assign(placeGroups(groups, rows, cpr), { headerRow: data.headerRow });
}

export function placeGroups(groups, rows, cpr) {
  // every order number in the sheet, pointing back at the row it was written on
  const rowOf = new Map();
  rows.forEach(r => (r.invoices || []).forEach(n => {
    const d = digitsOf(n);
    if (d && !rowOf.has(d)) rowOf.set(d, r);
  }));

  const merged = [], spread = [], partial = [], absent = [];

  groups.forEach(g => {
    const hits = g.orders.map(o => ({ order: o.order, row: rowOf.get(o.digits) || null }));
    const found = hits.filter(h => h.row);

    if (!found.length) {
      absent.push({ id: g.id, customer: g.customer, orders: g.orders.map(o => o.order) });
      return;
    }

    const cells = [...new Set(found.map(h => h.row.sheetRow))].sort((a, b) => a - b);
    const sheetAmount = Math.round(cells
      .map(n => (found.find(h => h.row.sheetRow === n).row.amount || 0))
      .reduce((s, a) => s + a, 0) * 100) / 100;

    const entry = {
      id: g.id,
      tier: g.tier,
      agree: g.agree,
      customer: g.customer,
      phone: g.phone,
      address: g.address,
      shopifyTotal: g.total,
      sheetAmount,
      cprNumber: found[0].row.cprNumber || '',
      cells,
      found: found.map(h => ({
        order: h.order, sheetRow: h.row.sheetRow,
        cell: h.row.invoice, amount: h.row.amount,
        cprNumber: h.row.cprNumber || '', merged: !!h.row.merged
      })),
      missing: hits.filter(h => !h.row).map(h => h.order)
    };

    if (entry.missing.length) partial.push(entry);
    else if (cells.length === 1) merged.push(entry);
    else spread.push(entry);
  });

  return {
    cpr: cpr || '',
    sheetRows: rows.length,
    totals: {
      groups: groups.length,
      merged: merged.length,
      spread: spread.length,
      partial: partial.length,
      absent: absent.length
    },
    merged, spread, partial, absent
  };
}
