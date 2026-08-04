import pg from 'pg';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS companies (
      id             SERIAL PRIMARY KEY,
      realm_id       TEXT UNIQUE NOT NULL,
      company_name   TEXT,
      refresh_token  TEXT NOT NULL,
      created_at     TIMESTAMPTZ DEFAULT NOW(),
      updated_at     TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS upload_logs (
      id           SERIAL PRIMARY KEY,
      realm_id     TEXT NOT NULL,
      doc_number   TEXT,
      status       TEXT,
      message      TEXT,
      intuit_tid   TEXT,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS negative_items (
      realm_id    TEXT NOT NULL,
      item_name   TEXT NOT NULL,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (realm_id, item_name)
    );
  `);

  console.log('Database ready');
}

export async function saveCompany(realmId, companyName, refreshToken) {
  await pool.query(
    `INSERT INTO companies (realm_id, company_name, refresh_token)
     VALUES ($1, $2, $3)
     ON CONFLICT (realm_id)
     DO UPDATE SET refresh_token = $3, company_name = $2, updated_at = NOW()`,
    [realmId, companyName, refreshToken]
  );
}

export async function getCompany(realmId) {
  const r = await pool.query('SELECT * FROM companies WHERE realm_id = $1', [realmId]);
  return r.rows[0] || null;
}

export async function updateRefreshToken(realmId, refreshToken) {
  await pool.query(
    'UPDATE companies SET refresh_token = $1, updated_at = NOW() WHERE realm_id = $2',
    [refreshToken, realmId]
  );
}

export async function logUpload(realmId, docNumber, status, message, tid) {
  await pool.query(
    `INSERT INTO upload_logs (realm_id, doc_number, status, message, intuit_tid)
     VALUES ($1, $2, $3, $4, $5)`,
    [realmId, docNumber, status, (message || '').slice(0, 1000), tid || null]
  );
}

export async function getNegativeItems(realmId) {
  const r = await pool.query(
    'SELECT item_name FROM negative_items WHERE realm_id = $1',
    [realmId]
  );
  return r.rows.map(x => x.item_name);
}

export async function setNegativeItems(realmId, items) {
  await pool.query('DELETE FROM negative_items WHERE realm_id = $1', [realmId]);
  if (!items || !items.length) return;
  const values = items.map((_, i) => `($1, $${i + 2})`).join(',');
  await pool.query(
    `INSERT INTO negative_items (realm_id, item_name) VALUES ${values}
     ON CONFLICT DO NOTHING`,
    [realmId, ...items]
  );
}
