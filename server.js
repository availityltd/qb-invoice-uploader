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
import {
  initUsers, upsertUser, getUser, linkCompany, userOwns, companiesForUser
} from './users.js';
import {
  getAccessToken, getCompanyInfo, loadItems, loadTerms,
  getOrCreateCustomer, postInvoice, qbQuery
} from './qb.js';

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

app.use(cookieParser());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

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

    // who is this person?
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
      return res.status(400).send(
        'Could not identify your Intuit account. Please try signing in again.'
      );
    }

    await upsertUser(sub, email, name);
    res.cookie('uid', sign(sub), { httpOnly: true, maxAge: 60 * 24 * 3600 * 1000, sameSite: 'lax' });

    // a company was authorised too
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
      if (start > 20000) break;
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

// ==================== Gap check ====================
app.get('/api/qb-invoices', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from and to dates required' });

  try {
    const token = await getAccessToken(realmId);
    const numbers = [];
    let start = 1;

    while (true) {
      const q = await qbQuery(realmId, token,
        `SELECT DocNumber, TxnDate FROM Invoice ` +
        `WHERE TxnDate >= '${from}' AND TxnDate <= '${to}' ` +
        `STARTPOSITION ${start} MAXRESULTS 1000`);
      const arr = q.Invoice || [];
      arr.forEach(inv => { if (inv.DocNumber) numbers.push(inv.DocNumber); });
      if (arr.length < 1000) break;
      start += 1000;
      if (start > 20000) break;
    }

    res.json({ count: numbers.length, numbers });
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

const sleep = ms => new Promise(r => setTimeout(r, ms));

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
  res.flushHeaders();

  const send = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const negSet = new Set(negativeItems.map(s => String(s).toLowerCase()));

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

    for (let i = 0; i < invoices.length; i++) {
      const inv = invoices[i];
      let success = false, lastErr = '';

      for (let attempt = 1; attempt <= 5; attempt++) {
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
          await sleep(attempt * 3000);

        } catch (e) {
          lastErr = e.message;
          if (/not found in QuickBooks/.test(e.message)) break;
          send({ type: 'retry', doc: inv.docNumber, attempt, msg: e.message.slice(0, 100) });
          await sleep(attempt * 3000);
        }
      }

      if (success) done++;
      else {
        failed++;
        failedList.push(inv.docNumber);
        send({ type: 'fail', doc: inv.docNumber, msg: lastErr.slice(0, 250) });
        await logUpload(realmId, inv.docNumber, 'failed', lastErr, null);
      }

      send({ type: 'progress', done, failed, total: invoices.length, current: i + 1 });
      if (i < invoices.length - 1) await sleep(Number(delay));
    }

    send({ type: 'complete', done, failed, failedList });
    res.end();

  } catch (err) {
    send({ type: 'error', msg: err.message });
    res.end();
  }
});

// ==================== Start ====================
const PORT = process.env.PORT || 3000;

initDb()
  .then(() => initMappings())
  .then(() => initUsers())
  .then(() => app.listen(PORT, () => console.log(`Server running on port ${PORT}`)))
  .catch(err => {
    console.error('DB init failed:', err);
    process.exit(1);
  });
