-- Phase 6: track health columns. Lets us mark dead tracks (permanent
-- failures) and hide them from browse lists without hard-deleting.
-- Hard-delete is a later decision once we see how the numbers shake out.
USE lumpylp;

ALTER TABLE tracks
  ADD COLUMN last_play_attempt_at  TIMESTAMP NULL DEFAULT NULL,
  ADD COLUMN last_play_status      VARCHAR(20) DEFAULT NULL,
  ADD COLUMN consecutive_failures  INT UNSIGNED NOT NULL DEFAULT 0,
  ADD COLUMN dead_marked_at        TIMESTAMP NULL DEFAULT NULL,
  ADD COLUMN dead_reason           VARCHAR(100) DEFAULT NULL,
  ADD INDEX idx_tracks_dead   (dead_marked_at),
  ADD INDEX idx_tracks_health (last_play_status, consecutive_failures);
