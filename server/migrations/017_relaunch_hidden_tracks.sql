-- Relaunch G3 (2026-10-25): one way to take a track out of the catalog
-- without deleting it, and one dead-track flag the API and the sweep agree on.
--
-- hidden_at / hidden_reason / hidden_note: a hidden track is excluded from
--   every listing and stream. Reversible: clear hidden_at. Reasons in use:
--   rights_loc_jukebox, rights_check_pending, rights_musopen_european_archive,
--   pd_not_yet_1926, duplicate, takedown, rights, quality, admin.
-- pd_effective_on: for recordings that enter the US public domain on a known
--   date (17 USC 1401); scripts/unhide-pd-effective.js unhides them that day.
-- duplicate_of: set by scripts/dedupe-within-source.js on hidden duplicates.
-- is_live: the single filter every API query uses. A track is live when the
--   dead-link sweep hasn't marked it dead and nobody has hidden it.
--
-- Dead flags: the sweep historically set only is_dead (12,810 rows in prod on
-- 2026-10-25) while the API filtered on dead_marked_at (set on 0 rows), so
-- known-dead tracks were still served. The backfill below makes the two
-- agree; is_live then hides them (owner decision 4). The fixed sweep's
-- --mode=revive pass clears false positives later.
ALTER TABLE tracks
  ADD COLUMN hidden_at DATETIME NULL,
  ADD COLUMN hidden_reason VARCHAR(64) NULL,
  ADD COLUMN hidden_note VARCHAR(255) NULL,
  ADD COLUMN pd_effective_on DATE NULL,
  ADD COLUMN duplicate_of INT NULL,
  ADD COLUMN is_live TINYINT(1) AS (is_dead = 0 AND hidden_at IS NULL) STORED,
  ADD INDEX idx_tracks_hidden_reason (hidden_reason),
  ADD INDEX idx_tracks_duplicate_of (duplicate_of);

UPDATE tracks
   SET dead_marked_at = COALESCE(dead_checked_at, NOW()),
       dead_reason = CONCAT('sweep_', COALESCE(dead_status_code, 'unknown'))
 WHERE is_dead = 1 AND dead_marked_at IS NULL;

-- The old play-path marking (removed) could set dead_marked_at without is_dead.
UPDATE tracks SET is_dead = 1 WHERE dead_marked_at IS NOT NULL AND is_dead = 0;

-- Who hid or unhid what, and why (takedown path, item 14).
CREATE TABLE moderation_log (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  track_id INT NOT NULL,
  user_id INT UNSIGNED NULL,
  actor VARCHAR(64) NOT NULL,
  action ENUM('hide','unhide') NOT NULL,
  reason VARCHAR(64) NULL,
  note VARCHAR(255) NULL,
  created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_moderation_track (track_id),
  KEY idx_moderation_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Every change the dedupe script makes, so --undo can restore it exactly.
CREATE TABLE track_merge_log (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  run_id VARCHAR(32) NOT NULL,
  kind ENUM('hide','counts','lump_track_move','lump_track_drop','vote_move','vote_drop') NOT NULL,
  loser_id INT NOT NULL,
  keeper_id INT NOT NULL,
  row_id INT UNSIGNED NULL,
  before_json JSON NULL,
  created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  undone_at TIMESTAMP NULL,
  PRIMARY KEY (id),
  KEY idx_merge_run (run_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
