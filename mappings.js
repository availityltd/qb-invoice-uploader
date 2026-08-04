import { pool } from './db.js';

export async function initMappings() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS item_mappings (
      realm_id     TEXT NOT NULL,
      source_key   TEXT NOT NULL,
      source_sku   TEXT,
      source_name  TEXT,
      qb_item      TEXT,
      skip         BOOLEAN DEFAULT FALSE,
      updated_at   TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (realm_id, source_key)
    );
  `);
}

export async function getMappings(realmId) {
  const r = await pool.query(
    'SELECT source_key, source_sku, source_name, qb_item, skip FROM item_mappings WHERE realm_id = $1',
    [realmId]
  );
  const out = {};
  r.rows.forEach(row => {
    out[row.source_key] = {
      sku: row.source_sku,
      name: row.source_name,
      qbItem: row.qb_item,
      skip: row.skip
    };
  });
  return out;
}

export async function saveMapping(realmId, sourceKey, sourceSku, sourceName, qbItem, skip) {
  await pool.query(
    `INSERT INTO item_mappings (realm_id, source_key, source_sku, source_name, qb_item, skip)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (realm_id, source_key)
     DO UPDATE SET qb_item = $5, skip = $6, source_sku = $3, source_name = $4, updated_at = NOW()`,
    [realmId, sourceKey, sourceSku || null, sourceName || null, qbItem || null, !!skip]
  );
}
