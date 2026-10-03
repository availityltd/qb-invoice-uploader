// A product replacement lives in memory while it runs, and a deploy or a crash
// wipes that - which on a run of a few hundred invoices, each one slow for
// QuickBooks to take, means hours of work stopping halfway with nothing to say
// where. So the run is written down here as it goes, and a server that comes back
// carries on from what was left.
//
// Written every few transactions rather than after each one: the list is rewritten
// whole each time, and on thousands of invoices that is not free. A transaction
// changed but not yet written down is simply tried again after a restart, and
// QuickBooks answers that the old product is no longer on it - which the run
// counts as done.

import { pool, keyRunsByDesk } from './db.js';
import { realmOf, userOf } from './desk.js';

export async function initReplaceStore() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS replace_state (
      realm_id   TEXT NOT NULL,
      pairs      JSONB,
      scan       JSONB,
      rows       JSONB,
      job        JSONB,
      updated_at TIMESTAMPTZ DEFAULT now()
    )
  `);
  await keyRunsByDesk('replace_state');
}

// what a row needs to be run again - the rest is rebuilt or not needed
function slimRow(r) {
  return {
    kind: r.kind, kindLabel: r.kindLabel, qbId: r.qbId, doc: r.doc, date: r.date,
    name: r.name, total: r.total, hits: r.hits, hitTotal: r.hitTotal,
    state: r.state, note: r.note || ''
  };
}

function jobRow(job) {
  return {
    running: job.running, done: job.done, failed: job.failed, lines: job.lines,
    round: job.round, retried: job.retried, recovered: job.recovered,
    total: job.total, kinds: job.kinds || null, started: job.started,
    avgMs: job.avgMs || 0, log: (job.log || []).slice(-80)
  };
}

function scanRow(s) {
  if (!s) return null;
  return { from: s.from, to: s.to, kinds: s.kinds, found: s.found, read: s.read };
}

export async function saveReplace(desk, st) {
  await pool.query(
    `INSERT INTO replace_state (realm_id, user_sub, pairs, scan, rows, job, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6, now())
     ON CONFLICT (realm_id, user_sub) DO UPDATE SET
       pairs = $3, scan = $4, rows = $5, job = $6, updated_at = now()`,
    [
      realmOf(desk), userOf(desk),
      JSON.stringify(st.pairs || []),
      JSON.stringify(scanRow(st.scan)),
      JSON.stringify((st.rows || []).map(slimRow)),
      JSON.stringify(st.job ? jobRow(st.job) : null)
    ]
  );
}

export async function clearReplace(desk) {
  await pool.query(`DELETE FROM replace_state WHERE realm_id = $1 AND user_sub = $2`,
    [realmOf(desk), userOf(desk)]);
}

// every run that was still going when the server went down, not too old to trust
export async function unfinishedReplace() {
  const r = await pool.query(
    `SELECT * FROM replace_state
      WHERE job->>'running' = 'true'
        AND updated_at > now() - interval '2 days'`
  );
  return r.rows;
}
