import { pool } from './db.js';

export async function initSettings() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      realm_id    TEXT NOT NULL,
      key         TEXT NOT NULL,
      value       JSONB,
      updated_at  TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (realm_id, key)
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cpr_runs (
      id            SERIAL PRIMARY KEY,
      realm_id      TEXT NOT NULL,
      courier       TEXT,
      cpr_number    TEXT,
      cpr_date      TEXT,
      sheet_id      TEXT,
      sheet_name    TEXT,
      matched       INTEGER DEFAULT 0,
      unmatched     INTEGER DEFAULT 0,
      amount        NUMERIC DEFAULT 0,
      qb_payment_id TEXT,
      bank_account  TEXT,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

export async function getSetting(realmId, key, fallback) {
  const r = await pool.query(
    'SELECT value FROM app_settings WHERE realm_id = $1 AND key = $2',
    [realmId, key]
  );
  return r.rows.length ? r.rows[0].value : (fallback === undefined ? null : fallback);
}

export async function setSetting(realmId, key, value) {
  await pool.query(
    `INSERT INTO app_settings (realm_id, key, value) VALUES ($1, $2, $3)
     ON CONFLICT (realm_id, key)
     DO UPDATE SET value = $3, updated_at = NOW()`,
    [realmId, key, JSON.stringify(value)]
  );
}

export async function recordRun(realmId, run) {
  const r = await pool.query(
    `INSERT INTO cpr_runs
       (realm_id, courier, cpr_number, cpr_date, sheet_id, sheet_name,
        matched, unmatched, amount, qb_payment_id, bank_account)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING id`,
    [realmId, run.courier || null, run.cprNumber || null, run.cprDate || null,
     run.sheetId || null, run.sheetName || null,
     run.matched || 0, run.unmatched || 0, run.amount || 0,
     run.qbPaymentId || null, run.bankAccount || null]
  );
  return r.rows[0].id;
}

export async function listRuns(realmId, limit) {
  const r = await pool.query(
    `SELECT * FROM cpr_runs WHERE realm_id = $1
     ORDER BY created_at DESC LIMIT $2`,
    [realmId, limit || 100]
  );
  return r.rows;
}

export async function runsSummary(realmId) {
  const r = await pool.query(
    `SELECT courier,
            COUNT(*)        AS runs,
            SUM(matched)    AS invoices,
            SUM(amount)     AS amount,
            MAX(created_at) AS last_run
     FROM cpr_runs
     WHERE realm_id = $1
     GROUP BY courier
     ORDER BY last_run DESC`,
    [realmId]
  );
  return r.rows;
}

/* ---------- cached snapshots ---------- */

export async function initCache() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cache_blobs (
      realm_id   TEXT NOT NULL,
      key        TEXT NOT NULL,
      value      JSONB,
      built_at   TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (realm_id, key)
    );
  `);
}

export async function getCache(realmId, key, maxAgeSeconds) {
  const r = await pool.query(
    'SELECT value, built_at FROM cache_blobs WHERE realm_id = $1 AND key = $2',
    [realmId, key]
  );
  if (!r.rows.length) return null;

  const age = (Date.now() - new Date(r.rows[0].built_at).getTime()) / 1000;
  if (maxAgeSeconds && age > maxAgeSeconds) return null;

  return { value: r.rows[0].value, builtAt: r.rows[0].built_at, ageSeconds: Math.round(age) };
}

export async function setCache(realmId, key, value) {
  await pool.query(
    `INSERT INTO cache_blobs (realm_id, key, value, built_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (realm_id, key)
     DO UPDATE SET value = $3, built_at = NOW()`,
    [realmId, key, JSON.stringify(value)]
  );
}
