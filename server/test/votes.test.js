// Voting through the API, with the app connected as the least-privilege
// application user (lumpylp_app, db/grants.sql), as in production.
//
// Fixture work (creating users and tracks, reading rows back, holding a row
// lock, reading the lock tables) uses the test database's root user through
// helpers/db.js and fixtureConnection() below. The requests under test never do.
//
// Two votes from the same user for the same track that arrive together must
// not fail on uniq_user_track: no 500, and exactly one vote row. That overlap
// is forced (see voteAgainstHeldRow), not left to timing: two requests simply
// fired together only sometimes overlap, and when they do not the second is
// an ordinary toggle-off or switch.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import mysql from 'mysql2/promise';
import './helpers/env.js';
import { startApp, req } from './helpers/app.js';
import { q, insertTrack, makeUser, closeAdmin } from './helpers/db.js';

let app;
before(async () => { app = await startApp(); });
after(async () => { await app.close(); await closeAdmin(); });

const vote = (user, trackId, direction) =>
  req(app.base, `/api/tracks/${trackId}/vote`, { method: 'POST', token: user.token, json: { direction } });
const voteRows = (user, trackId) =>
  q(`SELECT direction, weight FROM votes WHERE user_id = ? AND track_id = ?`, [user.id, trackId]);
const counters = async (trackId) => (await q(`SELECT upvotes, downvotes FROM tracks WHERE id = ?`, [trackId]))[0];

// A second root connection for fixtures that must hold a transaction open
// (helpers/db.js shares one connection). Never used to send a vote.
const fixtureConnection = () => mysql.createConnection({
  host: '127.0.0.1', port: 33306, user: 'root', password: '', database: process.env.DB_NAME,
});

test('the vote tests run the app as lumpylp_app', () => {
  assert.equal(process.env.DB_USER, 'lumpylp_app');
});

test('a single vote as the application user: 200, counters updated, indexed_at untouched', async () => {
  const user = await makeUser();
  const trackId = await insertTrack();
  await q(`UPDATE tracks SET indexed_at = '2020-01-02 03:04:05' WHERE id = ?`, [trackId]);

  const r = await vote(user, trackId, 1);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { track_id: trackId, upvotes: 1, downvotes: 0, net_lumps: 1, user_vote: 1 });
  assert.deepEqual(await counters(trackId), { upvotes: 1, downvotes: 0 });
  assert.equal((await voteRows(user, trackId)).length, 1);

  const other = await makeUser();
  const d = await vote(other, trackId, -1);
  assert.deepEqual(d.body, { track_id: trackId, upvotes: 1, downvotes: 1, net_lumps: 0, user_vote: -1 });
  assert.deepEqual(await counters(trackId), { upvotes: 1, downvotes: 1 });

  // A vote must not move the track in the "fresh" listing (ordered by indexed_at).
  const [t] = await q(`SELECT DATE_FORMAT(indexed_at, '%Y-%m-%d %H:%i:%s') AS indexed_at FROM tracks WHERE id = ?`, [trackId]);
  assert.equal(t.indexed_at, '2020-01-02 03:04:05');
});

test('tracks.indexed_at has no ON UPDATE, so the recount need not (and may not) write it', async () => {
  const [col] = await q(
    `SELECT EXTRA FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tracks' AND COLUMN_NAME = 'indexed_at'`);
  assert.ok(col, 'tracks.indexed_at exists');
  assert.doesNotMatch(col.EXTRA, /on update/i);
  const src = fs.readFileSync(new URL('../routes/votes.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src.replace(/^\s*\/\/.*$/gm, ''), /indexed_at/, 'routes/votes.js writes no indexed_at');
});

// Deterministic duplicate: a second connection holds this user's vote row for
// the track in an open transaction, so the request's read finds no vote and
// its INSERT then waits on uniq_user_track. Once that wait is seen, the
// holder commits and the request's write meets an existing row: exactly the
// state two overlapping requests produce, without depending on timing.
async function voteAgainstHeldRow(user, trackId, { held, sent }) {
  const holder = await fixtureConnection();
  let response;
  try {
    await holder.query('START TRANSACTION');
    await holder.query(`INSERT INTO votes (user_id, track_id, direction, weight) VALUES (?, ?, ?, 1.00)`, [user.id, trackId, held]);
    // This transaction's id, from the locks it now holds (not from
    // information_schema.innodb_trx, which is served from a cache).
    const [[trx]] = await holder.query(
      `SELECT ENGINE_TRANSACTION_ID AS id FROM performance_schema.data_locks
       WHERE THREAD_ID = PS_CURRENT_THREAD_ID() AND OBJECT_NAME = 'votes' LIMIT 1`);
    assert.ok(trx, 'the holding transaction has a lock on votes');

    let settled = false;
    const pending = vote(user, trackId, sent).finally(() => { settled = true; });
    // Wait (bounded) until a statement is blocked by the holding transaction.
    let waiting = 0;
    for (let i = 0; i < 200 && !waiting && !settled; i++) {
      const [[w]] = await holder.query(
        `SELECT COUNT(*) AS n FROM performance_schema.data_lock_waits WHERE BLOCKING_ENGINE_TRANSACTION_ID = ?`, [trx.id]);
      waiting = Number(w.n);
      if (!waiting) await new Promise((r) => setTimeout(r, 25));
    }
    if (!waiting) {
      await holder.query('ROLLBACK');
      const early = await pending;
      assert.fail(`the vote request never waited on the held vote row within 5 s `
        + `(answered ${early.status} ${JSON.stringify(early.body)}); the duplicate path was not exercised`);
    }
    await holder.query('COMMIT');
    response = await pending;
  } finally {
    await holder.end();
  }
  return response;
}

test('a vote that collides with a concurrent insert of the same vote: no 500, exactly one vote row', async () => {
  const user = await makeUser(); // account under a day old: weight 0.25
  const trackId = await insertTrack();
  const r = await voteAgainstHeldRow(user, trackId, { held: 1, sent: 1 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { track_id: trackId, upvotes: 1, downvotes: 0, net_lumps: 1, user_vote: 1 });
  const rows = await voteRows(user, trackId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].direction, 1);
  assert.equal(Number(rows[0].weight), 0.25, 'the request stamped its own weight on the existing row');
  assert.deepEqual(await counters(trackId), { upvotes: 1, downvotes: 0 });
});

test('a vote that collides with a concurrent insert in the other direction: no 500, one row, the later vote wins', async () => {
  const user = await makeUser();
  const trackId = await insertTrack();
  const r = await voteAgainstHeldRow(user, trackId, { held: -1, sent: 1 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { track_id: trackId, upvotes: 1, downvotes: 0, net_lumps: 1, user_vote: 1 });
  const rows = await voteRows(user, trackId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].direction, 1);
  assert.deepEqual(await counters(trackId), { upvotes: 1, downvotes: 0 });
});

test('sequential votes keep their behaviour: insert, toggle off, switch, clear, weight, recount', async () => {
  const user = await makeUser(); // account under a day old: weight 0.25
  const trackId = await insertTrack();

  let r = await vote(user, trackId, 1);
  assert.deepEqual(r.body, { track_id: trackId, upvotes: 1, downvotes: 0, net_lumps: 1, user_vote: 1 });
  let rows = await voteRows(user, trackId);
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].weight), 0.25);

  r = await vote(user, trackId, 1); // same direction again: toggle off
  assert.deepEqual(r.body, { track_id: trackId, upvotes: 0, downvotes: 0, net_lumps: 0, user_vote: 0 });
  assert.equal((await voteRows(user, trackId)).length, 0);

  await vote(user, trackId, 1);
  // The account ages past 30 days: a switch stamps the weight again.
  await q(`UPDATE users SET created_at = NOW() - INTERVAL 40 DAY WHERE id = ?`, [user.id]);
  r = await vote(user, trackId, -1); // switch direction
  assert.deepEqual(r.body, { track_id: trackId, upvotes: 0, downvotes: 1, net_lumps: -1, user_vote: -1 });
  rows = await voteRows(user, trackId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].direction, -1);
  assert.equal(Number(rows[0].weight), 1);

  r = await vote(user, trackId, 0); // explicit clear
  assert.deepEqual(r.body, { track_id: trackId, upvotes: 0, downvotes: 0, net_lumps: 0, user_vote: 0 });
  assert.equal((await voteRows(user, trackId)).length, 0);
});
