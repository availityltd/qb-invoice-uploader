import { pool } from './db.js';

// Things the app has to tell somebody: that an address is waiting to be let in,
// that a role has changed, that a company has been handed over. They are kept
// rather than only shown, because the person they are for is usually not looking
// at the screen when they happen.
export async function initNotify() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id          SERIAL PRIMARY KEY,
      user_sub    TEXT NOT NULL,
      kind        TEXT NOT NULL,
      title       TEXT NOT NULL,
      body        TEXT,
      link        TEXT,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      read_at     TIMESTAMPTZ
    );
  `);
  await pool.query(
    'CREATE INDEX IF NOT EXISTS notifications_for ON notifications (user_sub, created_at DESC)'
  );
}

export async function notify(sub, { kind, title, body, link }) {
  if (!sub || !title) return;
  await pool.query(
    `INSERT INTO notifications (user_sub, kind, title, body, link)
     VALUES ($1, $2, $3, $4, $5)`,
    [sub, kind || 'note', title, body || null, link || null]
  );
}

export async function listFor(sub, limit = 50) {
  const r = await pool.query(
    `SELECT id, kind, title, body, link, created_at, read_at
     FROM notifications WHERE user_sub = $1
     ORDER BY created_at DESC LIMIT $2`,
    [sub, Math.min(Number(limit) || 50, 200)]
  );
  return r.rows;
}

export async function unreadCount(sub) {
  const r = await pool.query(
    'SELECT COUNT(*)::int AS n FROM notifications WHERE user_sub = $1 AND read_at IS NULL',
    [sub]
  );
  return r.rows[0] ? r.rows[0].n : 0;
}

// Opening the list is reading it. One person's own, never anybody else's - the
// sub in the where clause is the session's, not something the page sent.
export async function markAllRead(sub) {
  await pool.query(
    'UPDATE notifications SET read_at = NOW() WHERE user_sub = $1 AND read_at IS NULL',
    [sub]
  );
}

export async function clearFor(sub) {
  await pool.query('DELETE FROM notifications WHERE user_sub = $1', [sub]);
}

/* ---------- the same thing again, by email ---------- */
// A notification is no use to an admin who is not in the app, and being told that
// somebody is waiting to be let in is exactly the case where they are not. So it
// goes out by email as well - when, and only when, the server has been given an
// SMTP account to send it from. Without one the app works exactly as before and
// says so in the log, rather than failing at the moment somebody signs in.

let mailer = null;
let mailerTried = false;

function mailConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

async function getMailer() {
  if (mailerTried) return mailer;
  mailerTried = true;
  if (!mailConfigured()) {
    console.log('Email: no SMTP_HOST/SMTP_USER/SMTP_PASS - notifications stay in the app');
    return null;
  }
  try {
    const nodemailer = (await import('nodemailer')).default;
    mailer = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: String(process.env.SMTP_SECURE || '') === 'true' || Number(process.env.SMTP_PORT) === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });
    console.log('Email: sending as ' + process.env.SMTP_USER);
  } catch (e) {
    console.error('Email: nodemailer not available -', e.message);
    mailer = null;
  }
  return mailer;
}

export async function sendMail(to, subject, lines) {
  if (!to) return false;
  const m = await getMailer();
  if (!m) return false;

  const text = lines.join('\n\n');
  const html = '<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;' +
    'font-size:14px;line-height:1.6;color:#18212A">' +
    lines.map(l => '<p>' + String(l)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</p>').join('') +
    '</div>';

  try {
    await m.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to, subject, text, html
    });
    return true;
  } catch (e) {
    console.error('Email to ' + to + ' failed:', e.message);
    return false;
  }
}
