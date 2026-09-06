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

  // A courier's own portal is a second door with its own key. PostEx needs
  // this for cash payment receipts; the integration token above cannot see
  // them. Added on rather than built in, so accounts that predate it carry on
  // working with the token alone.
  await pool.query(`
    ALTER TABLE courier_accounts
      ADD COLUMN IF NOT EXISTS portal_email  TEXT,
      ADD COLUMN IF NOT EXISTS portal_secret TEXT,
      ADD COLUMN IF NOT EXISTS merchant_id   TEXT
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

  // The receipt as the courier's own portal knows it - one row per CPR, with
  // its number, its status and what it is worth. What is inside a receipt
  // stays in courier_orders; this is only the cover sheet.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS courier_cprs (
      id           SERIAL PRIMARY KEY,
      realm_id     TEXT NOT NULL,
      account_id   INTEGER NOT NULL,
      courier      TEXT NOT NULL,
      cpr_number   TEXT NOT NULL,
      remote_id    TEXT,                  -- the courier's own id for it
      status       TEXT,
      status_id    INTEGER,
      net_amount   NUMERIC(14,2) DEFAULT 0,
      created_on   TIMESTAMPTZ,
      approved_on  TIMESTAMPTZ,
      qb_payment_id TEXT,                 -- set once it is receipted in QB
      received_on  TIMESTAMPTZ,
      expected_amount NUMERIC(14,2),      -- what the courier said it collected
      received_amount NUMERIC(14,2),      -- what actually went into QuickBooks
      dc_journal_id TEXT,                 -- the delivery-charges journal entry
      dc_posted_on TIMESTAMPTZ,
      raw          JSONB,
      seen_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS courier_cprs_key
      ON courier_cprs (realm_id, account_id, cpr_number)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS courier_cprs_dates
      ON courier_cprs (realm_id, created_on)
  `);

  await pool.query(`
    ALTER TABLE courier_cprs
      ADD COLUMN IF NOT EXISTS expected_amount NUMERIC(14,2),
      ADD COLUMN IF NOT EXISTS received_amount NUMERIC(14,2),
      ADD COLUMN IF NOT EXISTS dc_journal_id   TEXT,
      ADD COLUMN IF NOT EXISTS dc_posted_on    TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS cod_amount      NUMERIC(14,2),
      ADD COLUMN IF NOT EXISTS charges_amount  NUMERIC(14,2),
      ADD COLUMN IF NOT EXISTS tax_amount      NUMERIC(14,2),
      ADD COLUMN IF NOT EXISTS wh_amount       NUMERIC(14,2),
      ADD COLUMN IF NOT EXISTS orders_count    INTEGER
  `);
}

// A receipt seen again is updated, never duplicated. What we have already
// done with it in QuickBooks is ours, so those columns are left alone.
export async function saveCprs(realmId, accountId, courier, rows) {
  if (!rows.length) return 0;

  for (const c of rows) {
    if (!c || !c.cprNumber) continue;
    await pool.query(
      `INSERT INTO courier_cprs
         (realm_id, account_id, courier, cpr_number, remote_id, status, status_id,
          net_amount, created_on, approved_on, raw, seen_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, NOW())
       ON CONFLICT (realm_id, account_id, cpr_number) DO UPDATE SET
         remote_id   = EXCLUDED.remote_id,
         status      = EXCLUDED.status,
         status_id   = EXCLUDED.status_id,
         net_amount  = EXCLUDED.net_amount,
         created_on  = EXCLUDED.created_on,
         approved_on = EXCLUDED.approved_on,
         raw         = EXCLUDED.raw,
         seen_at     = NOW()`,
      [realmId, accountId, courier, c.cprNumber, c.remoteId || null,
       c.status || null, c.statusId || null, c.netAmount || 0,
       c.createdOn || null, c.approvedOn || null,
       JSON.stringify(c.raw || {})]
    );
  }

  return rows.length;
}

export async function listPortalCprs(realmId, opts) {
  const where = ['c.realm_id = $1'];
  const args = [realmId];

  if (opts && opts.account) { args.push(Number(opts.account)); where.push(`c.account_id = $${args.length}`); }
  if (opts && opts.courier) { args.push(String(opts.courier)); where.push(`c.courier = $${args.length}`); }
  if (opts && opts.from)    { args.push(opts.from); where.push(`c.created_on >= $${args.length}`); }
  if (opts && opts.to)      { args.push(opts.to + ' 23:59:59'); where.push(`c.created_on <= $${args.length}`); }

  const r = await pool.query(
    `SELECT c.cpr_number, c.remote_id, c.account_id, a.label, c.courier,
            c.status, c.status_id, c.net_amount, c.created_on, c.approved_on,
            c.qb_payment_id, c.received_on, c.expected_amount, c.received_amount,
            c.dc_journal_id, c.dc_posted_on, c.cod_amount, c.charges_amount,
            c.tax_amount, c.wh_amount, c.orders_count
       FROM courier_cprs c
       JOIN courier_accounts a ON a.id = c.account_id
      WHERE ${where.join(' AND ')}
      ORDER BY c.created_on DESC NULLS LAST`,
    args
  );

  const d = v => v ? new Date(v).toISOString().slice(0, 10) : null;

  return r.rows.map(x => ({
    cpr:        x.cpr_number,
    remoteId:   x.remote_id,
    accountId:  x.account_id,
    account:    x.label,
    courier:    x.courier,
    status:     x.status,
    statusId:   x.status_id,
    netAmount:  Math.round(Number(x.net_amount || 0) * 100) / 100,
    createdOn:  d(x.created_on),
    approvedOn: d(x.approved_on),
    qbPaymentId: x.qb_payment_id,
    receivedOn:  d(x.received_on),
    expected:    x.expected_amount == null ? null : Math.round(Number(x.expected_amount) * 100) / 100,
    received:    x.received_amount == null ? null : Math.round(Number(x.received_amount) * 100) / 100,
    dcJournalId: x.dc_journal_id,
    dcPostedOn:  d(x.dc_posted_on),
    codAmount:   x.cod_amount     == null ? null : Math.round(Number(x.cod_amount) * 100) / 100,
    charges:     x.charges_amount == null ? null : Math.round(Number(x.charges_amount) * 100) / 100,
    taxAmount:   x.tax_amount     == null ? null : Math.round(Number(x.tax_amount) * 100) / 100,
    withholding: x.wh_amount      == null ? null : Math.round(Number(x.wh_amount) * 100) / 100,
    orders:      x.orders_count   == null ? null : Number(x.orders_count)
  }));
}

// Stamped once the receipt has been turned into a QuickBooks payment. Both
// amounts are kept so the list can say whether they agreed - a receipt that
// went in short is worth seeing without opening it.
export async function markCprReceived(realmId, accountId, cprNumber, info) {
  const i = info || {};

  // A receipt can be received more than once: the first run takes what it can
  // match, then the invoices that were missing get made and the rest follow.
  // `add` puts the second run on top of the first instead of replacing it, so
  // the total stays honest and the mark can go green.
  await pool.query(
    `UPDATE courier_cprs
        SET qb_payment_id   = COALESCE($4, qb_payment_id),
            received_on     = NOW(),
            expected_amount = COALESCE($5, expected_amount),
            received_amount = CASE
              WHEN $6::numeric IS NULL THEN received_amount
              WHEN $7::boolean THEN COALESCE(received_amount, 0) + $6::numeric
              ELSE $6::numeric
            END
      WHERE realm_id = $1 AND account_id = $2 AND cpr_number = $3`,
    [realmId, accountId, cprNumber, i.qbPaymentId || null,
     i.expected == null ? null : Number(i.expected),
     i.received == null ? null : Number(i.received),
     i.add === true]
  );
}

// The totals off the receipt's own summary. Net is what the courier pays
// out; COD is what it collected, and that is the figure a QuickBooks payment
// has to match. Kept once so the list does not have to ask again.
export async function saveCprTotals(realmId, accountId, cprNumber, t) {
  await pool.query(
    `UPDATE courier_cprs
        SET cod_amount     = $4,
            charges_amount = $5,
            tax_amount     = $6,
            wh_amount      = $7,
            orders_count   = $8
      WHERE realm_id = $1 AND account_id = $2 AND cpr_number = $3`,
    [realmId, accountId, cprNumber,
     t.cod == null ? null : Number(t.cod),
     t.charges == null ? null : Number(t.charges),
     t.tax == null ? null : Number(t.tax),
     t.withholding == null ? null : Number(t.withholding),
     t.orders == null ? null : Number(t.orders)]
  );
}

// which receipts have not had their totals read yet
export async function cprsMissingTotals(realmId, accountId, limit) {
  const r = await pool.query(
    `SELECT cpr_number, remote_id, created_on
       FROM courier_cprs
      WHERE realm_id = $1 AND account_id = $2 AND cod_amount IS NULL
        AND remote_id IS NOT NULL
      ORDER BY created_on DESC NULLS LAST
      LIMIT $3`,
    [realmId, accountId, Number(limit) || 12]
  );
  return r.rows.map(x => ({
    cpr: x.cpr_number,
    remoteId: x.remote_id,
    createdOn: x.created_on
  }));
}

// the delivery charges for a receipt, once they are journalled
export async function markCprCharges(realmId, accountId, cprNumber, journalId) {
  await pool.query(
    `UPDATE courier_cprs
        SET dc_journal_id = $4, dc_posted_on = NOW()
      WHERE realm_id = $1 AND account_id = $2 AND cpr_number = $3`,
    [realmId, accountId, cprNumber, journalId || null]
  );
}

export async function listAccounts(realmId) {
  const r = await pool.query(
    `SELECT id, courier, label, active, last_sync, last_error,
            LENGTH(token) AS token_len,
            portal_email,
            (portal_secret IS NOT NULL) AS portal_ready,
            merchant_id
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

// The portal sign-in for an account. The password arrives already encrypted -
// this file never sees the real one.
export async function setPortalLogin(realmId, id, { email, secret, merchantId }) {
  await pool.query(
    `UPDATE courier_accounts
        SET portal_email  = $3,
            portal_secret = COALESCE($4, portal_secret),
            merchant_id   = COALESCE($5, merchant_id)
      WHERE realm_id = $1 AND id = $2`,
    [realmId, id, email || null, secret || null, merchantId || null]
  );
}

export async function clearPortalLogin(realmId, id) {
  await pool.query(
    `UPDATE courier_accounts
        SET portal_email = NULL, portal_secret = NULL
      WHERE realm_id = $1 AND id = $2`,
    [realmId, id]
  );
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
// The courier sends about sixty fields per parcel and we read a dozen. The
// rest is kept as `raw` only so someone can look at what actually arrived
// when a field seems wrong - which is only ever useful for something recent.
// Left alone it is 2.2 KB a parcel against the 250 bytes the columns need,
// and ten accounts would put gigabytes a year into the database for nothing.
// The parcels themselves stay; only the untouched copy is let go.
export async function trimRaw(days) {
  const r = await pool.query(
    `UPDATE courier_orders
        SET raw = '{}'::jsonb
      WHERE seen_at < NOW() - ($1 || ' days')::interval
        AND raw IS NOT NULL
        AND raw <> '{}'::jsonb`,
    [String(Number(days) || 7)]
  );
  return r.rowCount;
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
