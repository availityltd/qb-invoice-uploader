import { getCompany, updateRefreshToken } from './db.js';

const API = 'https://quickbooks.api.intuit.com';
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

// ---------- Token ----------
export async function getAccessToken(realmId) {
  const company = await getCompany(realmId);
  if (!company) throw new Error('Company not connected');

  const basic = Buffer.from(
    `${process.env.QB_CLIENT_ID}:${process.env.QB_CLIENT_SECRET}`
  ).toString('base64');

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + basic,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json'
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: company.refresh_token
    })
  });

  const data = await res.json();
  if (!data.access_token) {
    throw new Error('Token refresh failed: ' + JSON.stringify(data).slice(0, 200));
  }

  // Intuit rotates refresh tokens
  if (data.refresh_token && data.refresh_token !== company.refresh_token) {
    await updateRefreshToken(realmId, data.refresh_token);
  }

  return data.access_token;
}

// ---------- Helpers ----------
function tidOf(res) {
  return res.headers.get('intuit_tid') || '';
}

async function qbFetch(url, token, options = {}) {
  return fetch(url, {
    ...options,
    headers: {
      'Authorization': 'Bearer ' + token,
      'Accept': 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });
}

export async function qbQuery(realmId, token, sql) {
  const url = `${API}/v3/company/${realmId}/query?query=${encodeURIComponent(sql)}&minorversion=70`;
  const res = await qbFetch(url, token);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Query failed (${res.status}) tid=${tidOf(res)}: ${text.slice(0, 300)}`);
  }
  const json = await res.json();
  return json.QueryResponse || {};
}

// ---------- Company info ----------
export async function getCompanyInfo(realmId, token) {
  const url = `${API}/v3/company/${realmId}/companyinfo/${realmId}?minorversion=70`;
  const res = await qbFetch(url, token);
  if (!res.ok) throw new Error('CompanyInfo failed: ' + res.status);
  const json = await res.json();
  return json.CompanyInfo;
}

// ---------- Reference data ----------
export async function loadItems(realmId, token) {
  const map = {};
  let start = 1;
  while (true) {
    const q = await qbQuery(realmId, token,
      `SELECT Id, Name FROM Item STARTPOSITION ${start} MAXRESULTS 1000`);
    const arr = q.Item || [];
    arr.forEach(i => { map[i.Name.toLowerCase()] = i.Id; });
    if (arr.length < 1000) break;
    start += 1000;
  }
  return map;
}

export async function loadTerms(realmId, token) {
  const map = {};
  const q = await qbQuery(realmId, token, 'SELECT Id, Name FROM Term MAXRESULTS 200');
  (q.Term || []).forEach(t => { map[t.Name.toLowerCase()] = t.Id; });
  return map;
}

export async function getOrCreateCustomer(realmId, token, name, cache) {
  const key = name.toLowerCase();
  if (cache[key]) return cache[key];

  const esc = name.replace(/'/g, "\\'");
  const q = await qbQuery(realmId, token,
    `SELECT Id, DisplayName FROM Customer WHERE DisplayName = '${esc}'`);

  if (q.Customer && q.Customer.length) {
    cache[key] = q.Customer[0].Id;
    return cache[key];
  }

  const res = await qbFetch(
    `${API}/v3/company/${realmId}/customer?minorversion=70`,
    token,
    { method: 'POST', body: JSON.stringify({ DisplayName: name }) }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Customer create failed tid=${tidOf(res)}: ${text.slice(0, 300)}`);
  }

  const json = await res.json();
  cache[key] = json.Customer.Id;
  return cache[key];
}

// ---------- Invoice ----------
export async function postInvoice(realmId, token, payload) {
  const res = await qbFetch(
    `${API}/v3/company/${realmId}/invoice?minorversion=70`,
    token,
    { method: 'POST', body: JSON.stringify(payload) }
  );

  const tid = tidOf(res);

  if (res.ok) {
    const json = await res.json();
    return { ok: true, id: json.Invoice.Id, tid };
  }

  const text = await res.text();
  let msg = text.slice(0, 400);
  try {
    const fault = JSON.parse(text).Fault;
    if (fault?.Error?.length) {
      msg = `${fault.Error[0].Message} | ${fault.Error[0].Detail || ''}`;
    }
  } catch (e) { /* keep raw */ }

  return {
    ok: false,
    status: res.status,
    msg,
    tid,
    retryable: isRetryable(msg, res.status)
  };
}

export function isRetryable(msg, status) {
  if (status === 429 || status >= 500) return true;
  return /another user was creating|try again|deadlock|timeout|throttl/i.test(msg);
}
