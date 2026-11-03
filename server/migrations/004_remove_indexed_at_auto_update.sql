-- Drop ON UPDATE CURRENT_TIMESTAMP from tracks.indexed_at.
-- The original schema declared `indexed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
-- ON UPDATE CURRENT_TIMESTAMP`, which meant every UPDATE on the tracks table
-- (including vote tally writes) silently re-stamped indexed_at to NOW().
-- Lists ordered by indexed_at then promoted any voted-on track to the top.
-- The indexer already writes indexed_at = CURRENT_TIMESTAMP explicitly in
-- its upsert, so removing the auto-trigger doesn't change indexer behavior.
USE lumpylp;

ALTER TABLE tracks
  MODIFY COLUMN indexed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;
