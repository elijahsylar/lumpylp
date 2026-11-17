// Two votes from the same user for the same track that arrive together must
// not fail on uniq_user_track: no 500, and exactly one vote row.
//
// The overlap is forced (see voteAgainstHeldRow), not left to timing: two
// requests simply fired together only sometimes overlap, and when they do not
// the second is an ordinary toggle-off or switch, so such a test can neither
// fail reliably on the old code nor assert one fixed outcome on the new.
//
// The app pool connects as the test database's root user here, not as
// lumpylp_app: with the column grants in db/grants.sql the recount after a
// vote (routes/votes.js, `indexed_at = indexed_at`) is denied, so every vote
// answers 500 before the race can be observed. That is a separate problem
// from the duplicate-key race this file covers.
import './helpers/as-admin.js';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
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

// Deterministic duplicate: a second connection holds this user's vote row for
// the track in an open transaction, so the request's read finds no vote and
// its INSERT then waits on uniq_user_track. Once that wait is seen, the
// holder commits and the request's write meets an existing row: exactly the
// state two overlapping requests produce, without depending on timing.
async function voteAgainstHeldRow(user, trackId, { held, sent }) {
  const holder = await mysql.createConnection({
    host: '127.0.0.1', port: 33306, user: 'root', password: '', database: process.env.DB_NAME,
  });
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
