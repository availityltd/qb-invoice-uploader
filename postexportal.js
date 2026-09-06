// The PostEx merchant portal, which is not the same thing as the PostEx
// integration API in postex.js.
//
//   postex.js       token header, long lived, knows about orders
//   this file       Bearer JWT, five hours, knows about cash payment receipts
//
// Everything the portal's own screens show comes from here. The sign-in is
// done again whenever it is about to run out, so nothing has to be pasted in
// by hand.

const BASE = 'https://api.postex.pk/services/merchant/api/';

/* ==================== talking to it ==================== */

async function call(path, { method = 'GET', jwt, body, params } = {}) {
  const url = new URL(BASE + path);
  Object.keys(params || {}).forEach(k => {
    const v = params[k];
    if (v === undefined || v === null || v === '') return;
    if (Array.isArray(v)) v.forEach(x => url.searchParams.append(k, x));
    else url.searchParams.set(k, v);
  });

  const headers = {
    'accept': 'application/json, text/plain, */*',
    'origin': 'https://merchant.postex.pk',
    'referer': 'https://merchant.postex.pk/'
  };
  if (jwt) headers.authorization = 'Bearer ' + jwt;
  if (body) headers['content-type'] = 'application/json';

  const r = await fetch(url.toString(), {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });

  const text = await r.text();

  if (r.status === 401 || r.status === 403) {
    const e = new Error('PostEx sign-in has expired');
    e.expired = true;
    throw e;
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error('PostEx sent something that was not JSON: ' + text.slice(0, 200));
  }

  if (!r.ok) {
    throw new Error(`PostEx said ${r.status}: ` +
      (json.statusMessage || json.message || text.slice(0, 200)));
  }

  return json;
}

/* ==================== signing in ==================== */

// What the portal itself sends. The last three are not checked but the
// endpoint wants them present.
export async function login(email, password) {
  const j = await call('user/login', {
    method: 'POST',
    body: {
      email: String(email || '').trim(),
      password: String(password || ''),
      appName: 'postex',
      regionName: 'Lahore',
      versionId: '1'
    }
  });

  // A wrong password still comes back as HTTP 200, with the real answer in
  // the body. 404 is what the portal itself reads as "invalid credentials".
  if (String(j.statusCode) === '404') {
    throw new Error('PostEx did not accept that email and password');
  }
  if (String(j.statusCode) !== '200') {
    throw new Error(j.statusMessage || 'PostEx would not sign in');
  }

  const d = j.dist || {};
  const jwt = d.jwtToken || '';
  if (!jwt) throw new Error('PostEx signed in but sent no token back');

  return { jwt, ...readJwt(jwt) };
}

// The merchant id, the name and the expiry are all inside the token already.
export function readJwt(jwt) {
  try {
    const body = String(jwt).split('.')[1];
    const j = JSON.parse(Buffer.from(body, 'base64').toString('utf8'));
    const d = j.userDetails || {};
    return {
      merchantId: d.merchantId ? String(d.merchantId) : null,
      merchantName: d.merchantName || '',
      userId: d.userId ? String(d.userId) : null,
      email: j.sub || '',
      expiresAt: j.exp ? j.exp * 1000 : 0
    };
  } catch (e) {
    return { merchantId: null, merchantName: '', userId: null, email: '', expiresAt: 0 };
  }
}

/* ---------- one live sign-in per account ---------- */

// account id -> { jwt, merchantId, expiresAt }
const live = new Map();

// signed in again with two minutes to spare, so a call never starts on a
// token that dies halfway through
const EARLY = 2 * 60 * 1000;

// two calls arriving together should not cause two sign-ins
const signingIn = new Map();

export async function tokenFor(accountId, email, password) {
  const held = live.get(accountId);
  if (held && held.expiresAt - EARLY > Date.now()) return held;

  if (signingIn.has(accountId)) return signingIn.get(accountId);

  const p = login(email, password)
    .then(res => {
      live.set(accountId, res);
      return res;
    })
    .finally(() => signingIn.delete(accountId));

  signingIn.set(accountId, p);
  return p;
}

export function forget(accountId) {
  live.delete(accountId);
}

// One retry, and only for an expired sign-in. Anything else is a real error
// and repeating it would only annoy PostEx.
async function withToken(session, fn) {
  try {
    return await fn(session.jwt);
  } catch (e) {
    if (!e.expired) throw e;
    forget(session.accountId);
    const fresh = await tokenFor(session.accountId, session.email, session.password);
    return fn(fresh.jwt);
  }
}

/* ==================== cash payment receipts ==================== */

const n = v => {
  const x = Number(String(v == null ? 0 : v).replace(/[^0-9.\-]/g, ''));
  return isNaN(x) ? 0 : x;
};

const stamp = v => {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
};

// PostEx writes its times in Pakistan time and says so - "...T01:44:00+0500".
// Reading that through UTC moves anything between midnight and five in the
// morning back a day, and deliveries are updated late at night, so it was
// quietly moving four hundred parcels of this receipt into the wrong day.
// The date on the wire is already the local one; take it as written.
const day = v => {
  if (!v) return null;
  const m = String(v).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
};

// The same instant as the portal prints it in its own downloads.
const moment = v => {
  if (!v) return null;
  const m = String(v).match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/);
  return m ? `${m[1]} ${m[2]}` : day(v);
};

export function mapCpr(row) {
  const c = row || {};
  return {
    cpr:        String(c.cashPaymentReceiptNumber || '').trim(),
    remoteId:   c.cashPaymentReceiptMasterId ? String(c.cashPaymentReceiptMasterId) : null,
    status:     c.cashPaymentReceiptStatus || '',
    statusId:   c.cashPaymentReceiptStatusId == null ? null : Number(c.cashPaymentReceiptStatusId),
    netAmount:  n(c.netAmount),
    createdOn:  stamp(c.createDatetime),
    approvedOn: stamp(c.approveDate),
    merchant:   c.merchantName || ''
  };
}

// Every receipt between two dates. `pagination=disable` is what the portal
// sends when it wants the lot, so there is nothing to page through.
export async function fetchCprs(session, from, to) {
  const j = await withToken(session, jwt =>
    call(`payment/merchant/${session.merchantId}/cpr`, {
      jwt,
      params: { fromDate: from, toDate: to, direction: 'desc', pagination: 'disable' }
    }));

  const list = j.dist || [];
  return Array.isArray(list) ? list.map(mapCpr).filter(x => x.cpr) : [];
}

// The block of totals across the top of the portal's receipt screen.
export async function fetchSummary(session, cprMasterId, createdOn) {
  const j = await withToken(session, jwt =>
    call(`payment/cpr/${cprMasterId}/summary`, {
      jwt,
      params: { cprMasterCreateDatetime: createdOn ? String(createdOn).slice(0, 10) : undefined }
    }));

  const d = j.dist || {};

  return {
    lines: (d.details || []).map(x => ({
      label:   x.details || '',
      orders:  Number(x.ordersCount || 0),
      amount:  n(x.amount),
      invoice: n(x.invoiceAmount)
    })),
    grandTotal:           n(d.grandTotal),
    codCharges:           n(d.codCharges),
    codChargesCount:      Number(d.codChargesCount || 0),
    upfrontCharges:       n(d.upfrontCharges),
    upfrontChargesCount:  Number(d.upfrontChargesCount || 0),
    salesTax:             n(d.salesTax),
    incomeTax:            n(d.incomeTax),
    tax:                  n(d.tax),
    miscellaneousCharges: n(d.miscellaneousCharges),
    carryForwardAmount:   n(d.carryForwardAmount),
    adjustmentAmount:     n(d.adjustmentAmount),
    netAmount:            n(d.netAmount)
  };
}

// PostEx sends about sixty fields per order and a large receipt runs to five
// megabytes. These are the ones anything downstream actually reads.
export function mapTransaction(row) {
  const t = (row && row.transaction) || {};

  // A parcel that came back has its charge under the reversal fields instead
  // of the ordinary ones, and no withholding is taken because no cash was
  // kept. Adding both pairs is what makes the column totals agree with the
  // receipt's own summary, to the paisa.
  const reversed = n(t.reversalFee) > 0 || n(t.reversalTax) > 0;

  const received = n(t.receivedAmount);
  const fee      = n(t.transactionFee) + n(t.reversalFee);
  const tax      = n(t.transactionTax) + n(t.reversalTax);
  const net      = n(t.netAmount);

  // PostEx does not send the 4% withholding as a field, but it is what is
  // left once the charges and the net are taken off what was collected.
  const deduction = reversed ? 0 : Math.round((received - fee - tax - net) * 100) / 100;

  // The 4% is two withholdings of 2% that go to two different accounts in
  // QuickBooks, so they are split here rather than at posting time. Income
  // tax is worked out; sales tax takes whatever the rounding leaves, so the
  // pair always adds back to the deduction that reconciles with the net.
  const whIncomeTax = reversed ? 0 : Math.round(received * 2) / 100;
  const whSalesTax  = reversed ? 0 : Math.round((deduction - whIncomeTax) * 100) / 100;

  const dr = reversed ? (t.reversalDate || t.orderDeliveryDate)
                      : (t.orderDeliveryDate || t.reversalDate);

  return {
    orderRef:    String(t.orderRefNumber || '').trim(),   // "#91339099" - as QuickBooks has it
    tracking:    String(t.trackingNumber || '').trim(),
    customer:    t.customerName || '',
    phone:       String(t.customerPhone || '').trim(),
    originCity:  t.originCity || '',
    city:        t.cityName || t.destinationCity || '',
    status:      t.transactionStatus || '',
    type:        t.transactionType || '',
    amount:      n(t.invoicePayment),
    received,
    upfront:     n(t.upfrontPayment),
    reserve:     n(t.reservePayment),
    fee,
    tax,
    deduction,
    whIncomeTax,
    whSalesTax,
    net,
    weight:      n(t.actualWeight) || n(t.bookingWeight),
    items:       Number(t.items || 0),
    bookedOn:    day(t.transactionDate),
    pickedOn:    day(t.orderPickupDate),
    // D/R is delivery or return. A parcel that came back carries the reversal
    // date, and the few that were delivered first carry both - the return is
    // what happened last, and what the courier's own receipt shows.
    deliveredOn: day(dr),
    settledOn:   day(t.settlementDate),
    // the same two with their time, for the columns the portal prints
    pickedAt:    moment(t.orderPickupDate),
    deliveredAt: moment(dr),
    settled:     t.settled === true,
    reversed,
    dispute:     t.disputeInd === true,
    notes:       t.transactionNotes || ''
  };
}

// Everything inside one receipt.
export async function fetchTransactions(session, cprMasterId) {
  const j = await withToken(session, jwt =>
    call(`payment/cpr/${cprMasterId}/transactions`, { jwt }));

  const list = j.dist || [];
  return Array.isArray(list) ? list.map(mapTransaction).filter(x => x.tracking) : [];
}

export async function fetchAdjustments(session, cprMasterId) {
  const j = await withToken(session, jwt =>
    call(`payment/cpr/${cprMasterId}/adjustments`, { jwt }));

  const list = j.dist || [];
  return Array.isArray(list) ? list : [];
}

export async function fetchPackages(session, cprMasterId) {
  const j = await withToken(session, jwt =>
    call(`payment/cpr/${cprMasterId}/packages`, { jwt }));

  const list = j.dist || [];
  return Array.isArray(list) ? list : [];
}
