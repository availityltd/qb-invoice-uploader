// Everything the courier dashboard shows, read from our own table. The keeper
// keeps that table in step with the couriers, so this only ever talks to the
// database - which is why the page opens at once.

import { pool } from './db.js';

const r2 = v => Math.round(Number(v || 0) * 100) / 100;
const day = v => v ? new Date(v).toISOString().slice(0, 10) : null;

function nextDay(s) {
  const d = new Date(s + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// the same where-clause everywhere, built once
function scope(realmId, opts) {
  const where = ['o.realm_id = $1'];
  const args = [realmId];

  if (opts.account) { args.push(Number(opts.account)); where.push(`o.account_id = $${args.length}`); }
  if (opts.courier) { args.push(String(opts.courier)); where.push(`o.courier = $${args.length}`); }

  return { where, args };
}

/* ==================== the whole picture ==================== */

export async function dashboard(realmId, opts) {
  const { from, to } = opts;
  const base = scope(realmId, opts);

  const w = base.where.join(' AND ');
  const args = base.args.slice();

  // dates come after whatever the scope needed
  args.push(from); const iFrom = args.length;
  args.push(to);   const iTo = args.length;

  const booked = `${w} AND o.booked_on >= $${iFrom} AND o.booked_on <= $${iTo}`;

  /* ---------- what each status is worth ---------- */

  const statuses = await pool.query(
    `SELECT o.status, o.status_group,
            COUNT(*) AS n,
            COALESCE(SUM(o.amount),0) AS amount
       FROM courier_orders o WHERE ${booked}
      GROUP BY o.status, o.status_group
      ORDER BY n DESC`, args);

  const groups = await pool.query(
    `SELECT o.status_group,
            COUNT(*) AS n,
            COALESCE(SUM(o.amount),0) AS amount
       FROM courier_orders o WHERE ${booked}
      GROUP BY o.status_group ORDER BY n DESC`, args);

  /* ---------- the totals ---------- */

  const totals = await pool.query(
    `SELECT COUNT(*) AS orders,
            COALESCE(SUM(o.amount),0) AS amount,
            COALESCE(SUM(o.fee),0) AS fee,
            COALESCE(SUM(o.tax),0) AS tax,
            -- whether a parcel was collected is a date the courier stamps,
            -- not something to be guessed from its status
            COUNT(*) FILTER (WHERE o.picked_on IS NOT NULL) AS picked,
            COALESCE(SUM(o.amount) FILTER (WHERE o.picked_on IS NULL),0) AS unpicked_amount,
            COUNT(*) FILTER (WHERE o.picked_on IS NULL) AS unpicked,
            COALESCE(SUM(o.amount) FILTER (WHERE o.status_group = 'delivered'),0) AS delivered_amount,
            COALESCE(SUM(o.amount) FILTER (WHERE o.status_group NOT IN
              ('delivered','returned','cancelled','expired','lost','damaged')),0) AS pending_amount,
            COUNT(*) FILTER (WHERE o.status_group NOT IN
              ('delivered','returned','cancelled','expired','lost','damaged')) AS pending_orders,
            MAX(o.seen_at) AS last_seen
       FROM courier_orders o WHERE ${booked}`, args);

  /* ---------- day by day: booked, delivered, returned, and what each is worth ---------- */

  const daily = await pool.query(
    `WITH b AS (
       SELECT o.booked_on AS d, COUNT(*) AS n, COALESCE(SUM(o.amount),0) AS amt
         FROM courier_orders o WHERE ${booked} GROUP BY o.booked_on),
     dl AS (
       SELECT o.delivered_on AS d, COUNT(*) AS n, COALESCE(SUM(o.amount),0) AS amt
         FROM courier_orders o
        WHERE ${w} AND o.status_group = 'delivered'
          AND o.delivered_on >= $${iFrom} AND o.delivered_on <= $${iTo}
        GROUP BY o.delivered_on),
     rt AS (
       SELECT o.delivered_on AS d, COUNT(*) AS n, COALESCE(SUM(o.amount),0) AS amt
         FROM courier_orders o
        WHERE ${w} AND o.status_group = 'returned'
          AND o.delivered_on >= $${iFrom} AND o.delivered_on <= $${iTo}
        GROUP BY o.delivered_on),
     pk AS (
       SELECT o.picked_on AS d, COUNT(*) AS n, COALESCE(SUM(o.amount),0) AS amt
         FROM courier_orders o
        WHERE ${w} AND o.picked_on >= $${iFrom} AND o.picked_on <= $${iTo}
        GROUP BY o.picked_on)
     SELECT COALESCE(b.d, dl.d, rt.d, pk.d) AS day,
            COALESCE(b.n,0) AS booked,       COALESCE(b.amt,0)  AS booked_amount,
            COALESCE(dl.n,0) AS delivered,   COALESCE(dl.amt,0) AS delivered_amount,
            COALESCE(rt.n,0) AS returned,    COALESCE(rt.amt,0) AS returned_amount,
            COALESCE(pk.n,0) AS picked,      COALESCE(pk.amt,0) AS picked_amount
       FROM b
       FULL OUTER JOIN dl ON dl.d = b.d
       FULL OUTER JOIN rt ON rt.d = COALESCE(b.d, dl.d)
       FULL OUTER JOIN pk ON pk.d = COALESCE(b.d, dl.d, rt.d)
      ORDER BY 1`, args);

  /* ---------- where the parcels went ---------- */

  const cities = await pool.query(
    `SELECT o.city,
            COUNT(*) AS n,
            COUNT(*) FILTER (WHERE o.status_group = 'delivered') AS delivered,
            COUNT(*) FILTER (WHERE o.status_group = 'returned') AS returned,
            COUNT(*) FILTER (WHERE o.status_group IN ('lost','damaged')) AS lost,
            COUNT(*) FILTER (WHERE o.status_group IN
              ('unbooked','booked','transit','review','returning')) AS moving,
            COALESCE(SUM(o.amount),0) AS booked_amount,
            COALESCE(SUM(o.amount) FILTER (WHERE o.status_group = 'delivered'),0) AS amount,
            COALESCE(SUM(o.fee)  FILTER (WHERE o.status_group = 'delivered'),0) AS fee,
            COALESCE(SUM(o.tax)  FILTER (WHERE o.status_group = 'delivered'),0) AS tax
       FROM courier_orders o
      WHERE ${booked} AND o.city IS NOT NULL AND o.city <> ''
      GROUP BY o.city ORDER BY n DESC LIMIT 200`, args);

  /* ---------- one row per account ---------- */

  const accounts = await pool.query(
    `SELECT o.account_id, a.label, a.courier,
            COUNT(*) AS orders,
            COUNT(*) FILTER (WHERE o.status_group = 'delivered') AS delivered,
            COUNT(*) FILTER (WHERE o.status_group = 'returned') AS returned,
            COALESCE(SUM(o.amount),0) AS amount,
            COALESCE(SUM(o.amount) FILTER (WHERE o.status_group = 'delivered'),0) AS delivered_amount,
            COALESCE(SUM(o.amount) FILTER (WHERE o.status_group NOT IN
              ('delivered','returned','cancelled','expired','lost','damaged')),0) AS pending_amount,
            COALESCE(SUM(o.fee),0) AS fee,
            COALESCE(SUM(o.tax),0) AS tax
       FROM courier_orders o
       JOIN courier_accounts a ON a.id = o.account_id
      WHERE ${booked}
      GROUP BY o.account_id, a.label, a.courier
      ORDER BY orders DESC`, args);

  /* ---------- money that has actually moved, newest first ---------- */

  const recent = await pool.query(
    `SELECT o.tracking, o.order_ref, o.amount, o.status, o.status_group,
            o.city, o.delivered_on, a.label
       FROM courier_orders o
       JOIN courier_accounts a ON a.id = o.account_id
      WHERE ${w} AND o.status_group = 'delivered' AND o.delivered_on IS NOT NULL
      ORDER BY o.delivered_on DESC, o.tracking DESC
      LIMIT 12`, base.args);

  /* ---------- the day laid out, quiet days and all ---------- */

  const byDay = {};
  daily.rows.forEach(x => {
    const d = day(x.day);
    if (d) byDay[d] = x;
  });

  const days = [];
  let cur = from, guard = 0;
  while (cur <= to && guard < 400) {
    const x = byDay[cur];
    days.push({
      day: cur,
      booked: x ? Number(x.booked) : 0,
      bookedAmount: x ? r2(x.booked_amount) : 0,
      delivered: x ? Number(x.delivered) : 0,
      deliveredAmount: x ? r2(x.delivered_amount) : 0,
      returned: x ? Number(x.returned) : 0,
      returnedAmount: x ? r2(x.returned_amount) : 0,
      picked: x ? Number(x.picked) : 0,
      pickedAmount: x ? r2(x.picked_amount) : 0
    });
    cur = nextDay(cur); guard++;
  }

  const t = totals.rows[0] || {};
  const g = {};
  groups.rows.forEach(x => { g[x.status_group || 'other'] = x; });
  const gc = k => (g[k] ? Number(g[k].n) : 0);

  const settled = gc('delivered') + gc('returned');

  return {
    from, to,
    totals: {
      orders: Number(t.orders || 0),
      picked: Number(t.picked || 0),
      unpicked: Number(t.unpicked || 0),
      unpickedAmount: r2(t.unpicked_amount),
      amount: r2(t.amount),
      fee: r2(t.fee),
      tax: r2(t.tax),
      deliveredAmount: r2(t.delivered_amount),
      pendingAmount: r2(t.pending_amount),
      pendingOrders: Number(t.pending_orders || 0),
      delivered: gc('delivered'),
      returned: gc('returned'),
      successRate: settled ? r2(100 * gc('delivered') / settled) : 0,
      lastSeen: t.last_seen
    },
    groups: groups.rows.map(x => ({
      group: x.status_group || 'other',
      count: Number(x.n),
      amount: r2(x.amount)
    })),
    statuses: statuses.rows.map(x => ({
      status: x.status || '(blank)',
      group: x.status_group || 'other',
      count: Number(x.n),
      amount: r2(x.amount)
    })),
    days,
    // Where the parcels go, and how each city actually behaves. These
    // percentages decide which courier gets which city's parcels, so every
    // one of them is worked out from settled orders only - a city with
    // fifty parcels still in transit should not look like a failure.
    cities: cities.rows.map(x => {
      const n         = Number(x.n);
      const delivered = Number(x.delivered);
      const returned  = Number(x.returned);
      const lost      = Number(x.lost);
      const settled   = delivered + returned;
      const pct = (part, whole) => whole ? r2(100 * part / whole) : 0;

      return {
        city:          x.city,
        count:         n,
        delivered,
        returned,
        lost,
        moving:        Number(x.moving),
        settled,
        bookedAmount:  r2(x.booked_amount),
        amount:        r2(x.amount),
        fee:           r2(x.fee),
        tax:           r2(x.tax),
        rate:          pct(delivered, settled),   // of what is settled
        returnRate:    pct(returned, settled),
        lostRate:      pct(lost, n),
        movingRate:    pct(Number(x.moving), n)
      };
    }),
    accounts: accounts.rows.map(x => ({
      id: x.account_id,
      label: x.label,
      courier: x.courier,
      orders: Number(x.orders),
      delivered: Number(x.delivered),
      returned: Number(x.returned),
      amount: r2(x.amount),
      deliveredAmount: r2(x.delivered_amount),
      pendingAmount: r2(x.pending_amount),
      fee: r2(x.fee),
      tax: r2(x.tax),
      successRate: (Number(x.delivered) + Number(x.returned))
        ? r2(100 * Number(x.delivered) / (Number(x.delivered) + Number(x.returned)))
        : 0
    })),
    recent: recent.rows.map(x => ({
      tracking: x.tracking,
      orderRef: x.order_ref,
      amount: r2(x.amount),
      status: x.status,
      statusGroup: x.status_group,
      city: x.city,
      account: x.label,
      on: day(x.delivered_on)
    }))
  };
}

/* ==================== the receipts ==================== */

// this month's, for the small box on the dashboard
export async function recentCprs(realmId, opts) {
  const base = scope(realmId, opts);
  const where = base.where.concat([`o.cpr_number IS NOT NULL`, `o.cpr_number <> ''`]);
  const args = base.args.slice();

  if (opts.from) { args.push(opts.from); where.push(`o.settled_on >= $${args.length}`); }
  if (opts.to)   { args.push(opts.to);   where.push(`o.settled_on <= $${args.length}`); }

  const r = await pool.query(
    `SELECT o.cpr_number, o.account_id, a.label,
            MIN(o.settled_on) AS settled_on,
            COUNT(*) AS orders,
            COALESCE(SUM(o.amount),0) AS amount
       FROM courier_orders o
       JOIN courier_accounts a ON a.id = o.account_id
      WHERE ${where.join(' AND ')}
      GROUP BY o.cpr_number, o.account_id, a.label
      ORDER BY MIN(o.settled_on) DESC NULLS LAST
      LIMIT ${Number(opts.limit) || 200}`, args);

  return r.rows.map(x => ({
    cpr: x.cpr_number,
    accountId: x.account_id,
    account: x.label,
    settledOn: day(x.settled_on),
    orders: Number(x.orders),
    amount: r2(x.amount)
  }));
}

/* ==================== pickups, which stand in for load sheets ==================== */

export async function pickups(realmId, opts) {
  const base = scope(realmId, opts);
  const where = base.where.concat([`o.picked_on IS NOT NULL`]);
  const args = base.args.slice();

  if (opts.from) { args.push(opts.from); where.push(`o.picked_on >= $${args.length}`); }
  if (opts.to)   { args.push(opts.to);   where.push(`o.picked_on <= $${args.length}`); }

  const r = await pool.query(
    `SELECT o.picked_on AS day, o.account_id, a.label,
            COUNT(*) AS parcels,
            COALESCE(SUM(o.amount),0) AS amount,
            COUNT(*) FILTER (WHERE o.status_group = 'delivered') AS delivered,
            COUNT(*) FILTER (WHERE o.status_group = 'returned') AS returned
       FROM courier_orders o
       JOIN courier_accounts a ON a.id = o.account_id
      WHERE ${where.join(' AND ')}
      GROUP BY o.picked_on, o.account_id, a.label
      ORDER BY o.picked_on DESC
      LIMIT ${Number(opts.limit) || 120}`, args);

  return r.rows.map(x => ({
    day: day(x.day),
    accountId: x.account_id,
    account: x.label,
    parcels: Number(x.parcels),
    amount: r2(x.amount),
    delivered: Number(x.delivered),
    returned: Number(x.returned)
  }));
}

// the parcels picked up on one day
export async function pickupOrders(realmId, opts) {
  const base = scope(realmId, opts);
  const args = base.args.slice();
  args.push(opts.day);

  const r = await pool.query(
    `SELECT o.tracking, o.order_ref, o.amount, o.status, o.status_group,
            o.city, o.booked_on, o.delivered_on, a.label
       FROM courier_orders o
       JOIN courier_accounts a ON a.id = o.account_id
      WHERE ${base.where.join(' AND ')} AND o.picked_on = $${args.length}
      ORDER BY o.tracking
      LIMIT 2000`, args);

  const rows = r.rows.map(x => ({
    account: x.label,
    tracking: x.tracking,
    orderRef: x.order_ref,
    amount: r2(x.amount),
    status: x.status,
    statusGroup: x.status_group,
    city: x.city,
    bookedOn: day(x.booked_on),
    deliveredOn: day(x.delivered_on)
  }));

  return {
    day: opts.day,
    parcels: rows.length,
    amount: r2(rows.reduce((s, x) => s + x.amount, 0)),
    orders: rows
  };
}

/* ==================== the orders behind one number ==================== */

// The same rows as ordersBy but without its ceiling, handed over a page at a
// time so a month of parcels never sits in memory all at once. ordersBy stops
// at two thousand because a drawer cannot show more than that; a download is
// the opposite - it is worth having precisely because it is complete.
export async function eachOrder(realmId, opts, onBatch) {
  const PAGE = 2000;
  let after = null;          // (booked_on, tracking) of the last row sent
  let sent = 0;

  for (let guard = 0; guard < 500; guard++) {
    const base = scope(realmId, opts);
    const where = base.where.slice();
    const args = base.args.slice();

    if (opts.from) { args.push(opts.from); where.push(`o.booked_on >= $${args.length}`); }
    if (opts.to)   { args.push(opts.to);   where.push(`o.booked_on <= $${args.length}`); }
    if (opts.status) { args.push(opts.status); where.push(`o.status = $${args.length}`); }
    if (opts.city)   { args.push(opts.city);   where.push(`o.city = $${args.length}`); }
    if (opts.cpr)    { args.push(opts.cpr);    where.push(`o.cpr_number = $${args.length}`); }
    if (opts.picked === '1' || opts.picked === 1) where.push(`o.picked_on IS NOT NULL`);
    if (opts.picked === '0' || opts.picked === 0) where.push(`o.picked_on IS NULL`);

    if (opts.group) {
      const groups = String(opts.group).split(',').map(s => s.trim()).filter(Boolean);
      if (groups.length === 1) {
        args.push(groups[0]); where.push(`o.status_group = $${args.length}`);
      } else if (groups.length > 1) {
        args.push(groups); where.push(`o.status_group = ANY($${args.length})`);
      }
    }

    // Carrying on from the last row read, rather than OFFSET - an offset makes
    // the database walk everything it already skipped on every page.
    if (after) {
      args.push(after.day); args.push(after.tracking);
      where.push(`(o.booked_on, o.tracking) < ($${args.length - 1}::date, $${args.length})`);
    }

    const r = await pool.query(
      `SELECT o.tracking, o.order_ref, o.amount, o.fee, o.tax, o.status, o.status_group,
              o.city, o.booked_on, o.picked_on, o.delivered_on,
              o.settled_on, o.cpr_number, a.label
         FROM courier_orders o
         JOIN courier_accounts a ON a.id = o.account_id
        WHERE ${where.join(' AND ')}
        ORDER BY o.booked_on DESC, o.tracking DESC
        LIMIT ${PAGE}`, args);

    if (!r.rows.length) break;

    const last = r.rows[r.rows.length - 1];
    after = { day: day(last.booked_on), tracking: last.tracking };

    await onBatch(r.rows.map(x => ({
      account: x.label,
      tracking: x.tracking,
      orderRef: x.order_ref,
      amount: r2(x.amount),
      fee: r2(x.fee),
      tax: r2(x.tax),
      status: x.status,
      statusGroup: x.status_group,
      city: x.city,
      bookedOn: day(x.booked_on),
      pickedOn: day(x.picked_on),
      deliveredOn: day(x.delivered_on),
      settledOn: day(x.settled_on),
      cprNumber: x.cpr_number
    })));

    sent += r.rows.length;
    if (r.rows.length < PAGE) break;
    if (!after.day) break;          // no booking date to page on, so stop here
  }

  return sent;
}

export async function ordersBy(realmId, opts) {
  const base = scope(realmId, opts);
  const where = base.where.slice();
  const args = base.args.slice();

  if (opts.from) { args.push(opts.from); where.push(`o.booked_on >= $${args.length}`); }
  if (opts.to)   { args.push(opts.to);   where.push(`o.booked_on <= $${args.length}`); }
  if (opts.status) { args.push(opts.status); where.push(`o.status = $${args.length}`); }
  // A stage on the dashboard is not always one group - "still moving" covers
  // five of them - so a comma-separated list is allowed.
  if (opts.group) {
    const groups = String(opts.group).split(',').map(s => s.trim()).filter(Boolean);
    if (groups.length === 1) {
      args.push(groups[0]); where.push(`o.status_group = $${args.length}`);
    } else if (groups.length > 1) {
      args.push(groups); where.push(`o.status_group = ANY($${args.length})`);
    }
  }
  if (opts.city)   { args.push(opts.city);   where.push(`o.city = $${args.length}`); }
  // '1' is collected, '0' is still sitting with the merchant
  if (opts.picked === '1' || opts.picked === 1) where.push(`o.picked_on IS NOT NULL`);
  if (opts.picked === '0' || opts.picked === 0) where.push(`o.picked_on IS NULL`);
  if (opts.cpr)    { args.push(opts.cpr);    where.push(`o.cpr_number = $${args.length}`); }

  const r = await pool.query(
    `SELECT o.tracking, o.order_ref, o.amount, o.fee, o.tax, o.status, o.status_group,
            o.city, o.booked_on, o.picked_on, o.delivered_on,
            o.settled_on, o.cpr_number, a.label
       FROM courier_orders o
       JOIN courier_accounts a ON a.id = o.account_id
      WHERE ${where.join(' AND ')}
      ORDER BY o.booked_on DESC NULLS LAST, o.tracking
      LIMIT 2000`, args);

  const rows = r.rows.map(x => ({
    account: x.label,
    tracking: x.tracking,
    orderRef: x.order_ref,
    amount: r2(x.amount),
    fee: r2(x.fee),
    tax: r2(x.tax),
    status: x.status,
    statusGroup: x.status_group,
    city: x.city,
    bookedOn: day(x.booked_on),
    pickedOn: day(x.picked_on),
    deliveredOn: day(x.delivered_on),
    settledOn: day(x.settled_on),
    cprNumber: x.cpr_number
  }));

  return {
    count: rows.length,
    amount: r2(rows.reduce((s, x) => s + x.amount, 0)),
    orders: rows
  };
}
