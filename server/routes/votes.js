import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
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

async function getUserWeight(userId) {
  const rows = await query(`SELECT created_at FROM users WHERE id = ?`, [userId]);
  if (!rows.length) return 1.00;
  return weightForAge(rows[0].created_at);
}

async function recountAndFetch(trackId) {
  // `indexed_at = indexed_at` is an explicit no-op to suppress the column's
  // ON UPDATE CURRENT_TIMESTAMP trigger — without it, every vote silently
  // bumps the track's indexed_at and floats it to the top of any list
  // sorted by recency. Migration 004 drops the trigger entirely; this clause
  // remains as defense-in-depth for older deploys.
  await query(
    `UPDATE tracks SET
       upvotes   = (SELECT COUNT(*) FROM votes WHERE track_id = ? AND direction = 1),
       downvotes = (SELECT COUNT(*) FROM votes WHERE track_id = ? AND direction = -1),
       indexed_at = indexed_at
     WHERE id = ?`,
    [trackId, trackId, trackId]
  );
  const rows = await query(
    `SELECT upvotes, downvotes FROM tracks WHERE id = ?`,
    [trackId]
  );
  const r = rows[0] || { upvotes: 0, downvotes: 0 };
  const upvotes = Number(r.upvotes) || 0;
  const downvotes = Number(r.downvotes) || 0;
  return { upvotes, downvotes, net_lumps: upvotes - downvotes };
}

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

    const existing = await query(
      `SELECT id, direction FROM votes WHERE user_id = ? AND track_id = ? LIMIT 1`,
      [userId, trackId]
    );
    const cur = existing[0];

    let nextDirection = direction;

    if (direction === 0) {
      if (cur) {
        await query(`DELETE FROM votes WHERE id = ?`, [cur.id]);
      }
      nextDirection = 0;
    } else if (cur && cur.direction === direction) {
      // Toggle off — clicking the same arrow clears the vote.
      await query(`DELETE FROM votes WHERE id = ?`, [cur.id]);
      nextDirection = 0;
    } else if (cur) {
      // Switch direction. Recompute weight based on current account age.
      const weight = await getUserWeight(userId);
      await query(
        `UPDATE votes SET direction = ?, weight = ? WHERE id = ?`,
        [direction, weight, cur.id]
      );
    } else {
      // No prior vote — insert. Stamp weight at write time.
      const weight = await getUserWeight(userId);
      await query(
        `INSERT INTO votes (user_id, track_id, direction, weight) VALUES (?, ?, ?, ?)`,
        [userId, trackId, direction, weight]
      );
    }

    const tally = await recountAndFetch(trackId);
    res.json({
      track_id: trackId,
      ...tally,
      user_vote: nextDirection,
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
