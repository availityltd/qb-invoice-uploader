import { getCompany, updateRefreshToken } from './db.js';

const API = 'https://quickbooks.api.intuit.com';
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

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

  if (data.refresh_token && data.refresh_token !== company.refresh_token) {
    await updateRefreshToken(realmId, data.refresh_token);
  }

  return data.access_token;
}

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

export async function getCompanyInfo(realmId, token) {
  const url = `${API}/v3/company/${realmId}/companyinfo/${realmId}?minorversion=70`;
  const res = await qbFetch(url, token);
  if (!res.ok) throw new Error('CompanyInfo failed: ' + res.status);
  const json = await res.json();
  return json.CompanyInfo;
}

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
    if (fault && fault.Error && fault.Error.length) {
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
// Send up to 30 invoices in one request. QuickBooks still writes them one
// after another, but the network trip happens once instead of thirty times.
export async function postInvoiceBatch(realmId, token, payloads) {
  const body = {
    BatchItemRequest: payloads.map((p, i) => ({
      bId: String(i),
      operation: 'create',
      Invoice: p
    }))
  };

  const res = await qbFetch(
    `${API}/v3/company/${realmId}/batch?minorversion=70`,
    token,
    { method: 'POST', body: JSON.stringify(body) }
  );

  const tid = tidOf(res);

  // the whole batch was refused - hand the same verdict back for every line
  if (!res.ok) {
    const text = await res.text();
    let msg = text.slice(0, 300);
    try {
      const f = JSON.parse(text).Fault;
      if (f && f.Error && f.Error.length) {
        msg = `${f.Error[0].Message} | ${f.Error[0].Detail || ''}`;
      }
    } catch (e) {}
    return payloads.map((p, i) => ({
      index: i,
      ok: false,
      status: res.status,
      msg,
      tid,
      retryable: isRetryable(msg, res.status)
    }));
  }

  const json = await res.json();
  const list = json.BatchItemResponse || [];
  const out = payloads.map((p, i) => ({
    index: i,
    ok: false,
    status: 0,
    msg: 'QuickBooks sent no answer for this invoice',
    tid,
    retryable: true
  }));

  list.forEach(item => {
    const i = Number(item.bId);
    if (isNaN(i) || i < 0 || i >= out.length) return;

    if (item.Invoice && item.Invoice.Id) {
      out[i] = { index: i, ok: true, id: item.Invoice.Id, tid };
      return;
    }

    let msg = 'Unknown error';
    let status = 400;
    if (item.Fault && item.Fault.Error && item.Fault.Error.length) {
      const e = item.Fault.Error[0];
      msg = `${e.Message || ''} | ${e.Detail || ''}`.trim();
      if (e.code) status = Number(e.code) || 400;
    }

    out[i] = {
      index: i,
      ok: false,
      status,
      msg,
      tid,
      retryable: isRetryable(msg, status)
    };
  });

  return out;
}

// QuickBooks' own reports, read as they come. The books hold things a query
// cannot reach - what a sale cost, what stock is worth - and those only come out
// of a report. Read-only: a report is asked for, nothing is written.
export async function qbReport(realmId, token, name, params = {}) {
  const q = new URLSearchParams({ minorversion: '70' });
  Object.keys(params).forEach(k => {
    if (params[k] !== undefined && params[k] !== null && params[k] !== '') q.set(k, params[k]);
  });

  const url = `${API}/v3/company/${realmId}/reports/${name}?${q}`;
  const res = await qbFetch(url, token);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Report ${name} failed (${res.status}) tid=${tidOf(res)}: ${text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`Report ${name} came back unreadable: ${text.slice(0, 200)}`);
  }
}

// The same query, for the reads where an empty answer has to mean empty.
//
// QuickBooks does not always fail with a failing status. Throttled, or asked
// something it will not answer, it can come back 200 with a Fault in the body and
// no QueryResponse at all - and qbQuery hands that on as an empty list. For a
// scan of the books that is the worst answer there is: "0 transactions read" in
// green, over seventeen months, with the real reason thrown away. This says the
// reason instead. qbQuery itself is left as it is, because every other page in
// the app already leans on how it behaves.
export async function qbQueryStrict(realmId, token, sql) {
  const url = `${API}/v3/company/${realmId}/query?query=${encodeURIComponent(sql)}&minorversion=70`;
  const res = await qbFetch(url, token);
  const text = await res.text();

  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* said below */ }

  const fault = json && json.Fault && ((json.Fault.Error || [])[0] || {});
  if (!res.ok || fault || !json) {
    const why = fault
      ? (fault.Message || 'QuickBooks refused the read') + (fault.Detail ? ' - ' + fault.Detail : '')
      : text.slice(0, 300);
    throw new Error(`Query failed (${res.status}) tid=${tidOf(res)}: ${why}`);
  }

  if (!json.QueryResponse) {
    throw new Error(`QuickBooks answered without a result (${res.status}) tid=${tidOf(res)}`);
  }
  return json.QueryResponse;
}
