// Keeps our own table in step with the couriers, without anyone asking.
// On start it works out how far behind each account is and fills the gap;
// after that it refreshes the last few days every ten minutes.

import { pool } from './db.js';
import { listAccounts, getAccount, saveOrders, trimRaw } from './couriers.js';
import { adapter as postexAdapter } from './postex.js';

const ADAPTERS = { postex: postexAdapter };

// Every sweep wakes the database, and it stays awake for some minutes after. Half
// an hour between sweeps lets it sleep for most of each one; courier statuses do
// not move faster than that. KEEPER_MINUTES on the server changes it.
const EVERY = Math.max(5, Number(process.env.KEEPER_MINUTES) || 30) * 60 * 1000;
const RECENT_DAYS = 4;             // what a routine refresh covers
const MAX_CATCHUP = 120;           // how far back a first fill will reach
const RAW_DAYS = 7;                // how long the courier's own JSON is kept

const sleep = ms => new Promise(r => setTimeout(r, ms));
const today = () => new Date().toISOString().slice(0, 10);

function shift(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// a month at a time - a whole span in one ask comes back short
function monthsBetween(from, to) {
  const out = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  const lastY = Number(to.slice(0, 4));
  const lastM = Number(to.slice(5, 7));

  let guard = 0;
  while ((y < lastY || (y === lastY && m <= lastM)) && guard < 60) {
    const start = `${y}-${String(m).padStart(2, '0')}-01`;
    const endDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const end = `${y}-${String(m).padStart(2, '0')}-${String(endDay).padStart(2, '0')}`;

    out.push({ from: start < from ? from : start, to: end > to ? to : end });

    m++;
    if (m > 12) { m = 1; y++; }
    guard++;
  }
  return out;
}

// what the page can show about the last sweep
const state = {
  running: false,
  startedAt: null,
  finishedAt: null,
  accounts: {},          // account id -> { label, from, to, saved, at, error }
  note: ''
};

export function keeperState() {
  return {
    running: state.running,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    note: state.note,
    accounts: Object.values(state.accounts)
  };
}

// the newest day we already hold for one account
async function lastDayOf(realmId, accountId) {
  const r = await pool.query(
    `SELECT MAX(booked_on) AS day FROM courier_orders
      WHERE realm_id = $1 AND account_id = $2`,
    [realmId, accountId]
  );
  const d = r.rows[0] && r.rows[0].day;
  return d ? new Date(d).toISOString().slice(0, 10) : null;
}

// every company that has a courier account
async function everyRealm() {
  const r = await pool.query(
    `SELECT DISTINCT realm_id FROM courier_accounts WHERE active IS NOT FALSE`
  );
  return r.rows.map(x => x.realm_id);
}

async function catchUpOne(realmId, acc) {
  const a = ADAPTERS[acc.courier];
  if (!a) return;

  const last = await lastDayOf(realmId, acc.id);
  const to = today();

  // nothing yet: reach back a few months. otherwise: from a little before
  // the newest day we hold, so anything that changed since is picked up
  const from = last ? shift(last, -(RECENT_DAYS - 1)) : shift(to, -MAX_CATCHUP);

  const mine = state.accounts[acc.id] = {
    id: acc.id,
    label: acc.label,
    from, to,
    saved: 0,
    at: new Date().toISOString(),
    error: null
  };

  const spans = monthsBetween(from, to);

  for (const s of spans) {
    try {
      const orders = await a.fetchOrders(acc.token, s.from, s.to, 0);
      const saved = await saveOrders(realmId, acc.id, acc.courier, orders);
      mine.saved += saved;
    } catch (e) {
      mine.error = e.message;
    }
    await sleep(400);
  }

  mine.at = new Date().toISOString();
}

async function sweep() {
  if (state.running) return;

  state.running = true;
  state.startedAt = new Date().toISOString();
  state.note = 'looking for anything missing';

  try {
    const realms = await everyRealm();

    for (const realmId of realms) {
      let list = [];
      try { list = await listAccounts(realmId); } catch (e) { continue; }

      for (const row of list) {
        if (!ADAPTERS[row.courier]) continue;

        // listAccounts leaves the token out
        const acc = await getAccount(realmId, row.id);
        if (!acc) continue;

        try {
          await catchUpOne(realmId, acc);
        } catch (e) {
          state.accounts[row.id] = {
            id: row.id, label: row.label, error: e.message,
            at: new Date().toISOString()
          };
        }
      }
    }

    // the untouched copies are only worth keeping while they are recent
    try {
      const freed = await trimRaw(RAW_DAYS);
      if (freed) state.trimmed = freed;
    } catch (e) { /* not worth failing a sweep over */ }

    state.note = '';
  } catch (e) {
    state.note = e.message;
  } finally {
    state.running = false;
    state.finishedAt = new Date().toISOString();
  }
}

export function startKeeper() {
  // a moment after the server settles, then every ten minutes
  setTimeout(() => { sweep().catch(() => {}); }, 15000);
  setInterval(() => { sweep().catch(() => {}); }, EVERY);
}

// for the button on the page
export function sweepNow() {
  if (state.running) return { started: false, note: 'already going' };
  sweep().catch(() => {});
  return { started: true };
}
