-- Phase 17.6 — dead-link sweep columns.
--
-- Adds three columns to tracks so the sweeper can mark each row as
-- alive / dead / unverified after HEAD-requesting its stream_url:
--
--   is_dead           — 1 = HEAD returned 4xx, 5xx-after-retries,
--                       timeout, DNS failure, connection refused, or
--                       any other terminal network error.
--                       0 = HEAD returned 2xx, OR row not yet checked,
--                       OR script gave up after 3 ambiguous 5xx.
--   dead_checked_at   — wall-clock time of the last HEAD attempt.
--                       NULL means never checked (re-runs pick up
--                       NULL rows). Set to NOW() when 5xx-give-up
--                       fires so we don't loop forever.
--   dead_status_code  — the HTTP code observed (2xx/3xx/4xx/5xx) or a
--                       synthetic marker:
--                          0  = request timeout (10s)
--                         -1  = DNS failure (ENOTFOUND / EAI_AGAIN)
--                         -2  = connection refused (ECONNREFUSED)
--                         -3  = other network error
--                         -99 = gave up after 3 inline 5xx retries
--                         310 = redirect cap exceeded (5 hops)
--
-- Two indexes — the sweeper needs `WHERE dead_checked_at IS NULL`
-- to scan cheaply at 412k rows, and the future "show dead tracks"
-- view will filter on is_dead.

ALTER TABLE tracks
  ADD COLUMN is_dead          TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN dead_checked_at  DATETIME   NULL,
  ADD COLUMN dead_status_code SMALLINT   NULL,
  ADD INDEX idx_tracks_is_dead         (is_dead),
  ADD INDEX idx_tracks_dead_checked_at (dead_checked_at);
