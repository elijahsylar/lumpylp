import test from 'node:test';
import assert from 'node:assert/strict';
import { assertTestDb } from './helpers/guard.js';

test('the guard refuses anything but the local test database', () => {
  const ok = { DB_HOST: '127.0.0.1', DB_PORT: '33306', DB_NAME: 'lumpylp_test' };
  assert.doesNotThrow(() => assertTestDb(ok));
  for (const bad of [
    { ...ok, DB_HOST: 'db.example.com' },
    { ...ok, DB_HOST: 'localhost' },
    { ...ok, DB_PORT: '25060' },
    { ...ok, DB_PORT: '3306' },
    { ...ok, DB_NAME: 'lumpylp' },
  ]) assert.throws(() => assertTestDb(bad), /refusing to run tests/);
});

test('db.js loads no env file under NODE_ENV=test', async () => {
  await import('./helpers/env.js');
  const before = { ...process.env };
  await import('../db.js');
  assert.equal(process.env.DB_HOST, '127.0.0.1');
  assert.deepEqual(Object.keys(process.env).filter((k) => !(k in before)), []);
  const { pool } = await import('../db.js');
  await pool.end();
});
