import express from 'express';
import multer from 'multer';
import cookieParser from 'cookie-parser';
import XLSX from 'xlsx';
import crypto from 'crypto';

import {
  initDb, saveCompany, getCompany, logUpload,
  getNegativeItems, setNegativeItems
} from './db.js';
import { initMappings, getMappings, saveMapping } from './mappings.js';
import { listSheets, listTabs, readTab, paintRows, testConnection } from './sheets.js';
import {
  initUsers, upsertUser, getUser, linkCompany, userOwns, companiesForUser
} from './users.js';
import {
  getAccessToken, getCompanyInfo, loadItems, loadTerms,
  getOrCreateCustomer, postInvoice, qbQuery
} from './qb.js';
import { initSettings, getSetting, setSetting, recordRun, listRuns, runsSummary,
         initCache, getCache, setCache } from './settings.js';
import {
  listFolders, listSheetsIn, loadSheet, groupByCpr, isDelivered,
  findInvoices, listAccounts, listPaymentMethods, postPayment, digitsOf as cprDigits
} from './cpr.js';
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

app.use(cookieParser());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

const API = 'https://quickbooks.api.intuit.com';
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const AUTH_URL = 'https://appcenter.intuit.com/connect/oauth2';
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const USERINFO_URL = 'https://accounts.platform.intuit.com/v1/openid_connect/userinfo';

const SESSION_SECRET = process.env.SESSION_SECRET || process.env.QB_CLIENT_SECRET || 'dev-secret';

// ==================== session helpers ====================
function sign(sub) {
  const mac = crypto.createHmac('sha256', SESSION_SECRET).update(sub).digest('hex');
  return sub + '.' + mac;
}
function verify(token) {
  if (!token) return null;
  const i = token.lastIndexOf('.');
  if (i < 1) return null;
  const sub = token.slice(0, i), mac = token.slice(i + 1);
  const good = crypto.createHmac('sha256', SESSION_SECRET).update(sub).digest('hex');
  if (mac.length !== good.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(good))) return null;
  return sub;
}
function currentUser(req) {
  return verify(req.cookies.uid);
}

async function requireCompany(req, res) {
  const sub = currentUser(req);
  if (!sub) { res.status(401).json({ error: 'Not signed in' }); return null; }
  const realmId = req.cookies.realm_id;
  if (!realmId) { res.status(401).json({ error: 'No company selected' }); return null; }
  if (!(await userOwns(sub, realmId))) {
    res.status(403).json({ error: 'This company is not linked to your account' });
    return null;
  }
  return realmId;
}

// ==================== OAuth ====================
app.get('/auth/connect', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  res.cookie('oauth_state', state, { httpOnly: true, maxAge: 600000, sameSite: 'lax' });

  const params = new URLSearchParams({
    client_id: process.env.QB_CLIENT_ID,
    response_type: 'code',
    scope: 'com.intuit.quickbooks.accounting openid profile email',
    redirect_uri: `${BASE_URL}/auth/callback`,
    state
  });

  res.redirect(`${AUTH_URL}?${params}`);
});

app.get('/auth/callback', async (req, res) => {
  try {
    const { code, realmId, state } = req.query;

    if (!state || state !== req.cookies.oauth_state) {
      return res.status(400).send('Invalid state. Please try connecting again.');
    }
    res.clearCookie('oauth_state');
    if (!code) return res.status(400).send('Missing authorization code');

    const basic = Buffer.from(
      `${process.env.QB_CLIENT_ID}:${process.env.QB_CLIENT_SECRET}`
    ).toString('base64');

    const tokenRes = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + basic,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: `${BASE_URL}/auth/callback`
      })
    });

    const tokens = await tokenRes.json();
    if (!tokens.access_token) {
      return res.status(400).send('Token exchange failed: ' + JSON.stringify(tokens).slice(0, 300));
    }

    let sub = null, email = null, name = null;
    try {
      const ui = await fetch(USERINFO_URL, {
        headers: { 'Authorization': 'Bearer ' + tokens.access_token, 'Accept': 'application/json' }
      });
      if (ui.ok) {
        const info = await ui.json();
        sub = info.sub;
        email = info.email || null;
        name = [info.givenName, info.familyName].filter(Boolean).join(' ') || null;
      }
    } catch (e) {
      console.error('userinfo error:', e.message);
    }

    if (!sub) {
      return res.status(400).send('Could not identify your Intuit account. Please try signing in again.');
    }

    await upsertUser(sub, email, name);
    res.cookie('uid', sign(sub), { httpOnly: true, maxAge: 60 * 24 * 3600 * 1000, sameSite: 'lax' });

    if (realmId && tokens.refresh_token) {
      await saveCompany(realmId, null, tokens.refresh_token);
      try {
        const info = await getCompanyInfo(realmId, tokens.access_token);
        await saveCompany(realmId, info.CompanyName, tokens.refresh_token);
      } catch (e) {
        console.error('CompanyInfo error:', e.message);
      }
      await linkCompany(sub, realmId);
      res.cookie('realm_id', realmId, { httpOnly: true, maxAge: 30 * 24 * 3600 * 1000, sameSite: 'lax' });
    }

    res.redirect('/?connected=1');

  } catch (err) {
    console.error(err);
    res.status(500).send('Connection failed: ' + err.message);
  }
});

app.get('/auth/status', async (req, res) => {
  const sub = currentUser(req);
  if (!sub) return res.json({ signedIn: false, connected: false });

  const user = await getUser(sub);
  const realmId = req.cookies.realm_id;

  if (!realmId || !(await userOwns(sub, realmId))) {
    return res.json({
      signedIn: true,
      connected: false,
      user: user ? (user.name || user.email) : null
    });
  }

  const company = await getCompany(realmId);
  res.json({
    signedIn: true,
    connected: !!company,
    companyName: company ? company.company_name : null,
    realmId,
    user: user ? (user.name || user.email) : null
  });
});

app.post('/auth/disconnect', (req, res) => {
  res.clearCookie('realm_id');
  res.json({ ok: true });
});

app.post('/auth/signout', (req, res) => {
  res.clearCookie('realm_id');
  res.clearCookie('uid');
  res.json({ ok: true });
});

app.get('/auth/companies', async (req, res) => {
  const sub = currentUser(req);
  if (!sub) return res.json({ companies: [], current: null });
  try {
    const list = await companiesForUser(sub);
    res.json({ companies: list, current: req.cookies.realm_id || null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/auth/switch', async (req, res) => {
  const sub = currentUser(req);
  if (!sub) return res.status(401).json({ error: 'Not signed in' });

  const { realmId } = req.body;
  if (!realmId) return res.status(400).json({ error: 'realmId required' });
  if (!(await userOwns(sub, realmId))) {
    return res.status(403).json({ error: 'This company is not linked to your account' });
  }

  const company = await getCompany(realmId);
  if (!company) return res.status(404).json({ error: 'Company not connected' });

  res.cookie('realm_id', realmId, { httpOnly: true, maxAge: 30 * 24 * 3600 * 1000, sameSite: 'lax' });
  res.json({ ok: true, companyName: company.company_name });
});

// ==================== Helpers ====================
function clean(s) {
  return String(s ?? '').replace(/[\u200B-\u200D\uFEFF\u00A0]/g, '').trim();
}

function toISODate(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = clean(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}

function num(v) {
  const n = parseFloat(String(v ?? '').replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? 0 : n;
}

function normInv(v) {
  let s = String(v ?? '').replace(/\u00a0/g, ' ').replace(/[\u200b-\u200d\ufeff]/g, '').trim();
  if (!s) return '';
  s = s.replace(/(\d),(\d)/g, '$1$2').replace(/^(\d+)\.0+$/, '$1');
  s = s.replace(/^[#\s]+/, '').replace(/\s+/g, ' ').toLowerCase();
  return s.replace(/^0+(?=[0-9])/, '').replace(/([^0-9])0+([0-9])/g, '$1$2');
}

function digitsOf(v) {
  return String(v ?? '').replace(/[^0-9]/g, '').replace(/^0+(?=[0-9])/, '');
}

function shiftDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ==================== Excel preview ====================
function parseWorkbook(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' });
  if (!rows.length) throw new Error('File is empty');

  const header = rows[0].map(h => clean(h).replace(/^\*/, '').toLowerCase());
  const col = n => header.indexOf(n.toLowerCase());

  const cInv = col('invoiceno');
  const cCust = col('customer');
  const cDate = col('invoicedate');
  const cDue = col('duedate');
  const cTerms = col('terms');
  const cMemo = col('memo');
  const cItem = header.findIndex(h => h.startsWith('item(product'));
  const cDesc = col('itemdescription');
  const cQty = col('itemquantity');
  const cRate = col('itemrate');
  const cAmt = col('itemamount');
  const cSvc = col('service date');

  if (cInv < 0 || cItem < 0 || cAmt < 0) {
    throw new Error('Required columns not found: *InvoiceNo, Item(Product/Service), *ItemAmount');
  }

  const map = new Map();
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const docNo = clean(r[cInv]);
    if (!docNo) continue;

    if (!map.has(docNo)) {
      map.set(docNo, {
        docNumber: docNo,
        customer: cCust >= 0 ? clean(r[cCust]) : '',
        txnDate: cDate >= 0 ? toISODate(r[cDate]) : null,
        dueDate: cDue >= 0 ? toISODate(r[cDue]) : null,
        terms: cTerms >= 0 ? clean(r[cTerms]) : '',
        memo: cMemo >= 0 ? clean(r[cMemo]) : '',
        lines: []
      });
    }

    map.get(docNo).lines.push({
      item: clean(r[cItem]),
      desc: cDesc >= 0 ? clean(r[cDesc]) : '',
      qty: cQty >= 0 ? (num(r[cQty]) || 1) : 1,
      rate: cRate >= 0 ? num(r[cRate]) : 0,
      amt: num(r[cAmt]),
      svc: cSvc >= 0 ? toISODate(r[cSvc]) : null
    });
  }

  return Array.from(map.values());
}

app.post('/api/preview', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const invoices = parseWorkbook(req.file.buffer);
    const totalLines = invoices.reduce((s, i) => s + i.lines.length, 0);
    const customers = [...new Set(invoices.map(i => i.customer).filter(Boolean))];
    const items = [...new Set(invoices.flatMap(i => i.lines.map(l => l.item)).filter(Boolean))].sort();
    res.json({ count: invoices.length, totalLines, customers, items, invoices });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ==================== QB invoice list from an uploaded file ====================
app.post('/api/qb-invoice-file', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const wb = XLSX.read(req.file.buffer, { type: 'buffer', raw: true, cellDates: false });
    const numbers = [];

    for (const sheetName of wb.SheetNames) {
      const grid = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], {
        header: 1, raw: false, defval: '', blankrows: false
      });
      if (!grid.length) continue;

      let headerRow = -1, col = -1;
      for (let r = 0; r < Math.min(grid.length, 15) && headerRow < 0; r++) {
        const row = grid[r] || [];
        for (let c = 0; c < row.length; c++) {
          const h = clean(row[c]).toLowerCase();
          if (/^(ref no\.?|reference number|invoice no\.?|invoice number|doc number|docnumber|num|number|no\.?|invoice)$/.test(h)) {
            headerRow = r; col = c; break;
          }
        }
      }

      if (headerRow < 0) {
        const probe = grid.slice(0, 40);
        let best = -1, bestScore = 0;
        const width = Math.max(...probe.map(r => r.length));
        for (let c = 0; c < width; c++) {
          let score = 0;
          probe.forEach(r => {
            const v = clean(r[c]);
            if (v && /^[#]?\d[\d\-\/]*$/.test(v)) score++;
          });
          if (score > bestScore) { bestScore = score; best = c; }
        }
        if (best < 0 || bestScore < 3) continue;
        headerRow = -1; col = best;
      }

      for (let r = headerRow + 1; r < grid.length; r++) {
        const v = clean((grid[r] || [])[col]);
        if (!v) continue;
        if (/^total$/i.test(v)) continue;
        numbers.push(v);
      }
    }

    const unique = [...new Set(numbers)];
    if (!unique.length) {
      return res.status(400).json({
        error: 'No invoice numbers found. Make sure the file has a column named "Ref no." or "Invoice number".'
      });
    }

    res.json({ count: unique.length, numbers: unique });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ==================== Negative items ====================
app.get('/api/negative-items', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  res.json({ items: await getNegativeItems(realmId) });
});

app.post('/api/negative-items', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  await setNegativeItems(realmId, req.body.items || []);
  res.json({ ok: true });
});

// ==================== QB products ====================
app.get('/api/qb-products', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  try {
    const token = await getAccessToken(realmId);
    const products = [];
    let start = 1;

    while (true) {
      const q = await qbQuery(realmId, token,
        `SELECT * FROM Item STARTPOSITION ${start} MAXRESULTS 1000`);
      const arr = q.Item || [];
      arr.forEach(it => {
        products.push({ id: it.Id, name: it.Name, sku: it.Sku || '', active: it.Active !== false });
      });
      if (arr.length < 1000) break;
      start += 1000;
      if (start > 9000) break;
    }

    res.json({ count: products.length, products });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== Item mappings ====================
app.get('/api/mappings', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  res.json({ mappings: await getMappings(realmId) });
});

app.post('/api/mappings', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const list = req.body.mappings || [];
  try {
    for (const m of list) {
      if (!m.key) continue;
      await saveMapping(realmId, m.key, m.sku, m.name, m.qbItem, m.skip);
    }
    res.json({ ok: true, saved: list.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== QB invoice numbers (windowed) ====================
app.get('/api/qb-invoices', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from and to dates required' });

  async function fetchWindow(token, a, b, depth) {
    const out = [];
    let start = 1;
    let hitCap = false;

    while (true) {
      const q = await qbQuery(realmId, token,
        `SELECT DocNumber, TxnDate FROM Invoice ` +
        `WHERE TxnDate >= '${a}' AND TxnDate <= '${b}' ` +
        `STARTPOSITION ${start} MAXRESULTS 1000`);
      const arr = q.Invoice || [];
      arr.forEach(inv => { if (inv.DocNumber) out.push(inv.DocNumber); });
      if (arr.length < 1000) break;
      start += 1000;
      if (start > 9000) { hitCap = true; break; }
    }

    if (hitCap && depth < 8 && a !== b) {
      const days = Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
      if (days >= 1) {
        const mid = shiftDays(a, Math.floor(days / 2));
        const left = await fetchWindow(token, a, mid, depth + 1);
        const right = await fetchWindow(token, shiftDays(mid, 1), b, depth + 1);
        return left.concat(right);
      }
    }
    return out;
  }

  try {
    const token = await getAccessToken(realmId);
    const all = [];
    let cursor = from, windows = 0;

    while (cursor <= to && windows < 400) {
      let end = shiftDays(cursor, 6);
      if (end > to) end = to;
      all.push(...await fetchWindow(token, cursor, end, 0));
      cursor = shiftDays(end, 1);
      windows++;
    }

    const numbers = [...new Set(all)];
    res.json({ count: numbers.length, numbers, windows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/gap-check', (req, res) => {
  const { qbNumbers = [], shopifyNumbers = [] } = req.body;

  const qbSet = new Set();
  const qbDigits = new Set();
  qbNumbers.forEach(n => {
    const k = normInv(n);
    if (k) qbSet.add(k);
    const d = digitsOf(n);
    if (d) qbDigits.add(d);
  });

  const missing = [];
  const present = [];
  const seen = new Set();

  shopifyNumbers.forEach(raw => {
    const k = normInv(raw);
    if (!k || seen.has(k)) return;
    seen.add(k);
    if (qbSet.has(k) || qbDigits.has(digitsOf(raw))) present.push(String(raw).trim());
    else missing.push(String(raw).trim());
  });

  res.json({
    inQb: qbNumbers.length,
    inShopify: seen.size,
    present: present.length,
    missing
  });
});

// ==================== Duplicate finder ====================
app.get('/api/qb-invoice-details', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from and to dates required' });

  async function fetchWindow(token, a, b, depth) {
    const out = [];
    let start = 1;
    let hitCap = false;

    while (true) {
      const q = await qbQuery(realmId, token,
        `SELECT Id, DocNumber, TxnDate, TotalAmt, Balance, SyncToken FROM Invoice ` +
        `WHERE TxnDate >= '${a}' AND TxnDate <= '${b}' ` +
        `STARTPOSITION ${start} MAXRESULTS 1000`);
      const arr = q.Invoice || [];
      arr.forEach(inv => {
        const total = Number(inv.TotalAmt || 0);
        const bal = Number(inv.Balance === undefined ? total : inv.Balance);
        out.push({
          id: inv.Id,
          doc: inv.DocNumber || '',
          date: inv.TxnDate || '',
          total: total,
          balance: bal,
          paid: total > 0 && bal <= 0.005,
          partial: bal > 0.005 && bal < total - 0.005,
          syncToken: inv.SyncToken
        });
      });
      if (arr.length < 1000) break;
      start += 1000;
      if (start > 9000) { hitCap = true; break; }
    }

    if (hitCap && depth < 8 && a !== b) {
      const days = Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
      if (days >= 1) {
        const mid = shiftDays(a, Math.floor(days / 2));
        const left = await fetchWindow(token, a, mid, depth + 1);
        const right = await fetchWindow(token, shiftDays(mid, 1), b, depth + 1);
        return left.concat(right);
      }
    }
    return out;
  }

  try {
    const token = await getAccessToken(realmId);
    const all = [];
    let cursor = from, windows = 0;

    while (cursor <= to && windows < 400) {
      let end = shiftDays(cursor, 6);
      if (end > to) end = to;
      all.push(...await fetchWindow(token, cursor, end, 0));
      cursor = shiftDays(end, 1);
      windows++;
    }

    const groups = new Map();
    all.forEach(inv => {
      const k = digitsOf(inv.doc);
      if (!k) return;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(inv);
    });

    const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;
    const isPaid = x => x.paid || x.partial;

    const cat = {
      bothUnpaid: [],
      hashPaid: [],
      plainPaid: [],
      bothPaid: [],
      amountDiffers: [],
      dupOnePaid: [],
      dupAllUnpaid: [],
      dupAllPaid: [],
      plainOnly: []
    };

    groups.forEach((list, k) => {
      const withHash = list.filter(x => x.doc.charAt(0) === '#');
      const plain = list.filter(x => x.doc.charAt(0) !== '#');

      [['hash', withHash], ['plain', plain]].forEach(pair => {
        const style = pair[0], copies = pair[1];
        if (copies.length < 2) return;
        const paidOnes = copies.filter(isPaid);
        const unpaidOnes = copies.filter(x => !isPaid(x));
        const entry = { digits: k, style, copies, paidOnes, unpaidOnes };
        if (!paidOnes.length) cat.dupAllUnpaid.push(entry);
        else if (!unpaidOnes.length) cat.dupAllPaid.push(entry);
        else cat.dupOnePaid.push(entry);
      });

      if (withHash.length === 1 && plain.length === 1) {
        const h = withHash[0], p = plain[0];
        const entry = { digits: k, hash: h, plain: p };
        if (!near(h.total, p.total)) cat.amountDiffers.push(entry);
        else if (!isPaid(h) && !isPaid(p)) cat.bothUnpaid.push(entry);
        else if (isPaid(h) && !isPaid(p)) cat.hashPaid.push(entry);
        else if (!isPaid(h) && isPaid(p)) cat.plainPaid.push(entry);
        else cat.bothPaid.push(entry);
      }

      if (plain.length === 1 && !withHash.length) cat.plainOnly.push(plain[0]);
    });

    res.json({ total: all.length, cat });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/invoice-rename', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const { id, newDoc } = req.body;
  if (!id || !newDoc) return res.status(400).json({ error: 'id and newDoc required' });

  try {
    const token = await getAccessToken(realmId);
    const q = await qbQuery(realmId, token, `SELECT * FROM Invoice WHERE Id = '${id}'`);
    const inv = (q.Invoice || [])[0];
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });

    const r = await fetch(`${API}/v3/company/${realmId}/invoice?minorversion=70`, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        Id: inv.Id,
        SyncToken: inv.SyncToken,
        sparse: true,
        DocNumber: newDoc
      })
    });

    const text = await r.text();
    if (!r.ok) {
      let msg = text.slice(0, 300);
      try {
        const f = JSON.parse(text).Fault;
        if (f && f.Error && f.Error.length) msg = `${f.Error[0].Message} | ${f.Error[0].Detail || ''}`;
      } catch (e) {}
      return res.status(400).json({ error: msg });
    }

    res.json({ ok: true, id: inv.Id, newDoc });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/invoice-delete', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'id required' });

  try {
    const token = await getAccessToken(realmId);
    const q = await qbQuery(realmId, token, `SELECT * FROM Invoice WHERE Id = '${id}'`);
    const inv = (q.Invoice || [])[0];
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });

    const r = await fetch(`${API}/v3/company/${realmId}/invoice?operation=delete&minorversion=70`, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({ Id: inv.Id, SyncToken: inv.SyncToken })
    });

    const text = await r.text();
    if (!r.ok) {
      let msg = text.slice(0, 300);
      try {
        const f = JSON.parse(text).Fault;
        if (f && f.Error && f.Error.length) msg = `${f.Error[0].Message} | ${f.Error[0].Detail || ''}`;
      } catch (e) {}
      return res.status(400).json({ error: msg });
    }

    await logUpload(realmId, inv.DocNumber, 'deleted', `QB Id ${inv.Id} removed as a duplicate`, null);
    res.json({ ok: true, id: inv.Id, doc: inv.DocNumber });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// ==================== Dashboard ====================
app.get('/api/dashboard', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const today = new Date().toISOString().slice(0, 10);
  const from = req.query.from || (today.slice(0, 8) + '01');
  const to   = req.query.to   || today;
  const fresh = req.query.fresh === '1';
  const cacheKey = `dash:${from}:${to}`;

  // served straight from the last snapshot unless a refresh was asked for
  if (!fresh) {
    try {
      const hit = await getCache(realmId, cacheKey, 900);
      if (hit) {
        return res.json(Object.assign({}, hit.value, {
          cached: true,
          ageSeconds: hit.ageSeconds
        }));
      }
    } catch (e) { /* fall through and rebuild */ }
  }

  const last30 = shiftDays(to, -29);

  try {
    const token = await getAccessToken(realmId);

    // one window per month keeps the round trips down
    function monthEnd(iso) {
      const d = new Date(iso + 'T00:00:00Z');
      const e = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
      return e.toISOString().slice(0, 10);
    }

    const invoices = [];
    let cursor = from, windows = 0;

    while (cursor <= to && windows < 40) {
      let end = monthEnd(cursor);
      if (end > to) end = to;

      let start = 1;
      let hitCap = false;
      while (true) {
        const q = await qbQuery(realmId, token,
          `SELECT DocNumber, TxnDate, TotalAmt, Balance FROM Invoice ` +
          `WHERE TxnDate >= '${cursor}' AND TxnDate <= '${end}' ` +
          `STARTPOSITION ${start} MAXRESULTS 1000`);
        const arr = q.Invoice || [];
        arr.forEach(i => invoices.push({
          doc: i.DocNumber || '',
          date: i.TxnDate,
          total: Number(i.TotalAmt || 0),
          balance: Number(i.Balance === undefined ? i.TotalAmt : i.Balance)
        }));
        if (arr.length < 1000) break;
        start += 1000;
        if (start > 9000) { hitCap = true; break; }
      }

      // that month was too busy — walk it a week at a time instead
      if (hitCap) {
        let sub = cursor;
        while (sub <= end) {
          let subEnd = shiftDays(sub, 6);
          if (subEnd > end) subEnd = end;
          let s = 1;
          while (true) {
            const q = await qbQuery(realmId, token,
              `SELECT DocNumber, TxnDate, TotalAmt, Balance FROM Invoice ` +
              `WHERE TxnDate >= '${sub}' AND TxnDate <= '${subEnd}' ` +
              `STARTPOSITION ${s} MAXRESULTS 1000`);
            const arr = q.Invoice || [];
            arr.forEach(i => invoices.push({
              doc: i.DocNumber || '',
              date: i.TxnDate,
              total: Number(i.TotalAmt || 0),
              balance: Number(i.Balance === undefined ? i.TotalAmt : i.Balance)
            }));
            if (arr.length < 1000) break;
            s += 1000;
            if (s > 9000) break;
          }
          sub = shiftDays(subEnd, 1);
        }
      }

      cursor = shiftDays(end, 1);
      windows++;
    }

    // drop anything the month walk picked up twice
    const seen = new Set();
    const clean = [];
    invoices.forEach(i => {
      const k = i.doc + '|' + i.date + '|' + i.total;
      if (seen.has(k)) return;
      seen.add(k);
      clean.push(i);
    });

    let invoiced = 0, outstanding = 0, paidCount = 0, plainCount = 0;
    const byDay = new Map();

    clean.forEach(i => {
      invoiced += i.total;
      outstanding += i.balance;
      if (i.balance <= 0.005 && i.total > 0) paidCount++;
      if (i.doc && i.doc.charAt(0) !== '#') plainCount++;
      if (i.date) byDay.set(i.date, (byDay.get(i.date) || 0) + i.total);
    });

    const daily = [];
    let d = from, guard = 0;
    while (d <= to && guard < 400) {
      daily.push({ date: d, amount: Math.round((byDay.get(d) || 0) * 100) / 100 });
      d = shiftDays(d, 1);
      guard++;
    }

    let received = 0, paymentCount = 0;
    try {
      let s = 1;
      while (true) {
        const q = await qbQuery(realmId, token,
          `SELECT TotalAmt, TxnDate FROM Payment ` +
          `WHERE TxnDate >= '${last30}' AND TxnDate <= '${to}' ` +
          `STARTPOSITION ${s} MAXRESULTS 1000`);
        const arr = q.Payment || [];
        arr.forEach(p => { received += Number(p.TotalAmt || 0); paymentCount++; });
        if (arr.length < 1000) break;
        s += 1000;
        if (s > 9000) break;
      }
    } catch (e) { /* payments are optional here */ }

    let runs = [];
    try { runs = await listRuns(realmId, 8); } catch (e) {}

    let couriers = [];
    try { couriers = await runsSummary(realmId); } catch (e) {}

    const payload = {
      period: { from, to },
      invoiceCount: clean.length,
      invoiced, outstanding, paidCount, plainCount,
      received, paymentCount,
      daily, runs, couriers
    };

    try { await setCache(realmId, cacheKey, payload); } catch (e) {}

    res.json(Object.assign({}, payload, { cached: false, ageSeconds: 0 }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// ==================== Google Sheets ====================
app.get('/api/sheets/test', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  try {
    const user = await testConnection();
    res.json({ ok: true, account: user.emailAddress || user.displayName });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/sheets/list', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const folderId = req.query.folderId;
  if (!folderId) return res.status(400).json({ error: 'folderId required' });

  try {
    const files = await listSheets(folderId);
    res.json({ count: files.length, files });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/sheets/tabs', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const sheetId = req.query.sheetId;
  if (!sheetId) return res.status(400).json({ error: 'sheetId required' });

  try {
    res.json({ tabs: await listTabs(sheetId) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/sheets/read', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const { sheetId, tab } = req.query;
  if (!sheetId || !tab) return res.status(400).json({ error: 'sheetId and tab required' });

  try {
    const rows = await readTab(sheetId, tab);
    res.json({ rowCount: rows.length, rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/sheets/paint', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const { sheetId, tabId, colours, width } = req.body;
  if (!sheetId || tabId === undefined || !Array.isArray(colours)) {
    return res.status(400).json({ error: 'sheetId, tabId and colours required' });
  }

  try {
    await paintRows(sheetId, tabId, colours, width);
    res.json({ ok: true, painted: colours.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// ==================== CPR / Receive payments ====================

// the root Drive folder, saved once per company
app.get('/api/cpr/root', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  try {
    res.json({ folderId: await getSetting(realmId, 'cpr:root', '') });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/cpr/root', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  let id = String(req.body.folderId || '').trim();
  // people paste the whole Drive URL — pull the id out of it
  const m = id.match(/[-\w]{25,}/);
  if (m) id = m[0];
  if (!id) return res.status(400).json({ error: 'Folder ID or link required' });

  try {
    await setSetting(realmId, 'cpr:root', id);
    res.json({ ok: true, folderId: id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// couriers = the folders sitting in the root
app.get('/api/cpr/couriers', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  try {
    const root = await getSetting(realmId, 'cpr:root', '');
    if (!root) return res.status(400).json({ error: 'Set the Drive folder first' });
    res.json({ folders: await listFolders(root) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// months = the folders inside a courier, sheets = what is inside a month
app.get('/api/cpr/folder', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'id required' });

  try {
    const [folders, sheets] = await Promise.all([listFolders(id), listSheetsIn(id)]);
    res.json({ folders, sheets });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// open a sheet: work out the columns, list the CPRs inside it
app.get('/api/cpr/open', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const { sheetId, courier } = req.query;
  const excel = req.query.excel === '1';
  if (!sheetId) return res.status(400).json({ error: 'sheetId required' });

  try {
    const tabs = await listTabs(sheetId, excel);
    if (!tabs.length) return res.status(400).json({ error: 'That file has no tabs' });

    const tab = req.query.tab || tabs[0].title;
    const saved = courier ? await getSetting(realmId, `cpr:cols:${courier}`, null) : null;

    const data = await loadSheet(sheetId, tab, excel, saved);
    const hasStatus = data.cols.status >= 0;
    const groups = groupByCpr(data.rows, hasStatus);

    res.json({
      tabs, tab,
      header: data.header,
      cols: data.cols,
      hasStatus,
      remembered: !!saved,
      rowCount: data.rows.length,
      groups: groups.map(g => ({
        cprNumber: g.cprNumber,
        cprDate: g.cprDate,
        rows: g.rows.length,
        delivered: g.delivered,
        amount: Math.round(g.amount * 100) / 100
      }))
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// remember this courier's column choices
app.post('/api/cpr/columns', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const { courier, cols } = req.body;
  if (!courier || !cols) return res.status(400).json({ error: 'courier and cols required' });

  try {
    await setSetting(realmId, `cpr:cols:${courier}`, cols);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// QB dropdowns
app.get('/api/cpr/qb-options', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  try {
    const token = await getAccessToken(realmId);
    const [accounts, methods] = await Promise.all([
      listAccounts(realmId, token),
      listPaymentMethods(realmId, token)
    ]);
    const prefs = await getSetting(realmId, 'cpr:prefs', {}) || {};
    res.json({ accounts, methods, prefs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// match one CPR against QuickBooks
app.get('/api/cpr/match', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const { sheetId, tab, courier, cpr } = req.query;
  const excel = req.query.excel === '1';
  if (!sheetId || !tab) return res.status(400).json({ error: 'sheetId and tab required' });

  try {
    const saved = courier ? await getSetting(realmId, `cpr:cols:${courier}`, null) : null;
    const data = await loadSheet(sheetId, tab, excel, saved);
    const hasStatus = data.cols.status >= 0;

    let rows = data.rows;
    if (cpr) rows = rows.filter(r => (r.cprNumber || '(no CPR number)') === cpr);
    if (!rows.length) return res.status(400).json({ error: 'No rows for that CPR' });

    const delivered = rows.filter(r => isDelivered(r, hasStatus));
    const skipped = rows.length - delivered.length;

    const token = await getAccessToken(realmId);
    const found = await findInvoices(realmId, token, delivered.map(r => r.invoice));

    const matched = [], amountOff = [], notInQb = [], alreadyPaid = [];

    delivered.forEach(r => {
      const inv = found.get(cprDigits(r.invoice));
      if (!inv) { notInQb.push(r); return; }

      const entry = {
        sheetRow: r.sheetRow,
        invoice: r.invoice,
        sheetAmount: r.amount,
        qbDoc: inv.doc,
        qbId: inv.id,
        qbTotal: inv.total,
        qbBalance: inv.balance,
        customerId: inv.customerId,
        customerName: inv.customerName,
        date: inv.date
      };

      if (inv.balance <= 0.005) { alreadyPaid.push(entry); return; }
      if (r.amount > 0 && Math.abs(r.amount - inv.balance) > 0.5) { amountOff.push(entry); return; }
      matched.push(entry);
    });

    // one payment per customer — QB will not mix two customers in one
    const byCustomer = new Map();
    matched.forEach(m => {
      const k = m.customerId || 'none';
      if (!byCustomer.has(k)) {
        byCustomer.set(k, { customerId: m.customerId, customerName: m.customerName, lines: [], amount: 0 });
      }
      const g = byCustomer.get(k);
      g.lines.push(m);
      g.amount += (m.sheetAmount > 0 ? m.sheetAmount : m.qbBalance);
    });

    const first = rows[0] || {};
    res.json({
      cprNumber: first.cprNumber || '',
      cprDate: first.cprDate || null,
      totals: {
        sheetRows: rows.length,
        skipped,
        matched: matched.length,
        amountOff: amountOff.length,
        notInQb: notInQb.length,
        alreadyPaid: alreadyPaid.length,
        amount: Math.round(matched.reduce((s, m) => s + (m.sheetAmount > 0 ? m.sheetAmount : m.qbBalance), 0) * 100) / 100
      },
      payments: Array.from(byCustomer.values()).map(g => ({
        customerId: g.customerId,
        customerName: g.customerName,
        count: g.lines.length,
        amount: Math.round(g.amount * 100) / 100
      })),
      matched, amountOff, notInQb, alreadyPaid,
      width: data.width
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// post the payments
app.post('/api/cpr/receive', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const {
    courier, cprNumber, cprDate, accountId, accountName, methodId,
    matched = [], sheetId, tabId, width, paint = true
  } = req.body;

  if (!accountId) return res.status(400).json({ error: 'Deposit account required' });
  if (!matched.length) return res.status(400).json({ error: 'Nothing to receive' });

  try {
    const token = await getAccessToken(realmId);

    // group by customer again, on the server this time
    const byCustomer = new Map();
    matched.forEach(m => {
      const k = m.customerId || 'none';
      if (!byCustomer.has(k)) byCustomer.set(k, []);
      byCustomer.get(k).push(m);
    });

    const ref = [cprNumber, cprDate].filter(Boolean).join(' · ').slice(0, 21);
    const results = [];
    const paintedRows = [];
    let posted = 0, totalAmount = 0;

    for (const [custId, lines] of byCustomer) {
      if (!custId || custId === 'none') {
        results.push({ ok: false, msg: 'Invoices with no customer were skipped', count: lines.length });
        continue;
      }

      const amount = lines.reduce((s, m) => s + (m.sheetAmount > 0 ? m.sheetAmount : m.qbBalance), 0);

      const payload = {
        CustomerRef: { value: String(custId) },
        TotalAmt: Math.round(amount * 100) / 100,
        DepositToAccountRef: { value: String(accountId) },
        Line: lines.map(m => ({
          Amount: Math.round((m.sheetAmount > 0 ? m.sheetAmount : m.qbBalance) * 100) / 100,
          LinkedTxn: [{ TxnId: String(m.qbId), TxnType: 'Invoice' }]
        }))
      };
      if (cprDate) payload.TxnDate = cprDate;
      if (methodId) payload.PaymentMethodRef = { value: String(methodId) };
      if (ref) payload.PaymentRefNum = ref;
      if (cprNumber) payload.PrivateNote = `CPR ${cprNumber}${cprDate ? ' dated ' + cprDate : ''}`;

      const r = await postPayment(realmId, token, payload);

      if (r.ok) {
        posted++;
        totalAmount += amount;
        lines.forEach(m => { if (m.sheetRow) paintedRows.push({ row: m.sheetRow, colour: 'green' }); });
        results.push({
          ok: true, customer: lines[0].customerName || custId,
          count: lines.length, amount: Math.round(amount * 100) / 100, paymentId: r.id
        });
      } else {
        results.push({ ok: false, customer: lines[0].customerName || custId, count: lines.length, msg: r.msg });
      }
    }

    if (paint && sheetId && tabId !== undefined && paintedRows.length) {
      try { await paintRows(sheetId, Number(tabId), paintedRows, width || 40); }
      catch (e) { results.push({ ok: false, msg: 'Payments went through, colouring the sheet failed: ' + e.message }); }
    }

    try {
      await recordRun(realmId, {
        courier, cprNumber, cprDate, sheetId,
        matched: matched.length, unmatched: 0,
        amount: Math.round(totalAmount * 100) / 100,
        qbPaymentId: (results.find(x => x.ok) || {}).paymentId || null,
        bankAccount: accountName || null
      });
    } catch (e) {}

    if (accountId || methodId) {
      try {
        const prefs = (await getSetting(realmId, 'cpr:prefs', {})) || {};
        if (courier) prefs[courier] = { accountId, methodId };
        await setSetting(realmId, 'cpr:prefs', prefs);
      } catch (e) {}
    }

    res.json({ ok: posted > 0, posted, results, painted: paintedRows.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// ==================== Upload ====================
function buildPayload(inv, customerId, itemMap, termMap, negSet) {
  const lines = [];

  for (const L of inv.lines) {
    const itemId = itemMap[L.item.toLowerCase()];
    if (!itemId) throw new Error(`Item not found in QuickBooks: "${L.item}"`);

    let amount = L.amt;
    let rate = L.rate || L.amt;
    if (negSet.has(L.item.toLowerCase())) {
      amount = -Math.abs(amount);
      rate = -Math.abs(rate);
    }

    const detail = { ItemRef: { value: itemId }, Qty: L.qty, UnitPrice: rate };
    if (L.svc) detail.ServiceDate = L.svc;

    const line = { DetailType: 'SalesItemLineDetail', Amount: amount, SalesItemLineDetail: detail };
    if (L.desc) line.Description = L.desc;
    lines.push(line);
  }

  const p = { DocNumber: inv.docNumber, CustomerRef: { value: customerId }, Line: lines };
  if (inv.txnDate) p.TxnDate = inv.txnDate;
  if (inv.dueDate) p.DueDate = inv.dueDate;
  if (inv.memo) p.CustomerMemo = { value: inv.memo };

  const termId = termMap[(inv.terms || '').toLowerCase()];
  if (termId) p.SalesTermRef = { value: termId };

  return p;
}

const cancelFlags = new Map();

function sleepUnlessCancelled(ms, realmId, isGone) {
  return new Promise(resolve => {
    const step = 250;
    let waited = 0;
    const t = setInterval(() => {
      waited += step;
      if (waited >= ms || cancelFlags.get(realmId) || isGone()) {
        clearInterval(t);
        resolve();
      }
    }, step);
  });
}

app.post('/api/upload-cancel', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  cancelFlags.set(realmId, true);
  res.json({ ok: true });
});

app.post('/api/upload', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const { invoices, delay = 1500, negativeItems = [] } = req.body;
  if (!Array.isArray(invoices) || !invoices.length) {
    return res.status(400).json({ error: 'No invoices provided' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = obj => {
    try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch (e) {}
  };
  const negSet = new Set(negativeItems.map(s => String(s).toLowerCase()));

  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (e) {}
  }, 10000);

  let clientGone = false;
  req.on('close', () => {
    clientGone = true;
    clearInterval(heartbeat);
    cancelFlags.set(realmId, true);
  });
  const isGone = () => clientGone;

  try {
    send({ type: 'log', msg: 'Connecting to QuickBooks...' });
    const token = await getAccessToken(realmId);

    send({ type: 'log', msg: 'Loading products...' });
    const itemMap = await loadItems(realmId, token);
    send({ type: 'log', msg: `Products loaded: ${Object.keys(itemMap).length}` });

    const termMap = await loadTerms(realmId, token);
    const custCache = {};

    let done = 0, failed = 0;
    const failedList = [];
    const doneList = [];
    let cancelled = false;

    cancelFlags.delete(realmId);

    for (let i = 0; i < invoices.length; i++) {
      if (clientGone || cancelFlags.get(realmId)) {
        cancelled = true;
        cancelFlags.delete(realmId);
        const remaining = invoices.slice(i).map(x => x.docNumber);
        send({ type: 'cancelled', done, failed, doneList, failedList, remaining });
        break;
      }

      const inv = invoices[i];
      let success = false, lastErr = '';

      for (let attempt = 1; attempt <= 5; attempt++) {
        if (clientGone || cancelFlags.get(realmId)) break;
        try {
          const custId = await getOrCreateCustomer(realmId, token, inv.customer, custCache);
          const payload = buildPayload(inv, custId, itemMap, termMap, negSet);
          const result = await postInvoice(realmId, token, payload);

          if (result.ok) {
            send({ type: 'ok', doc: inv.docNumber, id: result.id });
            await logUpload(realmId, inv.docNumber, 'success', `QB Id ${result.id}`, result.tid);
            success = true;
            break;
          }

          lastErr = `${result.msg} [tid=${result.tid}]`;
          if (!result.retryable) break;

          send({ type: 'retry', doc: inv.docNumber, attempt, msg: result.msg.slice(0, 100) });
          await sleepUnlessCancelled(attempt * 5000, realmId, isGone);

        } catch (e) {
          lastErr = e.message;
          if (/not found in QuickBooks/.test(e.message)) break;
          send({ type: 'retry', doc: inv.docNumber, attempt, msg: e.message.slice(0, 100) });
          await sleepUnlessCancelled(attempt * 5000, realmId, isGone);
        }
      }

      if (success) { done++; doneList.push(inv.docNumber); }
      else {
        failed++;
        failedList.push(inv.docNumber);
        send({ type: 'fail', doc: inv.docNumber, msg: lastErr.slice(0, 250) });
        await logUpload(realmId, inv.docNumber, 'failed', lastErr, null);
      }

      send({ type: 'progress', done, failed, total: invoices.length, current: i + 1 });
      if (i < invoices.length - 1) {
        await sleepUnlessCancelled(Number(delay), realmId, isGone);
      }
    }

    if (!cancelled) send({ type: 'complete', done, failed, doneList, failedList });
    clearInterval(heartbeat);
    res.end();

  } catch (err) {
    cancelFlags.delete(realmId);
    send({ type: 'error', msg: err.message });
    clearInterval(heartbeat);
    res.end();
  }
});

// ==================== Start ====================
const PORT = process.env.PORT || 3000;

initDb()
  .then(() => initMappings())
  .then(() => initUsers())
  .then(() => initSettings())
  .then(() => initCache())
  .then(() => app.listen(PORT, () => console.log(`Server running on port ${PORT}`)))
  .catch(err => {
    console.error('DB init failed:', err);
    process.exit(1);
  });
