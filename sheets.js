import { google } from 'googleapis';
import XLSX from 'xlsx';

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
const FOLDER_MIME = 'application/vnd.google-apps.folder';

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

// only the folders sitting directly inside this one
export async function listFolders(folderId) {
  const drive = google.drive({ version: 'v3', auth: auth() });
  const kids = await childrenOf(drive, folderId);
  return kids
    .filter(f => f.mimeType === FOLDER_MIME)
    .map(f => ({ id: f.id, name: f.name, modified: f.modifiedTime }));
}

// only the spreadsheets sitting directly inside this one
export async function listSheetsIn(folderId) {
  const drive = google.drive({ version: 'v3', auth: auth() });
  const kids = await childrenOf(drive, folderId);
  return kids
    .filter(f => f.mimeType === SHEET_MIME || f.mimeType === XLSX_MIME)
    .map(f => ({
      id: f.id,
      name: f.name,
      excel: f.mimeType === XLSX_MIME,
      modified: f.modifiedTime
    }))
    .sort((a, b) => (b.modified || '').localeCompare(a.modified || ''));
}

// every spreadsheet inside a folder, including the ones in sub-folders
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
      } else if (f.mimeType === SHEET_MIME || f.mimeType === XLSX_MIME) {
        files.push({
          id: f.id,
          name: f.name,
          path: trail.join(' / '),
          excel: f.mimeType === XLSX_MIME,
          modified: f.modifiedTime
        });
      }
    }
  }

  await walk(folderId, [], 0);
  files.sort((a, b) => (b.modified || '').localeCompare(a.modified || ''));
  return files;
}

/* ---------- reading ---------- */

async function downloadExcel(fileId) {
  const drive = google.drive({ version: 'v3', auth: auth() });
  const r = await drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'arraybuffer' }
  );
  return XLSX.read(Buffer.from(r.data), { type: 'buffer', raw: false, cellDates: false });
}

// the tabs inside one spreadsheet
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

// all the values of one tab
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

/* ---------- painting ---------- */

// colours is [{row: 5, colour: 'green'|'yellow'|'clear'}, ...], rows are 1-based
export async function paintRows(sheetId, tabId, colours, width) {
  if (!colours.length) return;
  const sheets = google.sheets({ version: 'v4', auth: auth() });

  const palette = {
    green:  { red: 0.85, green: 0.94, blue: 0.86 },
    yellow: { red: 1.00, green: 0.95, blue: 0.75 },
    clear:  null
  };

  const requests = colours.map(c => ({
    repeatCell: {
      range: {
        sheetId: tabId,
        startRowIndex: c.row - 1,
        endRowIndex: c.row,
        startColumnIndex: 0,
        endColumnIndex: width || 40
      },
      cell: { userEnteredFormat: { backgroundColor: palette[c.colour] || undefined } },
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
}

export async function testConnection() {
  const drive = google.drive({ version: 'v3', auth: auth() });
  const r = await drive.about.get({ fields: 'user' });
  return r.data.user;
}
