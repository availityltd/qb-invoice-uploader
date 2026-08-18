import { listTabs, readTab } from './sheets.js';
import { clean, toISO } from './cpr.js';

// The return sheets are laid out sideways: one column per day, with the day's
// order numbers running down under it. This pulls those columns apart.

const WEEKDAY = /^(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?\s*/i;

function headerDate(v) {
  let s = clean(v);
  if (!s) return null;
  s = s.replace(WEEKDAY, '');            // "Fri, July 31, 2026" -> "July 31, 2026"
  return toISO(s);
}

function isOrderNumber(v) {
  const s = clean(v).replace(/^#/, '');
  return /^\d{6,}$/.test(s);
}

// which row holds the dates - usually the second, but never assume
function findHeaderRow(grid) {
  let best = -1, bestCount = 0;
  const limit = Math.min(grid.length, 12);
  for (let r = 0; r < limit; r++) {
    const row = grid[r] || [];
    let n = 0;
    row.forEach(cell => { if (headerDate(cell)) n++; });
    if (n > bestCount) { bestCount = n; best = r; }
  }
  return bestCount ? best : -1;
}

export async function readDateColumns(sheetId, tab, excel) {
  const grid = await readTab(sheetId, tab, excel);
  if (!grid.length) throw new Error('That tab is empty');

  const hRow = findHeaderRow(grid);
  if (hRow < 0) throw new Error('No date headers found on that tab');

  const header = grid[hRow] || [];
  const width = Math.max(...grid.map(r => (r || []).length));

  const cols = [];
  for (let c = 0; c < width; c++) {
    const iso = headerDate(header[c]);
    if (iso) cols.push({ date: iso, col: c, label: clean(header[c]), numbers: [] });
  }
  if (!cols.length) throw new Error('No date headers found on that tab');

  for (let r = hRow + 1; r < grid.length; r++) {
    const row = grid[r] || [];
    cols.forEach(c => {
      const v = row[c.col];
      if (isOrderNumber(v)) c.numbers.push(clean(v));
    });
  }

  // the same day can appear twice across a wide sheet - fold them together
  const byDate = new Map();
  cols.forEach(c => {
    if (!byDate.has(c.date)) {
      byDate.set(c.date, { date: c.date, label: c.label, numbers: [] });
    }
    byDate.get(c.date).numbers.push(...c.numbers);
  });

  const days = [...byDate.values()]
    .map(d => ({
      date: d.date,
      label: d.label,
      count: new Set(d.numbers).size,
      numbers: [...new Set(d.numbers)]
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return { headerRow: hRow + 1, days };
}

export async function tabsOf(sheetId, excel) {
  return listTabs(sheetId, excel);
}
