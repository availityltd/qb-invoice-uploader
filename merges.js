// Shopify exports for a whole month, read together, looking for orders that went
// to the same person. Those are the parcels the courier merges into one booking,
// so their order numbers end up in a single cell of the CPR sheet - and that is
// what tells us which ones to expect there.
//
// Nothing here touches QuickBooks. It reads uploaded files, groups them, and
// then holds the groups up against CPR rows pasted straight out of the sheet.

import XLSX from 'xlsx';
import { StringDecoder } from 'string_decoder';
import { clean, num, digitsOf, toISO, splitInvoices } from './cpr.js';

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

// A month of orders is forty thousand of them and more. Reading such a file
// into a grid of rows, and then keeping that grid so a column can be changed
// later, is what runs a small server out of memory - the grid costs several
// times what the file does. So the file is walked through instead, a line at a
// time, and only what an order needs is kept. The bytes themselves are held on
// to, which is cheap, so changing a column reads them again rather than asking
// for the upload twice.

// A CSV walked through from the buffer, decoded a megabyte at a time so that
// nothing the size of the file is ever built. Fields are cut out of the text
// by their delimiters rather than gathered a character at a time - on a
// hundred thousand rows that is the difference between seconds and minutes.
function eachCsvRow(buf, cb) {
  const decoder = new StringDecoder('utf8');
  const CHUNK = 1 << 20;

  let carry = '';                 // a row the last chunk ended in the middle of
  let stop = false;

  // returns where it stopped: the start of whatever it could not finish
  const feed = (text, final) => {
    let i = 0;

    while (i < text.length) {
      const row = [];
      const rowStart = i;
      let done = false;

      while (true) {
        let field;

        if (text[i] === '"') {
          // a quoted field: "" stands for one quote, and a newline inside is
          // part of the address, not the end of the row
          let j = i + 1, parts = null, out = null;
          for (;;) {
            const k = text.indexOf('"', j);
            if (k < 0) return rowStart;                 // wants the next chunk
            if (text[k + 1] === '"') {
              (parts || (parts = [])).push(text.slice(j, k + 1));
              j = k + 2;
              continue;
            }
            const last = text.slice(j, k);
            out = parts ? parts.join('') + last : last;
            i = k + 1;
            break;
          }
          field = out;
        } else {
          const comma = text.indexOf(',', i);
          const line = text.indexOf('\n', i);
          let at = (comma < 0) ? line : (line < 0 ? comma : Math.min(comma, line));
          if (at < 0) {
            if (!final) return rowStart;
            at = text.length;
          }
          field = text.slice(i, at);
          i = at;
        }

        if (field.charCodeAt(field.length - 1) === 13) field = field.slice(0, -1);
        row.push(field);

        if (i >= text.length) {
          if (!final) return rowStart;
          done = true;
          break;
        }
        if (text[i] === ',') { i++; continue; }
        if (text[i] === '\r') i++;
        if (text[i] === '\n') { i++; done = true; break; }
        // a stray character after a closing quote - treat it as part of nothing
        i++;
      }

      if (done && cb(row) === false) { stop = true; return text.length; }
    }

    return i;
  };

  for (let at = 0; at < buf.length && !stop; at += CHUNK) {
    let text = decoder.write(buf.subarray(at, Math.min(at + CHUNK, buf.length)));
    if (at === 0) text = text.replace(/^\uFEFF/, '');
    text = carry + text;
    const used = feed(text, false);
    carry = text.slice(used);
  }

  if (!stop) {
    carry += decoder.end();
    if (carry.length) feed(carry, true);
  }
}

// Excel has to be built into a workbook before anything can be read out of it -
// there is no line at a time - so a big month is better exported as CSV.
function eachSheetRow(buf, cb) {
  const wb = XLSX.read(buf, { type: 'buffer', raw: false, cellDates: false });
  for (const name of wb.SheetNames) {
    const grid = XLSX.utils.sheet_to_json(wb.Sheets[name], {
      header: 1, raw: false, defval: '', blankrows: false
    });
    for (const row of grid) if (cb(row) === false) return;
  }
}

export function eachRow(file, cb) {
  if (!file.buffer) throw new Error(file.name + ' has been let go of - upload it again');
  if (file.kind === 'csv') return eachCsvRow(file.buffer, cb);
  return eachSheetRow(file.buffer, cb);
}

// the header and the column guesses, read from the first few lines only
export function openFile(name, buffer) {
  const file = { name, buffer, kind: /\.csv$/i.test(name) ? 'csv' : 'xlsx', rowCount: 0 };

  const probe = [];
  eachRow(file, row => {
    if (row.filter(x => clean(x)).length) probe.push(row);
    return probe.length < 12;
  });
  if (!probe.length) throw new Error(name + ' has no readable rows');

  const hRow = findHeaderRow(probe);
  file.header = (probe[hRow] || []).map(h => clean(h));
  file.headerKey = file.header.join('|').toLowerCase();
  file.cols = detectColumns(file.header);
  return file;
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

    let line = 0;
    let count = 0;

    // a hundred thousand rows go through here, so nothing is built per row
    // that does not have to be
    const headOrder = clean(f.header[c.order]).toLowerCase();

    eachRow(f, raw => {
      line++;

      const cell = i => (i >= 0 ? clean(raw[i]) : '');
      const orderRaw = cell(c.order);
      if (!orderRaw) return;
      if (/^(grand )?total$/i.test(orderRaw)) return;
      // the header again, at the top of a second tab
      if (orderRaw.toLowerCase() === headOrder) return;

      count++;
      const key = f.name + ' ' + orderRaw.toUpperCase();
      if (!byOrder.has(key)) {
        byOrder.set(key, {
          file: f.name,
          order: orderRaw,
          digits: digitsOf(orderRaw),
          sheetRow: line,
          customer: '', address: '', phone: '', email: '',
          total: 0, when: '', lines: 0
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
      if (!o.when)     o.when     = cell(c.date);
    });

    f.rowCount = count;
  });

  return Array.from(byOrder.values()).map(o => {
    const when = whenOf(o.when);
    return Object.assign(o, {
      date: when.day,
      at: when.at,
      keys: {
        name:  normName(o.customer),
        addr:  normAddr(o.address),
        phone: normPhone(o.phone),
        email: normEmail(o.email)
      }
    });
  });
}

// "2026-08-31 08:59:00 +0500" carries both the day the order was placed and
// the hour. The day is taken as the shop wrote it, so an order does not slide
// into yesterday on the way through a time zone.
export function whenOf(raw) {
  const s = clean(raw);
  if (!s) return { day: null, at: null };

  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  const day = m ? `${m[1]}-${m[2]}-${m[3]}` : toISO(s);

  // "2026-08-31 08:59:00 +0500" is not a date any browser or Node will parse:
  // the day and the hour want a T between them, and the offset wants no space
  const t = Date.parse(s.replace(' ', 'T').replace(/\s+([+-]\d{2}:?\d{2})$/, '$1'));
  return { day, at: isNaN(t) ? null : t };
}

/* ==================== grouping ==================== */

// A customer who orders twice in a morning gets one parcel; the same customer
// three days later gets another one, delivered on its own. So the day an order
// was placed is part of what has to agree - unless the export carries no dates
// worth speaking of, in which case there is nothing to go on.
function timeRule(orders, time) {
  const asked = (time && time.mode) || 'day';
  if (asked === 'any') return { mode: 'any' };

  const known = orders.filter(o => o.date).length;
  if (known < orders.length / 2) return { mode: 'any', unknown: true };

  if (asked === 'window') {
    const hours = Math.max(1, Math.min(240, Number(time && time.hours) || 24));
    return { mode: 'window', gap: hours * 3600 * 1000, hours };
  }
  return { mode: 'day' };
}

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
export function groupOrders(orders, minFields, time) {
  const floor = Math.max(2, Math.min(4, Number(minFields) || 4));
  const rule = timeRule(orders, time);
  const uf = finder(orders.length);
  const joinTier = new Array(orders.length).fill(0);

  for (let k = 4; k >= floor; k--) {
    combos(FIELDS, k).forEach(set => {
      const buckets = new Map();
      orders.forEach((o, i) => {
        if (set.some(f => !o.keys[f])) return;       // a blank never matches
        // by day, the day is simply part of the key; by window, the times are
        // weighed up afterwards
        if (rule.mode === 'day' && !o.date) return;
        const day = rule.mode === 'day' ? o.date : '';
        const key = day + '|' + set.map(f => o.keys[f]).join('|');
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(i);
      });
      buckets.forEach(all => {
        if (all.length < 2) return;

        // an hour window instead: the orders are lined up in time and only
        // neighbours close enough together are joined
        if (rule.mode === 'window') {
          const line = all.filter(i => orders[i].at !== null)
            .sort((a, b) => orders[a].at - orders[b].at);
          for (let j = 1; j < line.length; j++) {
            if (orders[line[j]].at - orders[line[j - 1]].at > rule.gap) continue;
            uf.union(line[j - 1], line[j]);
            joinTier[line[j]] = Math.max(joinTier[line[j]], k);
            joinTier[line[j - 1]] = Math.max(joinTier[line[j - 1]], k);
          }
          return;
        }

        for (let j = 1; j < all.length; j++) uf.union(all[0], all[j]);
        all.forEach(i => { joinTier[i] = Math.max(joinTier[i], k); });
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

// The courier books the whole group as one parcel, so only one of its order
// numbers is written in the sheet, against the COD for all of them. One number
// found is therefore enough to say the group belongs to that row.
//
// The rows themselves are pasted in, straight out of the CPR sheet, so nothing
// has to be found on Drive or lined up column by column first.

// a header word as the sheet writes it: ORDER_REF_NUMBER, COD_AMOUNT
const headerWord = h => clean(h).toLowerCase().replace(/[_\s]+/g, ' ').trim();

function pasteColumns(header) {
  const low = header.map(headerWord);
  const pick = (exact, like) => {
    for (const w of exact) { const i = low.indexOf(w); if (i >= 0) return i; }
    for (const w of like) { const i = low.findIndex(h => h && h.includes(w)); if (i >= 0) return i; }
    return -1;
  };
  return {
    invoice: pick(['order ref number', 'order ref', 'order number', 'order id', 'invoice no'],
                  ['order ref', 'order no', 'order id', 'reference']),
    cpr:     pick(['cpr number', 'cpr no', 'cpr'], ['cpr n']),
    cprDate: pick(['cpr date', 'cpr d'], ['cpr date']),
    amount:  pick(['cod amount', 'amount cod', 'cod', 'collection amount'], ['cod']),
    status:  pick(['status', 'delivery status', 'order status'], ['status'])
  };
}

// Rows copied out of a sheet arrive tab by tab. The header comes with them -
// without it there is no telling the COD from the tracking number.
export function parsePasted(text) {
  const lines = String(text || '').split(/\r?\n/).filter(l => l.trim().length);
  if (!lines.length) throw new Error('Nothing was pasted');

  const split = l => (l.indexOf('\t') >= 0 ? l.split('\t') : l.split(/ {2,}/));
  const grid = lines.map(split);

  // the header is whichever of the first few lines knows the most column names
  let hRow = -1, best = -1;
  for (let r = 0; r < Math.min(grid.length, 5); r++) {
    const cols = pasteColumns(grid[r]);
    const score = [cols.invoice, cols.cpr, cols.amount].filter(i => i >= 0).length;
    if (score > best) { best = score; hRow = r; }
  }

  const header = grid[hRow].map(h => clean(h));
  const cols = pasteColumns(header);

  if (cols.invoice < 0 || cols.amount < 0) {
    throw new Error('Paste the header row as well - the one with ORDER_REF_NUMBER ' +
      'and COD_AMOUNT - so the columns can be told apart');
  }

  const rows = [];
  for (let r = hRow + 1; r < grid.length; r++) {
    const raw = grid[r];
    const invoice = clean(raw[cols.invoice]);
    if (!invoice) continue;
    if (/^(grand )?total/i.test(invoice)) continue;

    const invoices = splitInvoices(invoice);
    if (!invoices.length) continue;

    rows.push({
      sheetRow: r + 1,                       // the line as pasted, for pointing at
      invoice,
      invoices,
      merged: invoices.length > 1,
      amount: num(raw[cols.amount]),
      status: cols.status >= 0 ? clean(raw[cols.status]) : '',
      cprNumber: cols.cpr >= 0 ? clean(raw[cols.cpr]) : '',
      cprDate: cols.cprDate >= 0 ? toISO(raw[cols.cprDate]) : null
    });
  }

  if (!rows.length) throw new Error('No order numbers found in what was pasted');

  const cprs = [];
  rows.forEach(r => {
    const key = r.cprNumber || '(no CPR number)';
    let c = cprs.find(x => x.cprNumber === key);
    if (!c) { c = { cprNumber: key, cprDate: r.cprDate, rows: 0, amount: 0 }; cprs.push(c); }
    c.rows++;
    c.amount = Math.round((c.amount + (r.amount || 0)) * 100) / 100;
  });

  return { header, cols, rows, cprs, headerLine: hRow + 1 };
}

export function placeGroups(groups, rows, cpr) {
  // every order number in the sheet, pointing back at the rows it was written
  // on - more than one row for a number is itself something to report
  const rowsOf = new Map();
  rows.forEach(r => (r.invoices || []).forEach(n => {
    const d = digitsOf(n);
    if (!d) return;
    if (!rowsOf.has(d)) rowsOf.set(d, []);
    if (!rowsOf.get(d).includes(r)) rowsOf.get(d).push(r);
  }));

  const matched = [], twice = [], absent = [];

  groups.forEach(g => {
    const hits = [];
    g.orders.forEach(o => (rowsOf.get(o.digits) || [])
      .forEach(row => hits.push({ order: o.order, row })));

    if (!hits.length) {
      absent.push({ id: g.id, customer: g.customer, orders: g.orders.map(o => o.order) });
      return;
    }

    const seen = [];
    hits.forEach(h => { if (!seen.includes(h.row)) seen.push(h.row); });

    const base = {
      id: g.id,
      tier: g.tier,
      agree: g.agree,
      customer: g.customer,
      phone: g.phone,
      address: g.address,
      shopifyTotal: g.total,
      orders: g.orders.map(o => ({
        order: o.order, digits: o.digits, total: o.total,
        date: o.date, at: o.at, customer: o.customer, phone: o.phone,
        email: o.email, address: o.address
      })),
      found: hits.map(h => ({ order: h.order, sheetRow: h.row.sheetRow, cell: h.row.invoice }))
    };

    // one parcel, one row - anything else is the sheet saying the same parcel
    // twice, and that has to be looked at by hand
    if (seen.length > 1) {
      twice.push(Object.assign(base, {
        rows: seen.map(r => ({
          sheetRow: r.sheetRow, cell: r.invoice, amount: r.amount,
          cprNumber: r.cprNumber || ''
        }))
      }));
      return;
    }

    const row = seen[0];
    matched.push(Object.assign(base, {
      sheetRow: row.sheetRow,
      cell: row.invoice,
      cod: row.amount,
      cprNumber: row.cprNumber || '',
      // the sheet already carries the whole group in that one cell
      whole: g.orders.every(o => (row.invoices || []).some(n => digitsOf(n) === o.digits))
    }));
  });

  matched.sort((a, b) => a.sheetRow - b.sheetRow);

  return {
    cpr: cpr || '',
    sheetRows: rows.length,
    totals: {
      groups: groups.length,
      matched: matched.length,
      twice: twice.length,
      absent: absent.length
    },
    matched, twice, absent
  };
}
