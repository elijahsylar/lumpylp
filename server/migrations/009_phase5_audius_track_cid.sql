-- Phase 5 emergency: store Audius track_cid so we have a stable identifier
-- independent of any single discovery node. Direct creator-node access still
-- requires signed URLs (creator nodes return 401 for unsigned CID requests),
-- so this is data-layer future-proofing, not an active streaming bypass.
USE lumpylp;

ALTER TABLE tracks
  ADD COLUMN audius_track_cid VARCHAR(100) DEFAULT NULL,
  ADD INDEX idx_audius_cid (audius_track_cid);
