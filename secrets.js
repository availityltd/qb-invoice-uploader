// Courier portal passwords have to be kept, because the portals hand out
// sign-ins that die after a few hours and something has to sign in again
// without anyone watching. They are kept encrypted, and the key lives in the
// environment - so a copy of the database on its own is not enough to read
// them back.
//
// AES-256-GCM: the tag means a tampered-with value fails to decrypt rather
// than quietly turning into rubbish.

import crypto from 'crypto';

const ALGO = 'aes-256-gcm';

// PORTAL_KEY if it is set, otherwise the session secret this app already has,
// so nothing new has to be configured before this works.
function keyBytes() {
  const raw = process.env.PORTAL_KEY || process.env.SESSION_SECRET;
  if (!raw) {
    throw new Error('No PORTAL_KEY or SESSION_SECRET set - cannot keep passwords safely');
  }
  // any length of secret, one fixed-length key
  return crypto.createHash('sha256').update(String(raw)).digest();
}

export function encrypt(plain) {
  if (plain === null || plain === undefined || plain === '') return null;

  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv(ALGO, keyBytes(), iv);
  const out = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  const tag = c.getAuthTag();

  // v1 marks the shape, so a later change can still read what is stored now
  return 'v1:' + iv.toString('base64') + ':' + tag.toString('base64') + ':' + out.toString('base64');
}

export function decrypt(stored) {
  if (!stored) return null;

  const parts = String(stored).split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('That saved password is not in a shape we understand');
  }

  const iv = Buffer.from(parts[1], 'base64');
  const tag = Buffer.from(parts[2], 'base64');
  const body = Buffer.from(parts[3], 'base64');

  const d = crypto.createDecipheriv(ALGO, keyBytes(), iv);
  d.setAuthTag(tag);

  try {
    return Buffer.concat([d.update(body), d.final()]).toString('utf8');
  } catch (e) {
    // wrong key, almost always - the app was moved without its environment
    throw new Error('The saved password could not be read back. Has PORTAL_KEY changed?');
  }
}

// so a page can say "a password is saved" without ever sending it back
export function isSet(stored) {
  return !!stored;
}
