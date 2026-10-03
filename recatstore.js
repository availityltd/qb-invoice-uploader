// A category change lives in memory while it runs, and a deploy or a restart
// wipes that. Two things are written here instead.
//
// `recat_state` is the scan and the run as they stand, so a restart picks the
// run back up from the transaction it had reached rather than starting the
// books again.
//
// `recat_moves` is the record of what was moved: one row per transaction, the
// heading it came from, the heading it went to, and what it was worth. A
// category change leaves no trace in QuickBooks' own audit log beyond "edited",
// so this is the only place that says why the P&L moved.

import { pool, keyRunsByDesk } from './db.js';
import { realmOf, userOf } from './desk.js';

export async function initRecatStore() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS recat_state (
      realm_id   TEXT NOT NULL,
      from_acct  JSONB,
      to_acct    JSONB,
      scan       JSONB,
      txns       JSONB,
      job        JSONB,
      updated_at TIMESTAMPTZ DEFAULT now()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS recat_moves (
      id         SERIAL PRIMARY KEY,
      realm_id   TEXT NOT NULL,
      txn_kind   TEXT,
      qb_id      TEXT,
      doc        TEXT,
      txn_date   DATE,
      name       TEXT,
      from_id    TEXT,
      from_name  TEXT,
      to_id      TEXT,
      to_name    TEXT,
      lines      INT,
      amount     NUMERIC(14,2),
      status     TEXT,
      message    TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    )
  `);

  // the half-finished run is one person's, the history below is the company's
  await keyRunsByDesk('recat_state');

  await pool.query(
    `CREATE INDEX IF NOT EXISTS recat_moves_realm ON recat_moves (realm_id, created_at DESC)`
  );
}

/* ==================== the state ==================== */

// What is worth writing down about a run. The rows themselves are kept in their
// own column, so the job holds only the keys it is working through and the
// place it has reached.
function jobRow(job) {
  if (!job) return null;
  return {
    running: job.running,
    stop: !!job.stop,
    done: job.done,
    failed: job.failed,
    changedLines: job.changedLines,
    moved: job.moved,
    total: job.total,
    cursor: job.cursor || 0,
    keys: job.keys || [],
    error: job.error || null,
    log: (job.log || []).slice(-200),
    started: job.started || null
  };
}

function scanRow(scan) {
  if (!scan) return null;
  return {
    running: scan.running, from: scan.from, to: scan.to, kinds: scan.kinds || null,
    upto: scan.upto, kind: scan.kind, found: scan.found, read: scan.read,
    error: scan.error || null, started: scan.started || null
  };
}

export async function saveRecatState(desk, st) {
  await pool.query(
    `INSERT INTO recat_state (realm_id, user_sub, from_acct, to_acct, scan, txns, job, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now())
     ON CONFLICT (realm_id, user_sub) DO UPDATE SET
       from_acct = $3, to_acct = $4, scan = $5, txns = $6, job = $7, updated_at = now()`,
    [
      realmOf(desk), userOf(desk),
      JSON.stringify(st.from || null),
      JSON.stringify(st.to || null),
      JSON.stringify(scanRow(st.scan)),
      JSON.stringify(st.rows || []),
      JSON.stringify(jobRow(st.job))
    ]
  );
}

// after each transaction only the moving parts are written - the two accounts
// and the scan behind them do not change once the run has started
export async function saveRecatProgress(desk, st) {
  await pool.query(
    `UPDATE recat_state SET txns = $2, job = $3, updated_at = now()
      WHERE realm_id = $1 AND user_sub = $4`,
    [realmOf(desk), JSON.stringify(st.rows || []), JSON.stringify(jobRow(st.job)), userOf(desk)]
  );
}

export async function loadRecatState(desk) {
  const r = await pool.query(
    `SELECT * FROM recat_state WHERE realm_id = $1 AND user_sub = $2`,
    [realmOf(desk), userOf(desk)]);
  const row = r.rows[0];
  if (!row) return null;

  return {
    from: row.from_acct || null,
    to: row.to_acct || null,
    scan: row.scan || null,
    rows: row.txns || [],
    job: row.job || null,
    at: row.updated_at ? new Date(row.updated_at).getTime() : Date.now()
  };
}

export async function clearRecatState(desk) {
  await pool.query(`DELETE FROM recat_state WHERE realm_id = $1 AND user_sub = $2`,
    [realmOf(desk), userOf(desk)]);
}

// every run that was still going when the server went down. A scan is not
// resumed - reading the books again is cheap and gives a fresher answer than a
// half-read one.
export async function unfinishedRecat() {
  const r = await pool.query(
    `SELECT * FROM recat_state
      WHERE job->>'running' = 'true'
        AND updated_at > now() - interval '2 days'`
  );
  return r.rows;
}

/* ==================== the record ==================== */

export async function logMove(realmId, st, row, out) {
  await pool.query(
    `INSERT INTO recat_moves
       (realm_id, txn_kind, qb_id, doc, txn_date, name,
        from_id, from_name, to_id, to_name, lines, amount, status, message)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      realmId, row.kind, String(row.qbId || ''), row.doc || '',
      row.date || null, (row.name || '').slice(0, 200),
      String(st.from.id), st.from.name, String(st.to.id), st.to.name,
      out.ok ? out.lines : row.hits.length,
      Number(row.hitTotal || 0),
      out.ok ? 'moved' : 'failed',
      (out.message || '').slice(0, 500)
    ]
  );
}

// The record is kept until it is asked to go. Emptying it throws away what was
// moved and out of which heading - QuickBooks' own audit log will still say the
// transaction was edited, but not why - so nothing here empties it on its own.
export async function clearMoves(realmId) {
  const r = await pool.query(`DELETE FROM recat_moves WHERE realm_id = $1`, [realmId]);
  return r.rowCount || 0;
}

// what has been moved in this company, newest first
export async function listMoves(realmId, limit = 200) {
  const r = await pool.query(
    `SELECT txn_kind, qb_id, doc, txn_date, name, from_name, to_name,
            lines, amount, status, message, created_at
       FROM recat_moves
      WHERE realm_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT $2`,
    [realmId, Math.min(Number(limit) || 200, 1000)]
  );

  return r.rows.map(x => ({
    kind: x.txn_kind,
    qbId: x.qb_id,
    doc: x.doc || '',
    date: x.txn_date ? new Date(x.txn_date).toISOString().slice(0, 10) : '',
    name: x.name || '',
    from: x.from_name || '',
    to: x.to_name || '',
    lines: Number(x.lines || 0),
    amount: Number(x.amount || 0),
    status: x.status,
    message: x.message || '',
    at: x.created_at
  }));
}
