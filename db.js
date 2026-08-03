import pg from 'pg';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Tables banayein agar mojood na hon
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
