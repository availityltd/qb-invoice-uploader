import { pool } from './db.js';

// A company saved before its name could be read carries nothing, or the word
// 'null' written where a name should have been. Neither is a name to show.
function nameOf(n) {
  const s = String(n == null ? '' : n).trim();
  return (!s || s === 'null' || s === 'undefined') ? '' : s;
}


export async function listCompanies() {
  const r = await pool.query(
    'SELECT realm_id, company_name, updated_at FROM companies ORDER BY company_name NULLS LAST'
  );
  return r.rows.map(x => ({
    realmId: x.realm_id,
    name: nameOf(x.company_name) || x.realm_id,
    updatedAt: x.updated_at
  }));
}
