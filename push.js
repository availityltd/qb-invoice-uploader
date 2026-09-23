import webpush from 'web-push';
import { pool } from './db.js';

// Telling somebody on their phone, with nothing borrowed to do it.
//
// A push needs a keypair, not an account: the app makes its own, keeps it, and
// signs each message with it. No mail account, no password of anyone's, nothing
// on the server that would open anything else if it leaked. The phone holds the
// other half and will only accept messages signed by this app.

let keys = null;

export async function initPush() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_keys (
      name   TEXT PRIMARY KEY,
      public TEXT NOT NULL,
      secret TEXT NOT NULL,
      at     TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS push_subs (
      id         SERIAL PRIMARY KEY,
      user_sub   TEXT NOT NULL,
      endpoint   TEXT UNIQUE NOT NULL,
      p256dh     TEXT NOT NULL,
      auth       TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS push_for ON push_subs (user_sub)');

  // made once, then kept - a new pair would silence every phone already signed up
  const got = await pool.query("SELECT public, secret FROM app_keys WHERE name = 'vapid'");
  if (got.rowCount) {
    keys = { publicKey: got.rows[0].public, privateKey: got.rows[0].secret };
  } else {
    keys = webpush.generateVAPIDKeys();
    await pool.query(
      "INSERT INTO app_keys (name, public, secret) VALUES ('vapid', $1, $2) " +
      'ON CONFLICT (name) DO NOTHING',
      [keys.publicKey, keys.privateKey]
    );
    console.log('Push: made this app its own keypair');
  }

  webpush.setVapidDetails(
    process.env.BASE_URL || 'https://example.invalid',
    keys.publicKey,
    keys.privateKey
  );
}

export function publicKey() {
  return keys ? keys.publicKey : null;
}

export async function addSub(sub, s) {
  if (!sub || !s || !s.endpoint || !s.keys) return;
  await pool.query(
    `INSERT INTO push_subs (user_sub, endpoint, p256dh, auth) VALUES ($1, $2, $3, $4)
     ON CONFLICT (endpoint) DO UPDATE SET user_sub = $1, p256dh = $3, auth = $4`,
    [sub, s.endpoint, s.keys.p256dh, s.keys.auth]
  );
}

export async function dropSub(endpoint) {
  if (!endpoint) return;
  await pool.query('DELETE FROM push_subs WHERE endpoint = $1', [endpoint]);
}

export async function hasSub(sub) {
  const r = await pool.query(
    'SELECT 1 FROM push_subs WHERE user_sub = $1 LIMIT 1', [sub]
  );
  return r.rowCount > 0;
}

// Every phone this person signed up on. One that has been uninstalled or cleared
// answers 404 or 410; that is the phone saying it is gone, so the row goes too
// rather than being tried again for ever.
export async function pushTo(sub, { title, body, link }) {
  if (!keys || !sub) return;

  const r = await pool.query(
    'SELECT endpoint, p256dh, auth FROM push_subs WHERE user_sub = $1', [sub]
  );
  if (!r.rowCount) return;

  const payload = JSON.stringify({ title, body: body || '', link: link || '/' });

  await Promise.all(r.rows.map(async row => {
    try {
      await webpush.sendNotification({
        endpoint: row.endpoint,
        keys: { p256dh: row.p256dh, auth: row.auth }
      }, payload);
    } catch (e) {
      if (e && (e.statusCode === 404 || e.statusCode === 410)) {
        await dropSub(row.endpoint);
      } else {
        console.error('push failed:', e && e.message);
      }
    }
  }));
}
