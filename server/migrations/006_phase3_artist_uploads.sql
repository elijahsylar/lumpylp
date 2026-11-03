-- Phase 3: artist accounts, self-uploaded tracks, tip jar, play counts.
-- Migration covers BOTH 3A (foundation) and 3B (polish: avatars, geocoding,
-- founding-artist ordinal). Columns for deferred features land now so we
-- don't have to re-migrate later.
USE lumpylp;

ALTER TABLE users
  ADD COLUMN is_artist        BOOLEAN      NOT NULL DEFAULT FALSE,
  ADD COLUMN artist_name      VARCHAR(255) DEFAULT NULL,
  ADD COLUMN artist_bio       TEXT         DEFAULT NULL,
  ADD COLUMN artist_city      VARCHAR(100) DEFAULT NULL,
  ADD COLUMN artist_region    VARCHAR(100) DEFAULT NULL,
  ADD COLUMN artist_country   VARCHAR(2)   DEFAULT NULL,
  ADD COLUMN artist_lat       DECIMAL(9,6) DEFAULT NULL,
  ADD COLUMN artist_lng       DECIMAL(9,6) DEFAULT NULL,
  ADD COLUMN artist_avatar_url VARCHAR(500) DEFAULT NULL,
  ADD COLUMN artist_links     JSON         DEFAULT NULL,
  ADD COLUMN tip_paypal       VARCHAR(255) DEFAULT NULL,
  ADD COLUMN tip_venmo        VARCHAR(100) DEFAULT NULL,
  ADD COLUMN tip_cashapp      VARCHAR(100) DEFAULT NULL,
  ADD COLUMN tip_kofi         VARCHAR(255) DEFAULT NULL,
  ADD COLUMN tip_other        VARCHAR(500) DEFAULT NULL,
  ADD COLUMN became_artist_at TIMESTAMP NULL DEFAULT NULL,
  ADD COLUMN became_artist_ordinal INT UNSIGNED DEFAULT NULL,
  ADD INDEX idx_users_is_artist (is_artist),
  ADD UNIQUE KEY uniq_artist_name (artist_name);

ALTER TABLE tracks
  ADD COLUMN uploaded_by_user_id INT UNSIGNED DEFAULT NULL,
  ADD COLUMN file_path           VARCHAR(500) DEFAULT NULL,
  ADD COLUMN file_size_bytes     BIGINT UNSIGNED DEFAULT NULL,
  ADD COLUMN play_count          INT UNSIGNED NOT NULL DEFAULT 0,
  ADD INDEX idx_tracks_uploaded_by (uploaded_by_user_id),
  ADD CONSTRAINT fk_tracks_uploader
    FOREIGN KEY (uploaded_by_user_id) REFERENCES users(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS track_plays (
  id        INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  track_id  INT NOT NULL,
  played_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_plays_track FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE,
  INDEX idx_plays_track (track_id, played_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS geocode_cache (
  query_key VARCHAR(255) PRIMARY KEY,
  lat       DECIMAL(9,6),
  lng       DECIMAL(9,6),
  cached_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
