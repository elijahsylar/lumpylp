-- Phase 4B: store Audius user id per track so the deep-pull pass can
-- crawl an artist's full catalog (one /users/{id}/tracks call per artist
-- already represented in the catalog).
USE lumpylp;

ALTER TABLE tracks
  ADD COLUMN audius_user_id VARCHAR(20) DEFAULT NULL,
  ADD INDEX idx_audius_user (audius_user_id);
