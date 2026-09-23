import { pool } from './db.js';

// A company saved before its name could be read carries nothing, or the word
// 'null' written where a name should have been. Neither is a name to show.
function nameOf(n) {
  const s = String(n == null ? '' : n).trim();
  return (!s || s === 'null' || s === 'undefined') ? '' : s;
}


// A company is connected when it has a realm number that QuickBooks would
// recognise and a key to reach it with. A row that has neither is wreckage from a
// sign-in that went wrong, and has no business being offered to anybody.
export async function listCompanies() {
  const r = await pool.query(
    'SELECT realm_id, company_name, refresh_token, updated_at FROM companies ORDER BY company_name NULLS LAST'
  );
  return r.rows
    .filter(x => /^[0-9]+$/.test(String(x.realm_id || '')) && x.refresh_token)
    .map(x => ({
      realmId: x.realm_id,
      name: nameOf(x.company_name) || x.realm_id,
      updatedAt: x.updated_at
    }));
}
