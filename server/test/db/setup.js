// Build the local test database from scratch:
//   1. DROP + CREATE <db> (default lumpylp_test) on the throwaway local MySQL
//   2. apply the production schema snapshot (db/schema.sql)
//      and seed the synthetic catalog
//   3. apply every migration numbered 015 and up, in order, exactly as they
//      will be applied to production
//   4. create the least-privilege users from db/grants.sql (if present)
//   (seed: synthetic catalog + planted fixtures go in BEFORE the migrations;
//    users, lumps and votes after)
//
// Usage: node test/db/setup.js [--db=name_test] [--tracks=N] [--quiet]
// Requires test/db/start-test-mysql.sh to be running. Never touches anything
// but 127.0.0.1:33306.
import '../helpers/env.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { assertTestDb } from '../helpers/guard.js';
import { seedTracks, seedCommunity } from './seed.js';
import { plant } from './fixtures.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(here, '../..');
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? true];
}));
const dbName = args.db || process.env.DB_NAME;
const quiet = !!args.quiet;
const log = (...m) => { if (!quiet) console.log(...m); };
assertTestDb({ ...process.env, DB_NAME: dbName });

export const BASE_SCHEMA = path.join(serverDir, 'db/schema.sql');
export const FIRST_NEW_MIGRATION = 15;

export function newMigrations() {
  const dir = path.join(serverDir, 'migrations');
  return fs.readdirSync(dir)
    .filter((f) => /^\d{3}[a-z]?_.*\.sql$/.test(f) && parseInt(f, 10) >= FIRST_NEW_MIGRATION)
    .sort()
    .map((f) => path.join(dir, f));
}

async function main() {
  let conn;
  try {
    conn = await mysql.createConnection({
      host: '127.0.0.1', port: 33306, user: 'root', password: '',
      multipleStatements: true, charset: 'utf8mb4',
    });
  } catch (err) {
    console.error(`cannot reach the test MySQL on 127.0.0.1:33306 (${err.code}). ` +
      'Start it with: test/db/start-test-mysql.sh');
    process.exit(2);
  }
  await conn.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
  await conn.query(`CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await conn.query(`USE \`${dbName}\``);
  await conn.query('SET FOREIGN_KEY_CHECKS=0;\n' + fs.readFileSync(BASE_SCHEMA, 'utf8') + '\nSET FOREIGN_KEY_CHECKS=1;');
  log(`schema: ${path.basename(BASE_SCHEMA)}`);
  // Catalog data first, then migrations: production data predates them, and
  // migrations 017+ act on existing rows (planted fixtures model those cases).
  const total = Number(args.tracks || 2000);
  const n = await seedTracks(conn, { total, log });
  await plant(conn);
  for (const m of newMigrations()) {
    await conn.query(fs.readFileSync(m, 'utf8'));
    log(`migration: ${path.basename(m)}`);
  }
  const grants = path.join(serverDir, 'db/grants.sql');
  if (fs.existsSync(grants)) {
    // The real file uses placeholders filled on the server; tests use fixed
    // local-only passwords and the test database name.
    const sql = fs.readFileSync(grants, 'utf8')
      .replaceAll('{{DB_NAME}}', dbName)
      .replaceAll('{{APP_PASSWORD}}', 'app-test-only')
      .replaceAll('{{INDEXER_PASSWORD}}', 'indexer-test-only')
      .replaceAll('{{HOST}}', '%')
      .replace(/\s+REQUIRE SSL/gi, '');
    await conn.query(sql);
    log('grants: db/grants.sql (test passwords, SSL not required locally)');
  }
  await seedCommunity(conn);
  log(`seeded ${n} synthetic tracks into ${dbName}`);
  await conn.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
