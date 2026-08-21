import { readTab } from './sheets.js';
import { clean, num, toISO } from './cpr.js';

// Trax does not put charges in columns. It writes a little summary block off
// to the right of each CPR's rows, headed "<cpr number> Summary", and lists
// the charges underneath by name. This file finds those blocks and reads them.

const SUMMARY_HEAD = /^(.+?)\s+summary$/i;      // "1792466 Summary"
const CHARGES_HEAD = /^charges\s+summary/i;      // "Charges Summary (PKR)"

// these are sums of the others, not charges in their own right
const ROLLUPS = [
  'total charges (w/o gst)',
  'total charges',
  'overall charges',
  'grand total'
];

export function isRollup(name) {
  const n = clean(name).toLowerCase();
  return ROLLUPS.some(r => n === r || n.startsWith(r));
}

function amountBeside(row, col) {
  // the figure usually sits in the next cell, but sometimes one further on
  for (let c = col + 1; c <= col + 3; c++) {
    const v = row[c];
    if (v === undefined || v === null || clean(v) === '') continue;
    const n = num(v);
    if (n !== 0 || /^[\s0.,-]+$/.test(String(v))) return n;
  }
  return 0;
}

// which column carries the CPR number, so a summary can be tied to its rows
function findCprColumn(grid, headerRow) {
  const header = (grid[headerRow] || []).map(h => clean(h).toLowerCase());
  const wants = ['cpr number', 'cpr no', 'cpr n', 'cpr'];
  for (const w of wants) {
    const i = header.findIndex(h => h === w || h.startsWith(w));
    if (i >= 0) return i;
  }
  return -1;
}

function findHeaderRow(grid) {
  const limit = Math.min(grid.length, 12);
  for (let r = 0; r < limit; r++) {
    const row = (grid[r] || []).map(x => clean(x).toLowerCase());
    if (row.some(h => h.startsWith('cpr'))) return r;
  }
  return 0;
}

export async function loadTraxSummaries(sheetId, tab, excel) {
  const grid = await readTab(sheetId, tab, excel);
  if (!grid.length) throw new Error('That tab is empty');

  const hRow = findHeaderRow(grid);
  const cprCol = findCprColumn(grid, hRow);

  // dates and row counts come from the ordinary rows
  const seen = new Map();
  const dateCol = (function () {
    const header = (grid[hRow] || []).map(h => clean(h).toLowerCase());
    const i = header.findIndex(h => h.startsWith('cpr d'));
    return i;
  })();

  if (cprCol >= 0) {
    for (let r = hRow + 1; r < grid.length; r++) {
      const row = grid[r] || [];
      const cpr = clean(row[cprCol]);
      if (!cpr) continue;
      if (!seen.has(cpr)) seen.set(cpr, { rows: 0, date: null });
      const g = seen.get(cpr);
      g.rows++;
      if (!g.date && dateCol >= 0) {
        const d = toISO(row[dateCol]);
        if (d) g.date = d;
      }
    }
  }

  // now hunt for the summary blocks
  const blocks = [];
  const width = Math.max(...grid.map(r => (r || []).length));

  for (let r = 0; r < grid.length; r++) {
    const row = grid[r] || [];
    for (let c = 0; c < width; c++) {
      const cell = clean(row[c]);
      if (!cell) continue;

      const m = cell.match(SUMMARY_HEAD);
      if (!m) continue;

      const cpr = clean(m[1]);
      if (!cpr) continue;

      // walk down from here, collecting name-and-figure pairs
      const charges = [];
      for (let rr = r + 1; rr < grid.length && rr < r + 60; rr++) {
        const line = grid[rr] || [];
        const name = clean(line[c]);

        if (!name) {
          // one blank line is fine, two means the block has ended
          const next = clean((grid[rr + 1] || [])[c]);
          if (!next) break;
          continue;
        }

        if (CHARGES_HEAD.test(name)) continue;          // the block's own title
        if (SUMMARY_HEAD.test(name)) break;             // the next CPR's block

        charges.push({
          name,
          amount: amountBeside(line, c),
          rollup: isRollup(name),
          sheetRow: rr + 1
        });
      }

      if (charges.length) {
        blocks.push({ cpr, col: c, headRow: r + 1, charges });
      }
    }
  }

  // fold blocks together in case one CPR has more than one
  const byCpr = new Map();
  blocks.forEach(b => {
    if (!byCpr.has(b.cpr)) {
      byCpr.set(b.cpr, { cpr: b.cpr, charges: [], blocks: 0 });
    }
    const g = byCpr.get(b.cpr);
    g.blocks++;
    b.charges.forEach(ch => {
      const hit = g.charges.find(x => x.name.toLowerCase() === ch.name.toLowerCase());
      if (hit) hit.amount += ch.amount;
      else g.charges.push(Object.assign({}, ch));
    });
  });

  const cprs = [...byCpr.values()].map(g => {
    const info = seen.get(g.cpr) || {};
    return {
      cpr: g.cpr,
      key: g.cpr,
      cprDate: info.date || null,
      rows: info.rows || 0,
      blocks: g.blocks,
      charges: g.charges.map(ch => ({
        name: ch.name,
        amount: Math.round(ch.amount * 100) / 100,
        rollup: ch.rollup
      }))
    };
  }).sort((a, b) => (b.cprDate || '').localeCompare(a.cprDate || ''));

  // every charge name anywhere in the sheet, for building the lines
  const names = [];
  cprs.forEach(c => c.charges.forEach(ch => {
    if (!names.some(n => n.name.toLowerCase() === ch.name.toLowerCase())) {
      names.push({ name: ch.name, rollup: ch.rollup });
    }
  }));

  return { cprs, names, cprColumn: cprCol, headerRow: hRow + 1 };
}

// add a CPR's charges up according to the lines the person built
export function applyLines(cpr, lines) {
  const byName = new Map();
  (cpr.charges || []).forEach(ch => byName.set(ch.name.toLowerCase(), ch.amount));

  const used = new Set();
  const out = (lines || []).map(l => {
    let amount = 0;
    const found = [], missing = [];

    (l.charges || []).forEach(name => {
      const k = String(name).toLowerCase();
      if (byName.has(k)) {
        amount += byName.get(k);
        found.push(name);
        used.add(k);
      } else {
        missing.push(name);
      }
    });

    return {
      label: l.label,
      account: l.account,
      amount: Math.round(amount * 100) / 100,
      found,
      missing
    };
  });

  // anything in this CPR that no line asked for, so nothing goes unnoticed
  const unused = (cpr.charges || [])
    .filter(ch => !ch.rollup && !used.has(ch.name.toLowerCase()) && ch.amount !== 0)
    .map(ch => ({ name: ch.name, amount: ch.amount }));

  const total = Math.round(out.reduce((s, l) => s + l.amount, 0) * 100) / 100;

  return { lines: out, unused, total };
}
