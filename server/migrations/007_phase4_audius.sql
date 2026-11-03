-- Phase 4: Audius integration. Tracks an Audius response's `is_downloadable`
-- flag so the UI can disable the download button for non-CC sources while
-- still allowing streaming + lumping.
USE lumpylp;

ALTER TABLE tracks
  ADD COLUMN is_downloadable BOOLEAN NOT NULL DEFAULT TRUE;
