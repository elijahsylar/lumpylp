// Item 9: the app's database user has only what the API needs.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import './helpers/env.js';
import mysql from 'mysql2/promise';

const conns = [];
after(async () => { for (const c of conns) await c.end(); });
async function as(user, password) {
  const c = await mysql.createConnection({ host: '127.0.0.1', port: 33306, user, password, database: process.env.DB_NAME });
  conns.push(c);
  return c;
}
async function denied(conn, sql, codes = [1142, 1143]) {
  await assert.rejects(conn.query(sql), (err) => codes.includes(err.errno) || assert.fail(`${sql}: ${err.errno} ${err.message}`));
}

test('the test suite itself runs as lumpylp_app', () => {
  assert.equal(process.env.DB_USER, 'lumpylp_app');
});

test('lumpylp_app: reads everything, writes only what the API needs', async () => {
  const c = await as('lumpylp_app', 'app-test-only');
  await c.query('SELECT id FROM tracks LIMIT 1');
  await c.query('SELECT id, password_hash FROM users LIMIT 1');
  await c.query('UPDATE tracks SET upvotes = upvotes WHERE id = 0');
  await denied(c, 'DELETE FROM tracks WHERE id = 0');
  await denied(c, "INSERT INTO tracks (external_id, source, title, artist_name) VALUES ('x','x','x','x')");
  await denied(c, "UPDATE tracks SET title = 'x' WHERE id = 0");
  await denied(c, 'DROP TABLE votes');
  await denied(c, 'ALTER TABLE users ADD COLUMN x INT');
  await denied(c, 'CREATE TABLE x (id INT)');
});

test('lumpylp_indexer: can ingest but not touch accounts or DDL', async () => {
  const c = await as('lumpylp_indexer', 'indexer-test-only');
  await c.query('SELECT id FROM tracks LIMIT 1');
  await c.query("UPDATE tracks SET genre = genre WHERE id = 0");
  await denied(c, 'DELETE FROM tracks WHERE id = 0');
  await denied(c, "UPDATE users SET email = email WHERE id = 0");
  await denied(c, 'SELECT password_hash FROM users LIMIT 1');
  await denied(c, 'DROP TABLE votes');
});
