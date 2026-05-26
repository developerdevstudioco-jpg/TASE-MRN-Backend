import dotenv from 'dotenv';
import path from 'node:path';
import { Pool } from 'pg';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const connectionString = process.env.MRN_DATABASE_URL;
if (!connectionString) {
  console.error('MRN_DATABASE_URL is not set in .env');
  process.exit(2);
}

const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

(async () => {
  try {
    const res = await pool.query('SELECT NOW() as now');
    console.log('DB connected, time:', res.rows[0].now);
    await pool.end();
    process.exit(0);
  } catch (err) {
    console.error('DB connection failed:', err?.message || err);
    try { await pool.end(); } catch {}
    process.exit(1);
  }
})();
