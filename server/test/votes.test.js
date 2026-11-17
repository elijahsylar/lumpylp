// Voting through the API, with the app connected as the least-privilege
// application user (lumpylp_app, db/grants.sql), as in production.
//
// Fixture work (creating users and tracks, reading rows back, holding a row
// lock, reading the lock tables) uses the test database's root user through
// helpers/db.js and fixtureConnection() below. The requests under test never do.
//
// A vote whose INSERT meets a vote row written concurrently must not fail on
// uniq_user_track: no 500, and exactly one vote row. That collision is forced
// (see voteAgainstHeldRow), not left to timing.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import mysql from 'mysql2/promise';
import './helpers/env.js';
import { startApp, req } from './helpers/app.js';
import { q, insertTrack, makeUser, closeAdmin } from './helpers/db.js';

let app;
before(async () => {
  // The bursts below send more votes than the default per-user and per-IP
  // limits allow; rate limiting has its own test (g1-ratelimit).
  process.env.RATE_LIMITS = JSON.stringify({ votes: 100000, api: 100000 });
  app = await startApp();
});
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

// Wait (bounded, 5 s) until some statement is blocked by the transaction open
// on `fixture`; false if `stop()` turns true or the time runs out first.
async function blockedByFixture(fixture, stop = () => false) {
  // The fixture transaction's id, from the locks it holds (not from
  // information_schema.innodb_trx, which is served from a cache).
  const [[trx]] = await fixture.query(
    `SELECT ENGINE_TRANSACTION_ID AS id FROM performance_schema.data_locks
     WHERE THREAD_ID = PS_CURRENT_THREAD_ID() LIMIT 1`);
  assert.ok(trx, 'the fixture transaction holds a lock');
  for (let i = 0; i < 200 && !stop(); i++) {
    const [[w]] = await fixture.query(
      `SELECT COUNT(*) AS n FROM performance_schema.data_lock_waits WHERE BLOCKING_ENGINE_TRANSACTION_ID = ?`, [trx.id]);
    if (Number(w.n)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

// Deterministic duplicate: a second connection holds this user's vote row for
// the track in an open transaction, so the request's read finds no vote and
// its INSERT then waits on uniq_user_track. Once that wait is seen, the
// holder commits and the request's write meets an existing row. Votes sent
// through the API can no longer overlap like this (they queue on the track
// row), so the holder stands in for any other writer of the votes table.
async function voteAgainstHeldRow(user, trackId, { held, sent }) {
  const holder = await fixtureConnection();
  let response;
  try {
    // Without this the holder's INSERT would share-lock the track row for its
    // foreign-key check, the request would queue on the track row (as votes
    // through the API do) and simply see the committed vote: no collision.
    // With it, the request gets as far as its own INSERT, which is the path
    // that must not fail with a duplicate-key error.
    await holder.query('SET SESSION foreign_key_checks = 0');
    await holder.query('START TRANSACTION');
    await holder.query(`INSERT INTO votes (user_id, track_id, direction, weight) VALUES (?, ?, ?, 1.00)`, [user.id, trackId, held]);
    // This transaction's id, from the locks it now holds (not from
    // information_schema.innodb_trx, which is served from a cache).
    let settled = false;
    const pending = vote(user, trackId, sent).finally(() => { settled = true; });
    const waiting = await blockedByFixture(holder, () => settled);
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

// State of one track after a burst: vote rows per user, and whether the
// stored counters equal the rows.
async function assertConsistent(trackId, label) {
  const rows = await q(`SELECT user_id, direction FROM votes WHERE track_id = ?`, [trackId]);
  const perUser = new Map();
  for (const r of rows) perUser.set(r.user_id, (perUser.get(r.user_id) || 0) + 1);
  for (const [userId, n] of perUser) assert.equal(n, 1, `${label}: user ${userId} has ${n} vote rows`);
  assert.deepEqual(await counters(trackId), {
    upvotes: rows.filter((r) => r.direction === 1).length,
    downvotes: rows.filter((r) => r.direction === -1).length,
  }, `${label}: counters equal the rows`);
  return rows;
}
const statuses = (rs) => rs.map((r) => r.status).join(',');

test('simultaneous identical votes by one user are applied one after another (even: no vote, odd: one)', async () => {
  const user = await makeUser();
  for (const [n, expectedRows] of [[2, 0], [3, 1], [6, 0], [7, 1], [8, 0]]) {
    const trackId = await insertTrack();
    const rs = await Promise.all(Array.from({ length: n }, () => vote(user, trackId, 1)));
    assert.equal(statuses(rs), Array(n).fill(200).join(','), `${n} votes`);
    // Each response is a state the vote really had: on, off, on, ... in some order.
    assert.deepEqual(rs.map((r) => r.body.user_vote).sort(), Array.from({ length: n }, (_, i) => (i % 2 ? 0 : 1)).sort(), `${n} votes: responses`);
    const rows = await assertConsistent(trackId, `${n} votes`);
    assert.equal(rows.length, expectedRows, `${n} identical votes leave ${expectedRows} row(s)`);
  }
});

test('stress, one user: bursts of 10 simultaneous mixed votes on one track give no 500 and consistent counters', async () => {
  const MIXED = [1, -1, 1, 0, 1, -1, 1, 0, 1, -1];
  for (let round = 0; round < 25; round++) {
    const user = await makeUser();
    const trackId = await insertTrack();
    const rs = await Promise.all(MIXED.map((d) => vote(user, trackId, d)));
    assert.equal(statuses(rs), Array(MIXED.length).fill(200).join(','), `round ${round}`);
    const rows = await assertConsistent(trackId, `round ${round}`);
    assert.ok(rows.length <= 1, `round ${round}: ${rows.length} vote rows for one user`);
  }
});

test('stress, many users: 10 users voting on one track at once, twice each, give no 500 and consistent counters', async () => {
  const users = [];
  for (let i = 0; i < 10; i++) users.push(await makeUser());
  for (let round = 0; round < 10; round++) {
    const trackId = await insertTrack();
    // Each user sends two votes at once: [1, -1] for even users (ends on
    // whichever ran last), [1, 1] for odd users (on, then off).
    const rs = await Promise.all(users.flatMap((u, i) => [vote(u, trackId, 1), vote(u, trackId, i % 2 ? 1 : -1)]));
    assert.equal(statuses(rs), Array(20).fill(200).join(','), `round ${round}`);
    const rows = await assertConsistent(trackId, `round ${round}`);
    const voters = new Set(rows.map((r) => r.user_id));
    users.forEach((u, i) => assert.equal(voters.has(u.id), i % 2 === 0, `round ${round}: user ${i}`));
  }
});

// A real deadlock, to exercise the retry: the fixture holds the user's vote
// row, the request (holding the track row) waits for it, then the fixture
// asks for the track row. InnoDB rolls back the lighter transaction, which is
// the request (the fixture has written rows, the request none yet). The
// request must run again from the start and apply the toggle exactly once.
test('a vote rolled back by a deadlock is retried whole: 200, and the toggle is applied once', async () => {
  const user = await makeUser();
  const trackId = await insertTrack();
  assert.equal((await vote(user, trackId, 1)).status, 200);
  const [row] = await q(`SELECT id FROM votes WHERE user_id = ? AND track_id = ?`, [user.id, trackId]);

  const fixture = await fixtureConnection();
  let response;
  try {
    await fixture.query('START TRANSACTION');
    // Weight for the victim choice: rows written in this transaction (rolled back below).
    for (let i = 0; i < 40; i++) {
      await fixture.query(`INSERT INTO moderation_log (track_id, actor, action) VALUES (?, 'test:deadlock-fixture', 'hide')`, [trackId]);
    }
    await fixture.query(`SELECT id FROM votes WHERE id = ? FOR UPDATE`, [row.id]);

    let settled = false;
    const pending = vote(user, trackId, 1).finally(() => { settled = true; }); // same direction: toggle off
    if (!await blockedByFixture(fixture, () => settled)) {
      await fixture.query('ROLLBACK');
      const early = await pending;
      assert.fail(`the vote never waited on the held vote row (answered ${early.status}); no deadlock was set up`);
    }
    // Closes the cycle. Returns once the request has been rolled back.
    await fixture.query(`SELECT id FROM tracks WHERE id = ? FOR UPDATE`, [trackId]);
    await fixture.query('ROLLBACK');
    response = await pending;
  } finally {
    await fixture.end();
  }
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.deepEqual(response.body, { track_id: trackId, upvotes: 0, downvotes: 0, net_lumps: 0, user_vote: 0 });
  assert.equal((await voteRows(user, trackId)).length, 0, 'toggled off once, not off and on again');
  assert.deepEqual(await counters(trackId), { upvotes: 0, downvotes: 0 });
  assert.equal((await q(`SELECT COUNT(*) AS n FROM moderation_log WHERE actor = 'test:deadlock-fixture'`))[0].n, 0);
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
