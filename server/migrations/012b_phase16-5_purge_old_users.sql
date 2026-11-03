-- Phase 16.5b: purge existing users + their cascading data.
--
-- IRREVERSIBLE. Only apply AFTER the Stripe signup flow is verified
-- end-to-end with at least one real test signup that:
--   1. creates a row in users with paid_at set
--   2. can log in
--   3. can lump a track
--   4. can build a personal lump
--
-- Pre-flight verification (run BEFORE applying):
--
--   SELECT id, username, email, paid_at, signup_method
--     FROM users ORDER BY id;
--   -- expected: at least one row with paid_at IS NOT NULL
--   -- (the test signup); the older test and soft-launch rows have
--   -- paid_at = NULL (added in 012a as nullable).
--
--   SELECT COUNT(*) FROM votes;
--   SELECT COUNT(*) FROM user_lumps;
--   SELECT COUNT(*) FROM lump_tracks;
--   -- note these counts; they should drop by exactly the count
--   -- attributable to the deleted users post-apply.
--
-- Post-apply verification:
--
--   SELECT COUNT(*) FROM users WHERE paid_at IS NULL;
--   -- expected: 0
--
--   SELECT COUNT(*) FROM users WHERE id IN (5, 6);
--   -- expected: 0
--
USE lumpylp;

START TRANSACTION;

-- Explicit deletes for clarity even though the FK cascades would
-- handle most of this:
--   votes.user_id      → users(id) ON DELETE CASCADE
--   user_lumps.user_id → users(id) ON DELETE CASCADE
--   lump_tracks.lump_id → user_lumps(id) ON DELETE CASCADE (transitive)
DELETE FROM lump_tracks;
DELETE FROM user_lumps;
DELETE FROM votes;
DELETE FROM users;

ALTER TABLE users AUTO_INCREMENT = 1;

-- tracks.upvotes / downvotes are denormalized aggregates updated by
-- routes/votes.js#recountAndFetch after each vote write. Wiping the
-- votes table doesn't recompute these counters, so any track that had
-- been lumped pre-purge would still appear on /top with stale numbers.
-- Reset every non-zero counter row so /top is genuinely empty after
-- the purge.
UPDATE tracks SET upvotes = 0, downvotes = 0
WHERE upvotes > 0 OR downvotes > 0;

COMMIT;
