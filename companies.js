import { pool } from './db.js';

export async function listCompanies() {
  const r = await pool.query(
    'SELECT realm_id, company_name, updated_at FROM companies ORDER BY company_name NULLS LAST'
  );
  return r.rows.map(x => ({
    realmId: x.realm_id,
    name: x.company_name || x.realm_id,
    updatedAt: x.updated_at
  }));
}
