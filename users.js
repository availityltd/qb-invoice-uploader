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
      ADD COLUMN IF NOT EXISTS last_in TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS decided_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS asked BOOLEAN NOT NULL DEFAULT TRUE
  `);

  // Everybody who was already here had been let in by the old rule, which let
  // anyone in who signed in. They are not waiting for a decision; the decision
  // about them is being taken again, once, when the server next starts.
  await pool.query(
    "UPDATE users SET decided_at = COALESCE(decided_at, created_at, NOW()) WHERE decided_at IS NULL"
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_companies (
      user_sub    TEXT NOT NULL,
      realm_id    TEXT NOT NULL,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (user_sub, realm_id)
    );
  `);
}

// Somebody signing in for the first time is not let in by signing in. They wait,
// with no access and no company, until the admin says who they are - and the
// admin is told they are waiting. Signing in again only moves the clock on; it
// never gives anybody anything they were not given.
export async function upsertUser(sub, email, name) {
  const r = await pool.query(
    `INSERT INTO users (sub, email, name, last_in, allowed, role)
     VALUES ($1, $2, $3, NOW(), FALSE, 'none')
     ON CONFLICT (sub) DO UPDATE SET email = $2, name = $3, last_in = NOW()
     RETURNING (xmax = 0) AS first_time`,
    [sub, email || null, name || null]
  );
  return !!(r.rows[0] && r.rows[0].first_time);
}

// Everyone who has ever signed in, for the admin's list
export async function listUsers() {
  const r = await pool.query(
    `SELECT sub, email, name, allowed, rights, role, last_in, decided_at, asked, created_at
     FROM users ORDER BY created_at`
  );
  return r.rows;
}

// The admin says whether someone may use the app, and what they may change
export async function setUserAccess(sub, { allowed, rights, role }) {
  await pool.query(
    `UPDATE users SET
       allowed    = COALESCE($2, allowed),
       rights     = COALESCE($3, rights),
       role       = COALESCE($4, role),
       decided_at = NOW()
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

// Which companies this person may work in. QuickBooks will not say - it has no
// list to ask for, and a user cannot be sent to Intuit to pick one because only
// an admin may connect an app to a company. So the admin says it here, once per
// person, and the chooser shows them that and nothing else.
export async function setUserCompanies(sub, realmIds) {
  const want = [...new Set((realmIds || []).map(String))];
  await pool.query('DELETE FROM user_companies WHERE user_sub = $1', [sub]);
  for (const realmId of want) {
    await pool.query(
      'INSERT INTO user_companies (user_sub, realm_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [sub, realmId]
    );
  }
}

// just the numbers, for the admin's page to tick
export async function realmsForUser(sub) {
  const r = await pool.query(
    'SELECT realm_id FROM user_companies WHERE user_sub = $1', [sub]
  );
  return r.rows.map(x => x.realm_id);
}

// The admins, found among the people who have signed in, so they can be told
// things. An address named on the server that has never signed in has no row
// here and nothing to be told on - it is emailed instead.
export async function usersByEmails(emails) {
  const want = [...new Set((emails || []).map(e => String(e).toLowerCase()))];
  if (!want.length) return [];
  const r = await pool.query(
    'SELECT sub, email, name FROM users WHERE LOWER(email) = ANY($1)', [want]
  );
  return r.rows;
}

// Turned away, and asking again. The decision is rubbed out rather than reversed
// - nobody lets themselves in - so the address goes back to the top of the
// admin's list as one nobody has answered yet.
export async function askAgain(sub) {
  const r = await pool.query(
    `UPDATE users SET decided_at = NULL, asked = TRUE
     WHERE sub = $1 AND (decided_at IS NOT NULL OR asked = FALSE)
     RETURNING sub`,
    [sub]
  );
  return r.rowCount > 0;
}

// Somebody who withdrew and has signed in again is asking by being here. Only
// them: an address the admin has already answered - let in or turned down - is
// left exactly as it was, because signing in is not a way to rub out an answer.
export async function resumeAsking(sub) {
  await pool.query(
    'UPDATE users SET asked = TRUE WHERE sub = $1 AND asked = FALSE AND decided_at IS NULL',
    [sub]
  );
}

// Withdrawing, which is not the same as being turned down. The admin has not
// answered and is no longer being asked to; the person can ask again whenever
// they like, and until they do there is nothing on anybody's list.
export async function stopAsking(sub) {
  const r = await pool.query(
    `UPDATE users SET asked = FALSE
     WHERE sub = $1 AND decided_at IS NULL AND asked = TRUE RETURNING sub`,
    [sub]
  );
  return r.rowCount > 0;
}
