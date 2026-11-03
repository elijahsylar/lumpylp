// Owner decision 2: migration 016 only runs after a root-only dump exists.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import './helpers/env.js';
import mysql from 'mysql2/promise';

const DB = 'lumpylp_m016_test';
const here = path.dirname(new URL(import.meta.url).pathname);
const server = path.resolve(here, '..');
const script = path.join(server, 'scripts/run-migration-016.sh');
let tmp, defaults, conn;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'm016-'));
  defaults = path.join(tmp, 'client.cnf');
  fs.writeFileSync(defaults, '[client]\nhost=127.0.0.1\nport=33306\nuser=root\npassword=\n', { mode: 0o600 });
  conn = await mysql.createConnection({ host: '127.0.0.1', port: 33306, user: 'root', password: '', multipleStatements: true });
  await conn.query(`DROP DATABASE IF EXISTS ${DB}; CREATE DATABASE ${DB}; USE ${DB}`);
  await conn.query('SET FOREIGN_KEY_CHECKS=0;' + fs.readFileSync(path.join(server, 'db/schema.sql'), 'utf8'));
  await conn.query(fs.readFileSync(path.join(server, 'migrations/015_relaunch_users_role_token_version.sql'), 'utf8'));
  await conn.query(`INSERT INTO pending_signups (stripe_session_id, email, username, password_hash, expires_at)
                    VALUES ('cs_test_fixture', 'p@example.test', 'pending1', 'x', NOW())`);
  await conn.query(`INSERT INTO users (email, username, password_hash, stripe_customer_id, signup_method) VALUES ('u@example.test','u1','x','cus_fixture','coupon')`);
});
after(async () => {
  await conn.query(`DROP DATABASE IF EXISTS ${DB}`);
  await conn.end();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const run = (args) => spawnSync('bash', [script, ...args], {
  env: { ...process.env, LUMPYLP_ALLOW_NONROOT: '1' }, encoding: 'utf8' });

test('refuses to run without a readable defaults file', () => {
  const r = run([`--defaults-file=${tmp}/missing.cnf`, `--db=${DB}`, `--dump-root=${tmp}`]);
  assert.equal(r.status, 2);
});

test('refuses without root unless explicitly allowed', () => {
  const r = spawnSync('bash', [script, `--defaults-file=${defaults}`, `--db=${DB}`, `--dump-root=${tmp}`],
    { env: { ...process.env, LUMPYLP_ALLOW_NONROOT: '' }, encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stdout, /run as root/);
});

test('a failing dump stops the migration before anything is dropped', async () => {
  const r = run([`--defaults-file=${defaults}`, `--db=${DB}`, `--dump-root=/proc/no-such-dir`]);
  assert.notEqual(r.status, 0);
  const [[{ n }]] = await conn.query(`SELECT COUNT(*) n FROM information_schema.tables WHERE table_schema='${DB}' AND table_name='pending_signups'`);
  assert.equal(Number(n), 1);
});

test('dumps root-only first, then drops the tables and columns', async () => {
  const r = run([`--defaults-file=${defaults}`, `--db=${DB}`, `--dump-root=${tmp}`]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const dir = fs.readdirSync(tmp).find((d) => d.startsWith('lumpylp-predrop-'));
  assert.ok(dir, 'dump directory created');
  const st = fs.statSync(path.join(tmp, dir));
  assert.equal(st.mode & 0o777, 0o700);
  const dump = path.join(tmp, dir, 'predrop.sql');
  assert.equal(fs.statSync(dump).mode & 0o777, 0o600);
  const text = fs.readFileSync(dump, 'utf8');
  assert.match(text, /CREATE TABLE `pending_signups`/);
  assert.match(text, /cs_test_fixture/);
  const colsFile = path.join(tmp, dir, 'users-stripe-columns.tsv');
  assert.equal(fs.statSync(colsFile).mode & 0o777, 0o600);
  const tsv = fs.readFileSync(colsFile, 'utf8');
  assert.match(tsv, /cus_fixture/);
  // Only what is dropped: no users table, emails or password hashes (review R19).
  assert.doesNotMatch(text, /CREATE TABLE `users`/);
  assert.doesNotMatch(tsv, /password_hash|@example/);
  const [[{ n }]] = await conn.query(`SELECT COUNT(*) n FROM information_schema.tables WHERE table_schema='${DB}' AND table_name='pending_signups'`);
  assert.equal(Number(n), 0);
  const [cols] = await conn.query(`SHOW COLUMNS FROM ${DB}.users`);
  assert.equal(cols.some((c) => c.Field === 'stripe_customer_id'), false);
  // second run is a no-op
  const again = run([`--defaults-file=${defaults}`, `--db=${DB}`, `--dump-root=${tmp}`]);
  assert.equal(again.status, 0);
  assert.match(again.stdout, /already applied/);
  void execFileSync;
});
