-- Phase 18 — per-track origin columns.
--
-- archive_pd78s ships first, but every subsequent resolver populates
-- these too. Decision: option (a) per-track country/region (rather
-- than backfilling artists.country) because pre-1929 opera singers
-- routinely recorded across multiple language markets, and lp_*-style
-- multi-tradition releases exist where the same artist has tracks of
-- genuinely different origins. v3 recon recommended (a); user
-- confirmed 2026-05-09.
--
-- Backfill plan: existing 447k rows stay NULL; only items ingested
-- after this migration get country/region populated. Old data could
-- be backfilled later via per-source heuristics (e.g., wikimedia
-- artist locations) but that's a separate phase.
--
-- VARCHAR(64) is overkill for ISO-2 country codes (2 chars) but the
-- resolver may also stuff longer human-readable region names like
-- "Latin America/Iberia" until we settle on a controlled vocabulary.
USE lumpylp;

ALTER TABLE tracks
  ADD COLUMN country VARCHAR(64) DEFAULT NULL COMMENT 'ISO-2 country code (e.g. IT, DE, FR) or longer label when ambiguous',
  ADD COLUMN region  VARCHAR(64) DEFAULT NULL COMMENT 'Continental/cultural region (Southern Europe, Eastern Europe, MENA, etc.)',
  ADD INDEX idx_tracks_country (country),
  ADD INDEX idx_tracks_region  (region);
