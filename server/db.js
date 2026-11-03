import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import fs from 'node:fs';
import { envCandidates } from './lib/env.js';

// Env loading: see lib/env.js (NODE_ENV and LUMPYLP_ROLE pick the file;
// nothing is loaded under NODE_ENV=test).
for (const p of envCandidates()) {
  if (fs.existsSync(p)) { dotenv.config({ path: p }); break; }
}

const poolConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASS || '',
  database: process.env.DB_NAME || 'lumpylp',
  waitForConnections: true,
  connectionLimit: 10,
  charset: 'utf8mb4',
};

// SSL — required for managed MySQL services (and any provider that
// terminates TLS at the gateway). Triggered by DB_SSL_CA pointing at a
// CA bundle on disk; rejectUnauthorized defaults to true (fail-closed).
if (process.env.DB_SSL_CA) {
  const caPath = process.env.DB_SSL_CA;
  if (!fs.existsSync(caPath)) {
    throw new Error(`DB_SSL_CA points at a file that does not exist: ${caPath}`);
  }
  poolConfig.ssl = {
    ca: fs.readFileSync(caPath),
    rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false',
  };
}

export const pool = mysql.createPool(poolConfig);

// Optional observer for diagnostics (the perf harness records every SQL
// statement an endpoint runs so it can EXPLAIN them). Unused in production.
let queryObserver = null;
export function setQueryObserver(fn) { queryObserver = fn; }

export async function query(sql, params = []) {
  if (queryObserver) queryObserver(sql, params);
  const [rows] = await pool.execute(sql, params);
  return rows;
}
