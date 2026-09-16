// The record of what was changed on the products themselves.
//
// QuickBooks' own audit log says an item was edited. It does not say the cost
// went on for the first time, or which of five thousand items were put away in
// one afternoon, or what the cost was before someone typed over it. That is what
// this holds: one row per item touched, what it was, what it became, and whether
// QuickBooks took it.

import { pool } from './db.js';

export async function initProdStore() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS product_changes (
      id         SERIAL PRIMARY KEY,
      realm_id   TEXT NOT NULL,
      item_id    TEXT,
      name       TEXT,
      sku        TEXT,
      field      TEXT,
      was        TEXT,
      now_is     TEXT,
      status     TEXT,
      message    TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    )
  `);

  await pool.query(
    `CREATE INDEX IF NOT EXISTS product_changes_realm
       ON product_changes (realm_id, created_at DESC)`
  );
}

export async function logProductChange(realmId, row) {
  await pool.query(
    `INSERT INTO product_changes
       (realm_id, item_id, name, sku, field, was, now_is, status, message)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      realmId, String(row.id || ''), (row.name || '').slice(0, 300),
      (row.sku || '').slice(0, 120), row.field || '',
      row.was === null || row.was === undefined ? '' : String(row.was),
      row.now === null || row.now === undefined ? '' : String(row.now),
      row.ok ? 'done' : 'failed', (row.message || '').slice(0, 500)
    ]
  );
}

export async function listProductChanges(realmId, limit = 300) {
  const r = await pool.query(
    `SELECT item_id, name, sku, field, was, now_is, status, message, created_at
       FROM product_changes
      WHERE realm_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT $2`,
    [realmId, Math.min(Number(limit) || 300, 2000)]
  );

  return r.rows.map(x => ({
    id: x.item_id, name: x.name || '', sku: x.sku || '', field: x.field || '',
    was: x.was || '', now: x.now_is || '',
    status: x.status, message: x.message || '', at: x.created_at
  }));
}

// The record is kept until it is asked to go, the same as the category one.
export async function clearProductChanges(realmId) {
  const r = await pool.query(`DELETE FROM product_changes WHERE realm_id = $1`, [realmId]);
  return r.rowCount || 0;
}
