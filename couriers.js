import { pool } from './db.js';

// Courier accounts, one row per account. PostEx-RB and PostEx-AH are two rows
// sharing one adapter; a whole new courier is a new adapter, not new tables.
export async function initCouriers() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS courier_accounts (
      id          SERIAL PRIMARY KEY,
      realm_id    TEXT NOT NULL,
      courier     TEXT NOT NULL,          -- postex, trax, daewoo
      label       TEXT NOT NULL,          -- PostEx - RB
      token       TEXT NOT NULL,
      active      BOOLEAN DEFAULT TRUE,
      last_sync   TIMESTAMPTZ,
      last_error  TEXT,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS courier_accounts_key
      ON courier_accounts (realm_id, courier, label)
  `);

  // every order any courier hands back, flattened into one shape
  await pool.query(`
    CREATE TABLE IF NOT EXISTS courier_orders (
      id            SERIAL PRIMARY KEY,
      realm_id      TEXT NOT NULL,
      account_id    INTEGER NOT NULL,
      courier       TEXT NOT NULL,
      tracking      TEXT NOT NULL,
      order_ref     TEXT,
      status        TEXT,
      status_group  TEXT,                 -- booked, transit, delivered, returned...
      amount        NUMERIC(14,2) DEFAULT 0,
      fee           NUMERIC(14,2) DEFAULT 0,
      tax           NUMERIC(14,2) DEFAULT 0,
      city          TEXT,
      booked_on     DATE,
      picked_on     DATE,
      delivered_on  DATE,
      settled       BOOLEAN,
      settled_on    DATE,
      cpr_number    TEXT,
      raw           JSONB,
      seen_at       TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS courier_orders_key
      ON courier_orders (realm_id, account_id, tracking)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS courier_orders_dates
      ON courier_orders (realm_id, booked_on)
  `);
}

export async function listAccounts(realmId) {
  const r = await pool.query(
    `SELECT id, courier, label, active, last_sync, last_error,
            LENGTH(token) AS token_len
       FROM courier_accounts
      WHERE realm_id = $1
      ORDER BY courier, label`,
    [realmId]
  );
  return r.rows;
}

export async function getAccount(realmId, id) {
  const r = await pool.query(
    `SELECT * FROM courier_accounts WHERE realm_id = $1 AND id = $2`,
    [realmId, id]
  );
  return r.rows[0] || null;
}

export async function addAccount(realmId, { courier, label, token }) {
  const r = await pool.query(
    `INSERT INTO courier_accounts (realm_id, courier, label, token)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (realm_id, courier, label)
       DO UPDATE SET token = EXCLUDED.token, active = TRUE, last_error = NULL
     RETURNING id`,
    [realmId, courier, label, token]
  );
  return r.rows[0].id;
}

export async function removeAccount(realmId, id) {
  await pool.query(
    `DELETE FROM courier_accounts WHERE realm_id = $1 AND id = $2`,
    [realmId, id]
  );
  return true;
}

export async function markSync(realmId, id, error) {
  await pool.query(
    `UPDATE courier_accounts
        SET last_sync = NOW(), last_error = $3
      WHERE realm_id = $1 AND id = $2`,
    [realmId, id, error || null]
  );
}

// an order seen again is updated, never duplicated
export async function saveOrders(realmId, accountId, courier, rows) {
  if (!rows.length) return 0;

  // one round trip per hundred orders instead of one per order
  const CHUNK = 100;
  let saved = 0;

  for (let start = 0; start < rows.length; start += CHUNK) {
    const slice = rows.slice(start, start + CHUNK).filter(o => o.tracking);
    if (!slice.length) continue;

    const values = [];
    const params = [];
    let n = 1;

    slice.forEach(o => {
      values.push(
        `($${n++},$${n++},$${n++},$${n++},$${n++},$${n++},$${n++},` +
        `$${n++},$${n++},$${n++},$${n++},$${n++},$${n++},$${n++},$${n++}, NOW())`
      );
      params.push(
        realmId, accountId, courier, o.tracking, o.orderRef || null,
        o.status || null, o.statusGroup || null,
        o.amount || 0, o.fee || 0, o.tax || 0, o.city || null,
        o.bookedOn || null, o.pickedOn || null, o.deliveredOn || null,
        JSON.stringify(o.raw || {})
      );
    });

    await pool.query(
      `INSERT INTO courier_orders
         (realm_id, account_id, courier, tracking, order_ref, status, status_group,
          amount, fee, tax, city, booked_on, picked_on, delivered_on, raw, seen_at)
       VALUES ${values.join(',')}
       ON CONFLICT (realm_id, account_id, tracking) DO UPDATE SET
         status       = EXCLUDED.status,
         status_group = EXCLUDED.status_group,
         amount       = EXCLUDED.amount,
         fee          = EXCLUDED.fee,
         tax          = EXCLUDED.tax,
         city         = EXCLUDED.city,
         picked_on    = EXCLUDED.picked_on,
         delivered_on = EXCLUDED.delivered_on,
         raw          = EXCLUDED.raw,
         seen_at      = NOW()`,
      params
    );

    saved += slice.length;
  }

  return saved;
}
// which delivered orders we have not asked about yet
export async function needCpr(realmId, accountId, limit) {
  const r = await pool.query(
    `SELECT tracking FROM courier_orders
      WHERE realm_id = $1 AND account_id = $2
        AND status_group = 'delivered'
        AND cpr_number IS NULL
        AND settled IS DISTINCT FROM FALSE
      ORDER BY delivered_on DESC NULLS LAST
      LIMIT $3`,
    [realmId, accountId, limit || 60]
  );
  return r.rows.map(x => x.tracking);
}

// what the courier said about one parcel's money
export async function savePayments(realmId, accountId, rows) {
  if (!rows.length) return 0;

  for (const p of rows) {
    if (!p || !p.tracking) continue;
    await pool.query(
      `UPDATE courier_orders
          SET settled = $3, settled_on = $4, cpr_number = $5
        WHERE realm_id = $1 AND account_id = $2 AND tracking = $6`,
      [realmId, accountId,
       p.settled === true,
       p.settledOn || null,
       p.cprNumber || null,
       p.tracking]
    );
  }
  return rows.length;
}

// the receipts themselves, built from the orders that carry their number
export async function listCprs(realmId, opts) {
  const where = [`o.realm_id = $1`, `o.cpr_number IS NOT NULL`, `o.cpr_number <> ''`];
  const args = [realmId];

  if (opts && opts.account) {
    args.push(Number(opts.account));
    where.push(`o.account_id = $${args.length}`);
  }
  if (opts && opts.from) {
    args.push(opts.from);
    where.push(`o.settled_on >= $${args.length}`);
  }
  if (opts && opts.to) {
    args.push(opts.to);
    where.push(`o.settled_on <= $${args.length}`);
  }

  const r = await pool.query(
    `SELECT o.cpr_number, o.account_id, a.label,
            MIN(o.settled_on) AS settled_on,
            COUNT(*) AS orders,
            COALESCE(SUM(o.amount),0) AS amount,
            COALESCE(SUM(o.fee),0) AS fee,
            COALESCE(SUM(o.tax),0) AS tax
       FROM courier_orders o
       JOIN courier_accounts a ON a.id = o.account_id
      WHERE ${where.join(' AND ')}
      GROUP BY o.cpr_number, o.account_id, a.label
      ORDER BY MIN(o.settled_on) DESC NULLS LAST`,
    args
  );

  return r.rows.map(x => ({
    cpr: x.cpr_number,
    accountId: x.account_id,
    account: x.label,
    settledOn: x.settled_on ? new Date(x.settled_on).toISOString().slice(0, 10) : null,
    orders: Number(x.orders),
    amount: Math.round(Number(x.amount) * 100) / 100,
    fee: Math.round(Number(x.fee) * 100) / 100,
    tax: Math.round(Number(x.tax) * 100) / 100
  }));
}

// everything inside one receipt
export async function cprOrders(realmId, cpr) {
  const r = await pool.query(
    `SELECT o.tracking, o.order_ref, o.amount, o.fee, o.tax, o.city,
            o.booked_on, o.delivered_on, o.settled_on, a.label
       FROM courier_orders o
       JOIN courier_accounts a ON a.id = o.account_id
      WHERE o.realm_id = $1 AND o.cpr_number = $2
      ORDER BY o.delivered_on DESC NULLS LAST`,
    [realmId, cpr]
  );

  const d = v => v ? new Date(v).toISOString().slice(0, 10) : null;
  const n = v => Math.round(Number(v || 0) * 100) / 100;

  return r.rows.map(x => ({
    account: x.label,
    tracking: x.tracking,
    orderRef: x.order_ref,
    amount: n(x.amount),
    fee: n(x.fee),
    tax: n(x.tax),
    city: x.city,
    bookedOn: d(x.booked_on),
    deliveredOn: d(x.delivered_on),
    settledOn: d(x.settled_on)
  }));
}

// how much is still unknown, so the page can show progress
export async function cprProgress(realmId, accountId) {
  const r = await pool.query(
    `SELECT
        COUNT(*) FILTER (WHERE status_group = 'delivered') AS delivered,
        COUNT(*) FILTER (WHERE status_group = 'delivered' AND cpr_number IS NOT NULL) AS known,
        COUNT(*) FILTER (WHERE status_group = 'delivered' AND settled = FALSE) AS unsettled
       FROM courier_orders
      WHERE realm_id = $1 ${accountId ? 'AND account_id = $2' : ''}`,
    accountId ? [realmId, Number(accountId)] : [realmId]
  );

  const x = r.rows[0] || {};
  return {
    delivered: Number(x.delivered || 0),
    known: Number(x.known || 0),
    unsettled: Number(x.unsettled || 0),
    left: Number(x.delivered || 0) - Number(x.known || 0) - Number(x.unsettled || 0)
  };
}
