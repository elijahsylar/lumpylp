-- Phase 16: strip marketplace layer.
--
-- Removes the artist-as-seller schema added in 006_phase3_artist_uploads.sql.
-- The catalog/listener-account model keeps everything that powers
-- browsing, voting, lumps, and themes.
--
-- BEFORE RUNNING THIS MIGRATION on production, run the verification
-- queries below and confirm all return zero. If anything is non-zero,
-- STOP — that means real marketplace data exists and dropping these
-- columns will destroy it.
--
--   SELECT COUNT(*) FROM tracks WHERE source = 'artist_upload';
--   SELECT COUNT(*) FROM tracks WHERE file_path IS NOT NULL;
--   SELECT COUNT(*) FROM tracks WHERE uploaded_by_user_id IS NOT NULL;
--   SELECT COUNT(*) FROM track_plays;
--   SELECT COUNT(*) FROM users WHERE is_artist = 1;
--
-- After confirmation, apply the entire file in one transaction.
USE lumpylp;

START TRANSACTION;

-- tracks: drop the FK first (named in 006 as fk_tracks_uploader), then
-- the index, then the columns.
ALTER TABLE tracks DROP FOREIGN KEY fk_tracks_uploader;
ALTER TABLE tracks DROP INDEX idx_tracks_uploaded_by;
ALTER TABLE tracks
  DROP COLUMN uploaded_by_user_id,
  DROP COLUMN file_path,
  DROP COLUMN file_size_bytes,
  DROP COLUMN play_count;

-- track_plays: only ever populated by the artist_upload streamer branch,
-- never read elsewhere. Safe to drop entirely.
DROP TABLE IF EXISTS track_plays;

-- users: drop the unique key + index first, then every marketplace
-- column added by 006.
ALTER TABLE users DROP INDEX uniq_artist_name;
ALTER TABLE users DROP INDEX idx_users_is_artist;
ALTER TABLE users
  DROP COLUMN is_artist,
  DROP COLUMN artist_name,
  DROP COLUMN artist_bio,
  DROP COLUMN artist_city,
  DROP COLUMN artist_region,
  DROP COLUMN artist_country,
  DROP COLUMN artist_lat,
  DROP COLUMN artist_lng,
  DROP COLUMN artist_avatar_url,
  DROP COLUMN artist_links,
  DROP COLUMN tip_paypal,
  DROP COLUMN tip_venmo,
  DROP COLUMN tip_cashapp,
  DROP COLUMN tip_kofi,
  DROP COLUMN tip_other,
  DROP COLUMN became_artist_at,
  DROP COLUMN became_artist_ordinal;

COMMIT;
