import { google } from 'googleapis';
import XLSX from 'xlsx';
import { Readable } from 'stream';

const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive'
];

function auth() {
  const email = process.env.GOOGLE_SA_EMAIL;
  let key = process.env.GOOGLE_SA_KEY || '';
  if (!email || !key) throw new Error('Google service account is not configured');
  key = key.replace(/\\n/g, '\n');
  return new google.auth.JWT({ email, key, scopes: SCOPES });
}

const SHEET_MIME  = 'application/vnd.google-apps.spreadsheet';
const XLSX_MIME   = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const XLSM_MIME   = 'application/vnd.ms-excel.sheet.macroEnabled.12';
const XLS_MIME    = 'application/vnd.ms-excel';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

function isSheetFile(f) {
  if (f.mimeType === SHEET_MIME) return true;
  if (f.mimeType === XLSX_MIME || f.mimeType === XLSM_MIME || f.mimeType === XLS_MIME) return true;
  return /\.(xlsx|xlsm|xls)$/i.test(f.name || '');
}

function isExcel(f) {
  return f.mimeType !== SHEET_MIME;
}

async function childrenOf(drive, folderId) {
  const out = [];
  let pageToken = null;
  do {
    const r = await drive.files.list({
      q: `'${folderId}' in parents and trashed=false`,
      fields: 'nextPageToken, files(id, name, mimeType, modifiedTime)',
      orderBy: 'name',
      pageSize: 500,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true
    });
    (r.data.files || []).forEach(f => out.push(f));
    pageToken = r.data.nextPageToken;
  } while (pageToken);
  return out;
}

/* ---------- browsing ---------- */

export async function listFolders(folderId) {
  const drive = google.drive({ version: 'v3', auth: auth() });
  const kids = await childrenOf(drive, folderId);
  return kids
    .filter(f => f.mimeType === FOLDER_MIME)
    .map(f => ({ id: f.id, name: f.name, modified: f.modifiedTime }));
}

export async function listSheetsIn(folderId) {
  const drive = google.drive({ version: 'v3', auth: auth() });
  const kids = await childrenOf(drive, folderId);
  return kids
    .filter(isSheetFile)
    .map(f => ({
      id: f.id,
      name: f.name,
      excel: isExcel(f),
      modified: f.modifiedTime
    }))
    .sort((a, b) => (b.modified || '').localeCompare(a.modified || ''));
}

export async function listSheets(folderId) {
  const drive = google.drive({ version: 'v3', auth: auth() });
  const files = [];
  const seen = new Set();

  async function walk(id, trail, depth) {
    if (depth > 6 || seen.has(id)) return;
    seen.add(id);
    const kids = await childrenOf(drive, id);
    for (const f of kids) {
      if (f.mimeType === FOLDER_MIME) {
        await walk(f.id, trail.concat(f.name), depth + 1);
      } else if (isSheetFile(f)) {
        files.push({
          id: f.id,
          name: f.name,
          path: trail.join(' / '),
          excel: isExcel(f),
          modified: f.modifiedTime
        });
      }
    }
  }

  await walk(folderId, [], 0);
  files.sort((a, b) => (b.modified || '').localeCompare(a.modified || ''));
  return files;
}

/* ---------- raw file in and out ---------- */

export async function fileInfo(fileId) {
  const drive = google.drive({ version: 'v3', auth: auth() });
  const r = await drive.files.get({
    fileId,
    fields: 'id, name, mimeType, size',
    supportsAllDrives: true
  });
  return r.data;
}

export async function downloadBytes(fileId) {
  const drive = google.drive({ version: 'v3', auth: auth() });
  const r = await drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'arraybuffer' }
  );
  return Buffer.from(r.data);
}

// overwrite the same file - name, folder and link all stay put
export async function uploadBytes(fileId, buffer, mimeType) {
  const drive = google.drive({ version: 'v3', auth: auth() });
  await drive.files.update({
    fileId,
    supportsAllDrives: true,
    media: { mimeType, body: Readable.from(buffer) }
  });
  return true;
}

/* ---------- reading ---------- */

function openWorkbook(buf, withStyles) {
  return XLSX.read(buf, {
    type: 'buffer',
    raw: false,
    cellDates: false,
    bookVBA: true,
    cellStyles: !!withStyles
  });
}

async function downloadExcel(fileId) {
  return openWorkbook(await downloadBytes(fileId), false);
}

export async function listTabs(sheetId, excel) {
  if (excel) {
    const wb = await downloadExcel(sheetId);
    return wb.SheetNames.map((n, i) => ({ id: i, title: n, rows: 0 }));
  }
  const sheets = google.sheets({ version: 'v4', auth: auth() });
  const r = await sheets.spreadsheets.get({ spreadsheetId: sheetId, fields: 'sheets.properties' });
  return (r.data.sheets || []).map(s => ({
    id: s.properties.sheetId,
    title: s.properties.title,
    rows: s.properties.gridProperties ? s.properties.gridProperties.rowCount : 0
  }));
}

export async function readTab(sheetId, tabTitle, excel) {
  if (excel) {
    const wb = await downloadExcel(sheetId);
    const ws = wb.Sheets[tabTitle] || wb.Sheets[wb.SheetNames[0]];
    if (!ws) return [];
    return XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '', blankrows: false });
  }
  const sheets = google.sheets({ version: 'v4', auth: auth() });
  const r = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `'${tabTitle}'`,
    valueRenderOption: 'UNFORMATTED_VALUE',
    dateTimeRenderOption: 'FORMATTED_STRING'
  });
  return r.data.values || [];
}

/* ---------- what would we break in an Excel file ---------- */

const RISK_LABELS = {
  fills:        'Cell colours / shading',
  widths:       'Custom column widths',
  merged:       'Merged cells',
  conditional:  'Conditional formatting',
  charts:       'Charts',
  pivot:        'Pivot tables',
  filters:      'Saved filters',
  freeze:       'Frozen rows or columns',
  images:       'Images or shapes',
  validation:   'Dropdown lists / data validation'
};

function zipText(wb, path) {
  try {
    const f = (wb.files || {})[path];
    if (!f) return '';
    const c = f.content !== undefined ? f.content : f;
    return Buffer.from(c).toString('utf8');
  } catch (e) {
    return '';
  }
}

// look inside the xlsx/xlsm and report anything a rewrite could drop
export async function inspectExcel(fileId) {
  const buf = await downloadBytes(fileId);

  let wb;
  try {
    wb = XLSX.read(buf, {
      type: 'buffer',
      bookFiles: true,
      cellStyles: true,
      bookVBA: true,
      raw: false,
      cellDates: false
    });
  } catch (e) {
    return { risks: [], hasMacros: false, note: 'Could not inspect this file: ' + e.message };
  }

  const found = new Set();
  const keys = wb.keys || Object.keys(wb.files || {});

  keys.forEach(k => {
    const p = String(k).toLowerCase();
    if (p.includes('xl/charts/'))       found.add('charts');
    if (p.includes('xl/pivotcache/'))   found.add('pivot');
    if (p.includes('xl/pivottables/'))  found.add('pivot');
    if (p.includes('xl/media/'))        found.add('images');
    if (p.includes('xl/drawings/'))     found.add('images');
  });

  // scan every worksheet's own xml
  keys.filter(k => /^xl\/worksheets\/sheet\d+\.xml$/i.test(String(k))).forEach(k => {
    const xml = zipText(wb, k);
    if (!xml) return;
    if (xml.includes('<conditionalFormatting')) found.add('conditional');
    if (xml.includes('<mergeCell'))             found.add('merged');
    if (/<col\b[^>]*\bwidth=/.test(xml))        found.add('widths');
    if (xml.includes('<autoFilter'))            found.add('filters');
    if (xml.includes('<dataValidation'))        found.add('validation');
    if (/<pane\b[^>]*state="frozen"/.test(xml)) found.add('freeze');
  });

  // any fill beyond the two Excel always ships with
  const styles = zipText(wb, 'xl/styles.xml');
  if (styles) {
    const fills = styles.match(/<patternFill[^>]*patternType="([^"]+)"/g) || [];
    const real = fills.filter(f => !/patternType="(none|gray125)"/.test(f));
    if (real.length) found.add('fills');
  }

  // fall back to whatever the parsed sheets can tell us
  wb.SheetNames.forEach(n => {
    const ws = wb.Sheets[n];
    if (!ws) return;
    if ((ws['!merges'] || []).length) found.add('merged');
    if ((ws['!cols'] || []).some(c => c && (c.wpx || c.wch || c.width))) found.add('widths');
  });

  const hasMacros = keys.some(k => String(k).toLowerCase().includes('vbaproject.bin'));

  return {
    hasMacros,
    risks: Array.from(found).map(k => ({ key: k, label: RISK_LABELS[k] || k }))
  };
}

/* ---------- writing the status column ---------- */

function colLetter(i) {
  let s = '';
  let n = i;
  while (n >= 0) {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  }
  return s;
}

// Google Sheets: touch only the cells we mean to touch
export async function writeStatusSheet(sheetId, tabTitle, headerRow, colIndex, rows, headerText, value) {
  const sheets = google.sheets({ version: 'v4', auth: auth() });
  const L = colLetter(colIndex);

  const data = [{
    range: `'${tabTitle}'!${L}${headerRow}`,
    values: [[headerText]]
  }];

  rows.forEach(r => {
    data.push({ range: `'${tabTitle}'!${L}${r}`, values: [[value]] });
  });

  const size = 500;
  for (let i = 0; i < data.length; i += size) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: { valueInputOption: 'RAW', data: data.slice(i, i + size) }
    });
  }
  return rows.length;
}

// Excel on Drive: pull it down, set the cells, push the same file back
export async function writeStatusExcel(fileId, tabTitle, headerRow, colIndex, rows, headerText, value) {
  const info = await fileInfo(fileId);
  const name = info.name || '';
  const macro = /\.xlsm$/i.test(name) || info.mimeType === XLSM_MIME;

  const buf = await downloadBytes(fileId);
  const wb = openWorkbook(buf, true);

  const ws = wb.Sheets[tabTitle] || wb.Sheets[wb.SheetNames[0]];
  if (!ws) throw new Error('That tab is not in the file any more');

  const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');

  const put = (r, text) => {
    const addr = XLSX.utils.encode_cell({ r: r - 1, c: colIndex });
    ws[addr] = { t: 's', v: text };
    if (r - 1 > range.e.r) range.e.r = r - 1;
  };

  put(headerRow, headerText);
  rows.forEach(r => put(r, value));

  if (colIndex > range.e.c) range.e.c = colIndex;
  ws['!ref'] = XLSX.utils.encode_range(range);

  const out = XLSX.write(wb, {
    type: 'buffer',
    bookType: macro ? 'xlsm' : 'xlsx',
    bookVBA: true,
    cellStyles: true,
    compression: true
  });

  await uploadBytes(fileId, out, macro ? XLSM_MIME : XLSX_MIME);
  return rows.length;
}

/* ---------- painting (Google Sheets only) ---------- */

export const ROW_COLOURS = {
  green:  { red: 0.85, green: 0.94, blue: 0.86 },  // received in QuickBooks
  yellow: { red: 1.00, green: 0.95, blue: 0.75 },  // amount differs
  red:    { red: 0.99, green: 0.85, blue: 0.84 },  // not found in QuickBooks
  orange: { red: 1.00, green: 0.89, blue: 0.77 },  // paid under another CPR
  clear:  null
};

// how wide the tab is, so a whole row really means the whole row
async function tabWidth(sheets, sheetId, tabId) {
  const r = await sheets.spreadsheets.get({
    spreadsheetId: sheetId,
    fields: 'sheets.properties'
  });
  const hit = (r.data.sheets || [])
    .find(s => s.properties && s.properties.sheetId === Number(tabId));
  const g = hit && hit.properties.gridProperties;
  return (g && g.columnCount) ? g.columnCount : 40;
}

// A sheet of a few thousand rows would otherwise mean a few thousand requests,
// so rows that sit next to each other and share a colour go across as one band.
function bands(colours) {
  const sorted = colours
    .filter(c => c && c.row > 0)
    .slice()
    .sort((a, b) => a.row - b.row);

  const out = [];
  let cur = null;

  sorted.forEach(c => {
    if (cur && c.colour === cur.colour && c.row === cur.end + 1) {
      cur.end = c.row;
      return;
    }
    if (cur) out.push(cur);
    cur = { colour: c.colour, start: c.row, end: c.row };
  });
  if (cur) out.push(cur);

  return out;
}

export async function paintRows(sheetId, tabId, colours, width) {
  if (!colours || !colours.length) return 0;
  const sheets = google.sheets({ version: 'v4', auth: auth() });

  const cols = width || await tabWidth(sheets, sheetId, tabId);

  const requests = bands(colours).map(b => ({
    repeatCell: {
      range: {
        sheetId: Number(tabId),
        startRowIndex: b.start - 1,
        endRowIndex: b.end,
        startColumnIndex: 0,
        endColumnIndex: cols
      },
      cell: {
        userEnteredFormat: {
          backgroundColor: ROW_COLOURS[b.colour] === undefined
            ? undefined
            : ROW_COLOURS[b.colour]
        }
      },
      fields: 'userEnteredFormat.backgroundColor'
    }
  }));

  const size = 400;
  for (let i = 0; i < requests.length; i += size) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: { requests: requests.slice(i, i + size) }
    });
  }
  return colours.length;
}

export async function testConnection() {
  const drive = google.drive({ version: 'v3', auth: auth() });
  const r = await drive.about.get({ fields: 'user' });
  return r.data.user;
}

// Sheets holds pictures two very different ways, and only one is reachable:
// =IMAGE() formulas live inside a cell, while pasted pictures float over the
// grid and the API has no listing for them. This reports which kind is there.
export async function peekImages(sheetId, tabTitle) {
  const sheets = google.sheets({ version: 'v4', auth: auth() });

  const meta = await sheets.spreadsheets.get({
    spreadsheetId: sheetId,
    fields: 'sheets.properties.title'
  });
  const tabs = (meta.data.sheets || []).map(s => s.properties.title);
  const tab = tabTitle || tabs[0];

  // a few hundred rows is plenty to tell what kind of pictures these are,
  // and keeps a very large sheet from being pulled across
  const r = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `'${tab}'!A1:Z200`,
    valueRenderOption: 'FORMULA'
  });

  const grid = r.data.values || [];
  const inCell = [];

  grid.forEach((row, ri) => {
    (row || []).forEach((cell, ci) => {
      const s = String(cell == null ? '' : cell);
      if (/^=\s*IMAGE\s*\(/i.test(s)) {
        const url = (s.match(/["']([^"']+)["']/) || [])[1] || '';
        if (inCell.length < 8) inCell.push({ row: ri + 1, col: ci + 1, url });
      }
    });
  });

  return {
    tabs,
    tab,
    rowsScanned: grid.length,
    imageFormulas: inCell.length,
    samples: inCell,
    verdict: inCell.length
      ? 'Reachable - these are =IMAGE() formulas and their links can be read.'
      : 'Not reachable through the sheet - no =IMAGE() formulas on this tab. ' +
        'Pictures pasted over the grid are not listed by the API at all.'
  };
}

/* ---------- one cell at a time (Google Sheets only) ---------- */

// Renaming a single order number in the sheet - used when a replaced parcel
// gets a "-D" copy in QuickBooks and the row has to point at it instead.
export async function readCell(sheetId, tabTitle, row, colIndex) {
  const sheets = google.sheets({ version: 'v4', auth: auth() });
  const r = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `'${tabTitle}'!${colLetter(colIndex)}${row}`,
    valueRenderOption: 'UNFORMATTED_VALUE'
  });
  const v = r.data.values;
  return (v && v[0] && v[0][0] !== undefined) ? String(v[0][0]) : '';
}

export async function writeCell(sheetId, tabTitle, row, colIndex, value) {
  const sheets = google.sheets({ version: 'v4', auth: auth() });
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `'${tabTitle}'!${colLetter(colIndex)}${row}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[value]] }
  });
  return true;
}
// Google allows only sixty writes a minute, so marking a few hundred rows one
// at a time fails after the first sixty. They all go across together instead.
export async function stampRows(sheetId, tabTitle, colIndex, rows, value) {
  if (!rows || !rows.length) return 0;
  const sheets = google.sheets({ version: 'v4', auth: auth() });
  const L = colLetter(colIndex);

  const data = rows.map(r => ({
    range: `'${tabTitle}'!${L}${r}`,
    values: [[value]]
  }));

  const size = 500;
  for (let i = 0; i < data.length; i += size) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: { valueInputOption: 'RAW', data: data.slice(i, i + size) }
    });
  }
  return rows.length;
}
