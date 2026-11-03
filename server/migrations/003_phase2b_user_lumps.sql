-- Phase 2B: personal collections ("lumps") and the tracks lumped into them.
-- Note: track_id is signed INT to match the existing tracks.id column
-- (same gotcha as Phase 2A's votes table).
USE lumpylp;

CREATE TABLE IF NOT EXISTS user_lumps (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id     INT UNSIGNED NOT NULL,
  name        VARCHAR(100) NOT NULL,
  description VARCHAR(500) DEFAULT NULL,
  is_public   BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_lumps_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_user_lumps_user (user_id),
  INDEX idx_user_lumps_public (is_public, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS lump_tracks (
  id        INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  lump_id   INT UNSIGNED NOT NULL,
  track_id  INT          NOT NULL,
  position  INT UNSIGNED NOT NULL,
  added_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_lump_track (lump_id, track_id),
  INDEX idx_lump_tracks_lump (lump_id, position),
  CONSTRAINT fk_lump_tracks_lump  FOREIGN KEY (lump_id)  REFERENCES user_lumps(id) ON DELETE CASCADE,
  CONSTRAINT fk_lump_tracks_track FOREIGN KEY (track_id) REFERENCES tracks(id)     ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
