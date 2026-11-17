import { Router } from 'express';
import { z } from 'zod';
import { pool, query } from '../db.js';
import { limiters } from '../lib/rateLimits.js';
import { requireAuth, optionalAuth } from '../middleware/auth.js';

// Mounted under /api/tracks in index.js so paths land at
//   POST /api/tracks/:id/vote
//   GET  /api/tracks/:id/votes
const router = Router({ mergeParams: true });

const VoteSchema = z.object({
  direction: z.union([z.literal(1), z.literal(-1), z.literal(0)]),
});

// Soft anti-brigading — store the user's account-age-derived weight per vote
// so the heap algorithm can later switch to weighted sums without backfilling
// sparse data. Phase 2C still sums simple counts; weight is informational.
function weightForAge(createdAt) {
  const ageDays = (Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60 * 24);
  if (ageDays < 1) return 0.25;
  if (ageDays < 7) return 0.50;
  if (ageDays < 30) return 0.75;
  return 1.00;
}

// A vote is one transaction on one connection, and every vote takes its
// locks in the same order:
//   1. the track row (SELECT ... FOR UPDATE), so votes on a track run one
//      after another;
//   2. the user's vote row (insert, update or delete);
//   3. the track row again for the counters (already held).
// Before this, the vote write and the recount were separate statements and
// simultaneous votes deadlocked two ways (both seen in InnoDB's deadlock
// report): an upsert holding a votes index entry and waiting for the track
// row (foreign-key check) against a recount holding the track row and
// waiting for that index entry; and a delete holding the vote row and
// waiting for its unique-index entry against an upsert holding them the
// other way round.
//
// Order matters inside the transaction too. The track lock must be the first
// statement, and the reads after it are plain (non-locking) reads: the
// transaction's snapshot is then taken once the lock is held, so it sees every
// vote the previous holder committed. A locking read on a vote row that does
// not exist yet would take a gap lock, and two such transactions could
// deadlock on their inserts.
//
// The locking read needs no extra grant: MySQL allows SELECT ... FOR UPDATE
// with SELECT plus any UPDATE privilege on the table, and the API user has
// UPDATE on the tracks counter columns (db/grants.sql).
//
// Returns null when the track row is gone, else { tally, userVote }.
async function castVote(conn, { userId, trackId, direction }) {
  await conn.beginTransaction();

  const [locked] = await conn.execute(`SELECT id FROM tracks WHERE id = ? FOR UPDATE`, [trackId]);
  if (!locked.length) {
    await conn.rollback();
    return null;
  }

  const [existing] = await conn.execute(
    `SELECT id, direction FROM votes WHERE user_id = ? AND track_id = ? LIMIT 1`,
    [userId, trackId]
  );
  const cur = existing[0];

  // Stamp weight at write time, from the account's age now.
  const currentWeight = async () => {
    const [rows] = await conn.execute(`SELECT created_at FROM users WHERE id = ?`, [userId]);
    return rows.length ? weightForAge(rows[0].created_at) : 1.00;
  };

  let userVote = direction;
  if (direction === 0 || (cur && cur.direction === direction)) {
    // Explicit clear, or toggle off: clicking the same arrow clears the vote.
    if (cur) await conn.execute(`DELETE FROM votes WHERE id = ?`, [cur.id]);
    userVote = 0;
  } else if (cur) {
    // Switch direction.
    await conn.execute(
      `UPDATE votes SET direction = ?, weight = ? WHERE id = ?`,
      [direction, await currentWeight(), cur.id]
    );
  } else {
    // No prior vote: insert. Votes through this route cannot collide any
    // more (they queue on the track row), but another writer still can, so
    // the statement stays atomic on uniq_user_track instead of failing with
    // a duplicate-key error.
    const weight = await currentWeight();
    await conn.execute(
      `INSERT INTO votes (user_id, track_id, direction, weight) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE direction = ?, weight = ?`,
      [userId, trackId, direction, weight, direction, weight]
    );
  }

  // Recount from the rows. Plain read (no locks on votes), then write only
  // upvotes and downvotes: the API's database user holds UPDATE on exactly
  // those counter columns of tracks (db/grants.sql). An earlier
  // `indexed_at = indexed_at` no-op here, meant to stop the column's old
  // ON UPDATE CURRENT_TIMESTAMP from re-stamping a voted track, needed UPDATE
  // on indexed_at too and so failed every vote under those grants. Migration
  // 004 removed the ON UPDATE and db/schema.sql has none, so a vote leaves
  // indexed_at alone (test/votes.test.js checks both).
  const [counts] = await conn.execute(
    `SELECT COALESCE(SUM(direction = 1), 0) AS upvotes, COALESCE(SUM(direction = -1), 0) AS downvotes
     FROM votes WHERE track_id = ?`,
    [trackId]
  );
  const upvotes = Number(counts[0].upvotes) || 0;
  const downvotes = Number(counts[0].downvotes) || 0;
  await conn.execute(`UPDATE tracks SET upvotes = ?, downvotes = ? WHERE id = ?`, [upvotes, downvotes, trackId]);

  await conn.commit();
  return { tally: { upvotes, downvotes, net_lumps: upvotes - downvotes }, userVote };
}

// Backstop only: with the lock order above, votes do not deadlock each
// other, but another writer on the same rows (a catalog maintenance script)
// still could. InnoDB then rolls one transaction back whole, so running the
// whole transaction again is safe: nothing of the failed attempt remains, and
// the toggle is decided afresh from the row as it then is, never applied
// twice. A lock wait timeout is not retried (it has already waited long).
const VOTE_ATTEMPTS = 3;

router.post('/:id/vote', requireAuth, limiters().votes, async (req, res, next) => {
  try {
    const trackId = parseInt(req.params.id, 10);
    if (!Number.isFinite(trackId)) return res.status(400).json({ error: 'bad track id' });

    const parsed = VoteSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'direction must be 1, -1, or 0' });
    const { direction } = parsed.data;
    const userId = req.user.id;

    // Confirm track exists (FK gives a meaningful error if not, but a 404 is friendlier)
    const trackRows = await query(`SELECT id FROM tracks WHERE id = ? AND is_live = 1 LIMIT 1`, [trackId]);
    if (!trackRows.length) return res.status(404).json({ error: 'track not found' });

    let result;
    const conn = await pool.getConnection();
    try {
      for (let attempt = 1; ; attempt++) {
        try {
          result = await castVote(conn, { userId, trackId, direction });
          break;
        } catch (err) {
          try { await conn.rollback(); } catch { /* connection already gone */ }
          if (err?.code !== 'ER_LOCK_DEADLOCK' || attempt >= VOTE_ATTEMPTS) throw err;
        }
      }
    } finally {
      conn.release();
    }
    if (!result) return res.status(404).json({ error: 'track not found' });

    res.json({
      track_id: trackId,
      ...result.tally,
      user_vote: result.userVote,
    });
  } catch (err) { next(err); }
});

router.get('/:id/votes', optionalAuth, async (req, res, next) => {
  try {
    const trackId = parseInt(req.params.id, 10);
    if (!Number.isFinite(trackId)) return res.status(400).json({ error: 'bad track id' });

    const trackRows = await query(`SELECT upvotes, downvotes FROM tracks WHERE id = ? LIMIT 1`, [trackId]);
    if (!trackRows.length) return res.status(404).json({ error: 'track not found' });

    const upvotes = Number(trackRows[0].upvotes) || 0;
    const downvotes = Number(trackRows[0].downvotes) || 0;
    let user_vote = 0;
    if (req.user) {
      const v = await query(
        `SELECT direction FROM votes WHERE user_id = ? AND track_id = ? LIMIT 1`,
        [req.user.id, trackId]
      );
      if (v.length) user_vote = Number(v[0].direction) || 0;
    }
    res.json({ upvotes, downvotes, net_lumps: upvotes - downvotes, user_vote });
  } catch (err) { next(err); }
});

export default router;
