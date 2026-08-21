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
