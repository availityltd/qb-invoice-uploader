import { pool } from './db.js';

export async function initUsers() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id          SERIAL PRIMARY KEY,
      sub         TEXT UNIQUE NOT NULL,
      email       TEXT,
      name        TEXT,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_companies (
      user_sub    TEXT NOT NULL,
      realm_id    TEXT NOT NULL,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (user_sub, realm_id)
    );
  `);
}

export async function upsertUser(sub, email, name) {
  await pool.query(
    `INSERT INTO users (sub, email, name) VALUES ($1, $2, $3)
     ON CONFLICT (sub) DO UPDATE SET email = $2, name = $3`,
    [sub, email || null, name || null]
  );
}

export async function getUser(sub) {
  const r = await pool.query('SELECT * FROM users WHERE sub = $1', [sub]);
  return r.rows[0] || null;
}

export async function linkCompany(sub, realmId) {
  await pool.query(
    `INSERT INTO user_companies (user_sub, realm_id) VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [sub, realmId]
  );
}

export async function userOwns(sub, realmId) {
  const r = await pool.query(
    'SELECT 1 FROM user_companies WHERE user_sub = $1 AND realm_id = $2',
    [sub, realmId]
  );
  return r.rowCount > 0;
}

export async function companiesForUser(sub) {
  const r = await pool.query(
    `SELECT c.realm_id, c.company_name
     FROM user_companies uc
     JOIN companies c ON c.realm_id = uc.realm_id
     WHERE uc.user_sub = $1
     ORDER BY c.company_name NULLS LAST`,
    [sub]
  );
  return r.rows.map(x => ({
    realmId: x.realm_id,
    name: x.company_name || x.realm_id
  }));
}
