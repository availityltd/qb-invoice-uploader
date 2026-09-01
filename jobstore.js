import { pool } from './db.js';

// An upload lives in memory while it runs, but a deploy or a restart wipes
// that. Its place is written here after every batch, so the run can be picked
// up again from exactly where it stopped.
export async function initJobStore() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS upload_jobs (
      realm_id   TEXT PRIMARY KEY,
      job_id     BIGINT,
      state      TEXT,
      invoices   JSONB,
      done       JSONB,
      failed     JSONB,
      opts       JSONB,
      cursor     INT,
      events     JSONB,
      updated_at TIMESTAMPTZ DEFAULT now()
    )
  `);
}

export async function saveJobStart(realmId, job) {
  await pool.query(
    `INSERT INTO upload_jobs (realm_id, job_id, state, invoices, done, failed, opts, cursor, events, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
     ON CONFLICT (realm_id) DO UPDATE SET
       job_id = $2, state = $3, invoices = $4, done = $5,
       failed = $6, opts = $7, cursor = $8, events = $9, updated_at = now()`,
    [
      realmId, job.id, job.state,
      JSON.stringify(job.invoices),
      JSON.stringify([...job.done]),
      JSON.stringify([...job.failed]),
      JSON.stringify({
        delay: job.delay,
        batchSize: job.batchSize,
        negativeItems: [...job.negSet]
      }),
      job.cursor,
      JSON.stringify(job.events.slice(-400))
    ]
  );
}

// after each batch only the moving parts are written - the invoice list does
// not change, so it is left alone
export async function saveJobProgress(realmId, job) {
  await pool.query(
    `UPDATE upload_jobs
        SET state = $2, done = $3, failed = $4, cursor = $5, events = $6, updated_at = now()
      WHERE realm_id = $1`,
    [
      realmId, job.state,
      JSON.stringify([...job.done]),
      JSON.stringify([...job.failed]),
      job.cursor,
      JSON.stringify(job.events.slice(-400))
    ]
  );
}

export async function clearJobRow(realmId) {
  await pool.query(`DELETE FROM upload_jobs WHERE realm_id = $1`, [realmId]);
}

// every run that was still going when the server went down
export async function unfinishedJobs() {
  const r = await pool.query(
    `SELECT * FROM upload_jobs
      WHERE state IN ('running','waiting','paused')
        AND updated_at > now() - interval '2 days'`
  );
  return r.rows;
}
