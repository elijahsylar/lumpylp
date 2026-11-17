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

// Every write the API process makes (routes/*, lib/moderation.js,
// lib/geocode.js), in the shape the code sends it, must be allowed for
// lumpylp_app. None of these changes a row: the WHERE clauses match nothing
// and the INSERTs select no rows. When a route gains a write, add it here.
test('lumpylp_app: every write statement the API sends is allowed by the grants', async () => {
  const c = await as('lumpylp_app', 'app-test-only');
  for (const sql of [
    // routes/auth.js
    `INSERT INTO users (email, username, password_hash) SELECT 'x', 'x', 'x' FROM DUAL WHERE FALSE`,
    `UPDATE users SET theme = 'dark' WHERE id = 0`,
    `UPDATE users SET password_hash = 'x', token_version = token_version + 1, updated_at = NOW() WHERE id = 0`,
    // routes/votes.js
    `INSERT INTO votes (user_id, track_id, direction, weight) SELECT 0, 0, 1, 1.00 FROM DUAL WHERE FALSE
       ON DUPLICATE KEY UPDATE direction = 1, weight = 1.00`,
    `UPDATE votes SET direction = 1, weight = 1.00 WHERE id = 0`,
    `DELETE FROM votes WHERE id = 0`,
    `SELECT id FROM tracks WHERE id = 0 FOR UPDATE`,
    `UPDATE tracks SET upvotes = 0, downvotes = 0 WHERE id = 0`,
    // routes/lumps.js
    `INSERT INTO user_lumps (user_id, name, description, is_public) SELECT 0, 'x', NULL, 0 FROM DUAL WHERE FALSE`,
    `UPDATE user_lumps SET name = 'x', description = 'x', is_public = 1 WHERE id = 0`,
    `UPDATE user_lumps SET updated_at = CURRENT_TIMESTAMP WHERE id = 0`,
    `DELETE FROM user_lumps WHERE id = 0 AND user_id = 0`,
    `INSERT INTO lump_tracks (lump_id, track_id, position) SELECT 0, 0, 0 FROM DUAL WHERE FALSE`,
    `DELETE FROM lump_tracks WHERE lump_id = 0 AND track_id = 0`,
    `SET @pos := -1`,
    `UPDATE lump_tracks SET position = (@pos := @pos + 1) WHERE lump_id = 0 ORDER BY position ASC`,
    `UPDATE lump_tracks SET position = 0 WHERE lump_id = 0 AND track_id = 0`,
    // lib/moderation.js (admin hide and unhide)
    `UPDATE tracks SET hidden_at = COALESCE(hidden_at, NOW()), hidden_reason = 'x', hidden_note = 'x' WHERE id = 0`,
    `UPDATE tracks SET hidden_at = NULL, hidden_reason = NULL, hidden_note = NULL, duplicate_of = NULL WHERE id = 0`,
    `INSERT INTO moderation_log (track_id, user_id, actor, action, reason, note) SELECT 0, 0, 'x', 'hide', 'x', 'x' FROM DUAL WHERE FALSE`,
    `INSERT INTO moderation_log (track_id, user_id, actor, action) SELECT 0, 0, 'x', 'unhide' FROM DUAL WHERE FALSE`,
    // lib/geocode.js
    `INSERT INTO geocode_cache (\`query\`, display_name, lat, lng) SELECT 'x', 'x', 0, 0 FROM DUAL WHERE FALSE
       ON DUPLICATE KEY UPDATE display_name = VALUES(display_name), lat = VALUES(lat), lng = VALUES(lng), cached_at = CURRENT_TIMESTAMP`,
  ]) {
    await assert.doesNotReject(c.query(sql), sql);
  }
  // A locking read needs an UPDATE (or DELETE) privilege on the table: allowed
  // on tracks through the counter columns, refused where the API only reads.
  await denied(c, 'SELECT id FROM genres LIMIT 1 FOR UPDATE');
  // The statement the vote recount used to send is not allowed either: indexed_at is outside the column grant.
  await denied(c, 'UPDATE tracks SET upvotes = upvotes, downvotes = downvotes, indexed_at = indexed_at WHERE id = 0');
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
