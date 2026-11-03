import { Router } from 'express';
import { query } from '../db.js';

const router = Router();

const PER_PAGE = 100;
// Hard cap on the universe; pagination operates within this. The catalog
// holds far more artists than this (11k+ locally, more in prod) — the cap
// is a deliberate performance ceiling, not a count. The Artists page labels
// its header "top N artists by track count" so the number is not mistaken
// for the whole roster. Raising this needs a real pagination story first:
// the ranking query sorts by track_count across the entire tracks table.
const MAX_TOTAL = 500;

// Filter clause shared between list + count queries — keeps both in sync.
const FILTER_SQL = `
  WHERE artist_name IS NOT NULL
    AND artist_name != ''
    AND artist_name != 'Unknown'
    AND artist_name != 'Unknown Artist'
    AND CHAR_LENGTH(artist_name) >= 2
    AND CHAR_LENGTH(artist_name) <= 100
    AND artist_name NOT REGEXP '^[0-9().*#@_ -]+$'
    AND artist_name NOT LIKE '(%'
    AND artist_name NOT LIKE '[%'
    AND artist_name NOT LIKE '{%'
    AND LOWER(artist_name) NOT LIKE '%copyright%'
    AND artist_name NOT LIKE '%©%'
    AND LOWER(artist_name) NOT LIKE '%see musopen%'
    AND LOWER(artist_name) NOT LIKE '%see %for %info%'
    AND LOWER(artist_name) NOT LIKE 'http%'
    AND is_live = 1
`;

// The ranking aggregates every live track (GROUP BY artist over ~640k rows,
// a few seconds at production scale), so the full top-500 list is computed
// at most once per CACHE_TTL_MS and pages are cut from it. The catalog only
// changes when the indexer runs, so 10 minutes of staleness is fine.
const CACHE_TTL_MS = 10 * 60 * 1000;
let ranking = { at: 0, promise: null };

async function computeRanking() {
  const rows = await query(
      `SELECT artist_name AS name,
              COUNT(*) AS track_count,
              GROUP_CONCAT(DISTINCT source) AS sources_csv
       FROM tracks
       ${FILTER_SQL}
       GROUP BY artist_name
       HAVING track_count >= 1
       ORDER BY track_count DESC, artist_name ASC
       LIMIT ${MAX_TOTAL}`
  );
  return rows;
}

function cachedRanking() {
  if (!ranking.promise || Date.now() - ranking.at > CACHE_TTL_MS) {
    ranking = { at: Date.now(), promise: computeRanking() };
    ranking.promise.catch(() => { ranking = { at: 0, promise: null }; });
  }
  return ranking.promise;
}

router.get('/', async (req, res, next) => {
  try {
    const page = Math.min(Math.ceil(MAX_TOTAL / PER_PAGE), Math.max(1, parseInt(req.query.page) || 1));
    const offset = (page - 1) * PER_PAGE;

    const all = await cachedRanking();
    const rows = all.slice(offset, offset + PER_PAGE);
    const total = all.length;

    // Second pass — one batched query for top genres of the artists we just
    // returned. mysql2's pool.execute is a prepared statement, so we manually
    // build the placeholders for the IN clause.
    const names = rows.map((r) => r.name);
    const topGenresByArtist = new Map();
    if (names.length) {
      const placeholders = names.map(() => '?').join(',');
      const genreRows = await query(
        `SELECT artist_name, genre, COUNT(*) AS cnt
         FROM tracks
         WHERE artist_name IN (${placeholders})
           AND genre IS NOT NULL
           AND genre != ''
           AND is_live = 1
         GROUP BY artist_name, genre
         ORDER BY artist_name ASC, cnt DESC`,
        names
      );

      // Take top 2 per artist — rows arrive grouped + score-sorted.
      for (const g of genreRows) {
        const list = topGenresByArtist.get(g.artist_name) || [];
        if (list.length < 2) {
          list.push(g.genre);
          topGenresByArtist.set(g.artist_name, list);
        }
      }
    }

    const artists = rows.map((r) => ({
      name: r.name,
      track_count: Number(r.track_count) || 0,
      sources: (r.sources_csv || '').split(',').filter(Boolean),
      top_genres: topGenresByArtist.get(r.name) || [],
    }));

    res.json({ artists, total, page, perPage: PER_PAGE });
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const rows = await query(`SELECT * FROM artists WHERE id = ?`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// GET /api/artists/by-name/:name — lightweight lookup that surfaces
// location data (city/country/lat/lng/source) for any artist by name.
// Used by the public Artist profile page.
router.get('/by-name/:name', async (req, res, next) => {
  try {
    const name = String(req.params.name || '').trim();
    if (!name) return res.status(400).json({ error: 'missing name' });
    // Several sources can carry the same artist name; show the oldest row.
    const rows = await query(
      `SELECT id, name, source, city, country, location_source, lat, lng,
              location_geocoded_at
       FROM artists
       WHERE name = ?
       ORDER BY id ASC
       LIMIT 1`,
      [name]
    );
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json({ artist: rows[0] });
  } catch (err) { next(err); }
});

export default router;
