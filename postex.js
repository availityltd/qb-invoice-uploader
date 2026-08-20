// PostEx speaks its own dialect. This file is the whole of it - the rest of
// the app never sees a PostEx field name. A new courier means a new file
// shaped like this one, and nothing else changes.

const BASE = 'https://api.postex.pk';

// PostEx has a dozen statuses; the portal only needs a handful of buckets
const GROUPS = {
  'unbooked':                   'unbooked',
  'booked':                     'booked',
  'picked by postex':           'transit',
  'en-route to postex warehouse':'transit',
  'postex warehouse':           'transit',
  'out for delivery':           'transit',
  'attempted':                  'transit',
  'delivery under review':      'review',
  'delivered':                  'delivered',
  'out for return':             'returning',
  'returned':                   'returned',
  'expired':                    'expired',
  'un-assigned by me':          'cancelled'
};

function groupOf(status) {
  const s = String(status || '').trim().toLowerCase();
  return GROUPS[s] || 'other';
}

function num(v) {
  const n = Number(String(v == null ? 0 : v).replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? 0 : n;
}

function day(v) {
  if (!v) return null;
  const s = String(v).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

async function ask(token, path, params) {
  const url = new URL(BASE + path);
  Object.keys(params || {}).forEach(k => {
    if (params[k] !== undefined && params[k] !== null) {
      url.searchParams.set(k, params[k]);
    }
  });

  const r = await fetch(url.toString(), {
    method: 'GET',
    headers: { 'token': token, 'Accept': 'application/json' }
  });

  const text = await r.text();

  if (!r.ok) {
    let msg = text.slice(0, 300);
    try {
      const j = JSON.parse(text);
      msg = j.statusMessage || j.message || msg;
    } catch (e) {}
    throw new Error(`PostEx said ${r.status}: ${msg}`);
  }

  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error('PostEx sent something that was not JSON: ' + text.slice(0, 200));
  }
}

// a plain call that proves the token works and nothing else
export async function testToken(token) {
  const j = await ask(token, '/services/integration/api/order/v1/get-order-status', {});
  const list = j.dist || [];
  return {
    ok: true,
    statuses: Array.isArray(list) ? list : [],
    message: j.statusMessage || 'connected'
  };
}

// PostEx wraps some rows in trackingResponse and leaves others bare
function unwrap(row) {
  if (row && row.trackingResponse) return row.trackingResponse;
  return row || {};
}

export function mapOrder(row) {
  const o = unwrap(row);
  const status = o.transactionStatus || '';

  return {
    tracking:    String(o.trackingNumber || '').trim(),
    orderRef:    String(o.orderRefNumber || '').trim(),
    status,
    statusGroup: groupOf(status),
    amount:      num(o.invoicePayment),
    fee:         num(o.transactionFee) + num(o.reversalFee),
    tax:         num(o.transactionTax) + num(o.reversalTax),
    city:        o.cityName || '',
    bookedOn:    day(o.transactionDate),
    pickedOn:    day(o.orderPickupDate),
    deliveredOn: day(o.orderDeliveryDate),
    raw:         o
  };
}

// Every order PostEx has for a span of days. The guide calls this GET but
// shows a body, so both shapes are tried before giving up.
export async function fetchOrders(token, from, to, statusId) {
  const path = '/services/integration/api/order/v1/get-all-order';
    // the guide says fromDate/toDate, the live API asks for startDate/endDate.
  // Sending both keeps either build happy.
  const params = {
    orderStatusID: statusId === undefined || statusId === null ? 0 : statusId,
    startDate: from,
    endDate: to,
    fromDate: from,
    toDate: to
  };

  let json;
  try {
    json = await ask(token, path, params);
  } catch (e) {
    // some builds of this endpoint want the dates in the body instead
    const r = await fetch(BASE + path, {
      method: 'GET',
      headers: {
        'token': token,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(params)
    }).catch(() => null);

    if (!r || !r.ok) throw e;          // the first error is the honest one
    json = await r.json();
  }

  const list = json.dist || [];
  if (!Array.isArray(list)) return [];

  return list.map(mapOrder).filter(x => x.tracking);
}

// Settlement and CPR numbers, one order at a time - PostEx offers no bulk call
export async function fetchPayment(token, tracking) {
  const j = await ask(token,
    '/services/integration/api/order/v1/payment-status/' + encodeURIComponent(tracking), {});
  const d = j.dist || {};

  return {
    tracking:   String(d.trackingNumber || tracking).trim(),
    orderRef:   String(d.orderRefNumber || '').trim(),
    settled:    d.settle === true || d.settle === 'true',
    settledOn:  day(d.settlementDate),
    cprNumber:  String(d.cprNumber_1 || d.cprNumber_2 || '').trim(),
    upfrontOn:  day(d.upfrontPaymentDate),
    reserveOn:  day(d.reservePaymentDate)
  };
}

export const adapter = {
  key: 'postex',
  name: 'PostEx',
  testToken,
  fetchOrders,
  fetchPayment
};
