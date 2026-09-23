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

  // Who may use the app at all, and what they may change. Admin is not kept here -
  // it is read from the ADMIN_EMAILS setting on the server, so nobody can make
  // themselves an admin by reaching the database. Everyone else is a user: they
  // see and download everything, and change nothing unless the admin says so.
  await pool.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS allowed BOOLEAN NOT NULL DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS rights  JSONB   NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS role    TEXT    NOT NULL DEFAULT 'viewer',
      ADD COLUMN IF NOT EXISTS last_in TIMESTAMPTZ
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
    `INSERT INTO users (sub, email, name, last_in) VALUES ($1, $2, $3, NOW())
     ON CONFLICT (sub) DO UPDATE SET email = $2, name = $3, last_in = NOW()`,
    [sub, email || null, name || null]
  );
}

// Everyone who has ever signed in, for the admin's list
export async function listUsers() {
  const r = await pool.query(
    `SELECT sub, email, name, allowed, rights, role, last_in, created_at
     FROM users ORDER BY created_at`
  );
  return r.rows;
}

// The admin says whether someone may use the app, and what they may change
export async function setUserAccess(sub, { allowed, rights, role }) {
  await pool.query(
    `UPDATE users SET
       allowed = COALESCE($2, allowed),
       rights  = COALESCE($3, rights),
       role    = COALESCE($4, role)
     WHERE sub = $1`,
    [sub, allowed === undefined ? null : !!allowed,
     rights === undefined ? null : JSON.stringify(rights),
     role === undefined ? null : String(role)]
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
    // a company saved before its name could be read shows its number, never the
    // word that was written where the name should have been
    name: (function(n){
      const t = String(n == null ? '' : n).trim();
      return (!t || t === 'null' || t === 'undefined') ? x.realm_id : t;
    })(x.company_name)
  }));
}
