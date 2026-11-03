-- Relaunch G4 (2026-10-25): indexes so listing, top, search filters and
-- shuffle stop scanning and sorting the whole tracks table (relaunch item 8).
-- Measured with test/perf/perf.js on a 650k-row synthetic catalog: before
-- this, list/top/random/shuffle/search each scanned ~644k rows and filesorted
-- them (0.7-1.4 s); /api/artists took 5.5 s.
--
-- net_score: the "net lumps" the heap and top views sort by.
-- voted: whether a track has any votes at all (top views list only these).
ALTER TABLE tracks
  ADD COLUMN net_score INT AS (COALESCE(upvotes, 0) - COALESCE(downvotes, 0)) STORED,
  ADD COLUMN voted TINYINT(1) AS ((COALESCE(upvotes, 0) + COALESCE(downvotes, 0)) > 0) STORED,
  ADD INDEX ix_live_fresh (is_live, indexed_at, id),
  ADD INDEX ix_live_heap (is_live, net_score, upvotes, indexed_at, id),
  ADD INDEX ix_live_voted_heap (is_live, voted, net_score, upvotes, indexed_at, id),
  ADD INDEX ix_live_title (is_live, title, id),
  ADD INDEX ix_live_genre_fresh (is_live, genre, indexed_at, id),
  ADD INDEX ix_live_genre_heap (is_live, genre, net_score, upvotes, indexed_at, id),
  ADD INDEX ix_live_artist (is_live, artist_name, source);
