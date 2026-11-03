// /api/discover — location-lens endpoints powering the redesigned
// /discover page (Phase 11B). Reads from the artists.lat/lng populated
// by the Phase 11A backfill.

import { Router } from 'express';
import { query } from '../db.js';
import { geocode, GeocodeBusyError } from '../lib/geocode.js';
import { optionalAuth } from '../middleware/auth.js';
import { TRACK_COLUMNS_SQL, serializeTrack } from '../lib/trackShape.js';

const router = Router();

const ALLOWED_RADII = new Set([25, 50, 100, 250]);
const DEFAULT_RADIUS = 50;
const ARTISTS_LIMIT = 100;
const TRACKS_LIMIT = 100;

// Convert miles to km — Earth's radius in km is used by the Haversine formula.
const KM_PER_MILE = 1.609344;
const EARTH_RADIUS_KM = 6371;

// MySQL-side Haversine fragment in km. Multiply by 0.621371 to get miles.
// Embedded in SELECT so we can ORDER BY distance.
//   p_lat / p_lng = the resolved query coordinate (params)
const haversineKmFrag = `
  ( ${EARTH_RADIUS_KM} *
    ACOS(
      LEAST(1.0,
        COS(RADIANS(?)) * COS(RADIANS(a.lat)) *
        COS(RADIANS(a.lng) - RADIANS(?)) +
        SIN(RADIANS(?)) * SIN(RADIANS(a.lat))
      )
    )
  )
`;

// Lat/lng box around a point, as [minLat, maxLat, minLng, maxLng]. A cheap
// prefilter (idx_artists_location) before the exact Haversine distance, so
// the city search no longer computes a distance for every located artist.
// Doesn't wrap at the antimeridian; no catalog city is that close to it.
function boundingBox(lat, lng, radiusKm) {
  const dLat = radiusKm / 111.045;
  const dLng = Math.min(180, radiusKm / (111.045 * Math.max(0.01, Math.cos((lat * Math.PI) / 180))));
  return [lat - dLat, lat + dLat, lng - dLng, lng + dLng];
}

// GET /api/discover/cities?q=<query>&radius=<miles>
router.get('/cities', optionalAuth, async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.status(400).json({ error: 'missing query' });
    const radiusReq = parseInt(String(req.query.radius || ''), 10);
    const radius = ALLOWED_RADII.has(radiusReq) ? radiusReq : DEFAULT_RADIUS;
    const radiusKm = radius * KM_PER_MILE;

    let resolved;
    try {
      resolved = await geocode(q);
    } catch (err) {
      if (err instanceof GeocodeBusyError) {
        res.setHeader('Retry-After', '30');
        return res.status(503).json({ error: 'city lookup is busy, try again shortly' });
      }
      throw err;
    }
    if (!resolved) {
      return res.status(400).json({ error: 'Could not find that city' });
    }

    // 1) Artists within radius. Sort by distance asc, then track count desc.
    const artistRows = await query(
      `SELECT
         a.id, a.name, a.source, a.city, a.country, a.location_source,
         a.lat, a.lng,
         (${haversineKmFrag}) AS distance_km,
         (SELECT COUNT(*) FROM tracks t
            WHERE t.artist_name = a.name
              AND t.is_live = 1) AS track_count
       FROM artists a
       WHERE a.lat BETWEEN ? AND ? AND a.lng BETWEEN ? AND ?
         AND (${haversineKmFrag}) <= ?
       ORDER BY distance_km ASC, track_count DESC
       LIMIT ${ARTISTS_LIMIT}`,
      [
        resolved.lat, resolved.lng, resolved.lat,  // distance SELECT
        ...boundingBox(resolved.lat, resolved.lng, radiusKm),
        resolved.lat, resolved.lng, resolved.lat,  // distance WHERE
        radiusKm,
      ]
    );

    // Phase 17.10: bulk genre rollup. One aggregate query gets per-artist
    // genre counts; we derive top_genres in JS by selecting genres that
    // are >=20% of an artist's track count, capped at 3. Avoids the
    // N+1 sub-query per card. Indexed on tracks.artist_name + tracks.genre.
    const artistNames = artistRows.map((r) => r.name);
    const genresByArtist = new Map();
    if (artistNames.length > 0) {
      const phNames = artistNames.map(() => '?').join(',');
      const genreRows = await query(
        `SELECT t.artist_name, t.genre, COUNT(*) AS n
           FROM tracks t
          WHERE t.artist_name IN (${phNames})
            AND t.is_live = 1
            AND t.genre IS NOT NULL
            AND t.genre <> ''
          GROUP BY t.artist_name, t.genre`,
        artistNames
      );
      for (const r of genreRows) {
        const arr = genresByArtist.get(r.artist_name) || [];
        arr.push({ genre: r.genre, n: Number(r.n) });
        genresByArtist.set(r.artist_name, arr);
      }
    }

    const GENRE_MIN_SHARE = 0.20;
    const GENRE_MAX_RETURN = 3;
    const artists = artistRows.map((r) => {
      const total = Number(r.track_count) || 0;
      let topGenres = [];
      if (total > 0) {
        const candidates = genresByArtist.get(r.name) || [];
        topGenres = candidates
          .slice() // don't mutate the cached array
          .sort((a, b) => b.n - a.n)
          .filter((g) => g.n / total >= GENRE_MIN_SHARE)
          .slice(0, GENRE_MAX_RETURN)
          .map((g) => g.genre);
      }
      return {
        id: r.id,
        name: r.name,
        source: r.source,
        city: r.city,
        country: r.country,
        location_source: r.location_source,
        lat: r.lat == null ? null : Number(r.lat),
        lng: r.lng == null ? null : Number(r.lng),
        distance_miles: Math.round(Number(r.distance_km) / KM_PER_MILE),
        track_count: total,
        top_genres: topGenres,
      };
    });

    // 2a) Total live-track count in radius. Used by the "shuffle all in
    // {city}" button so the label can show the true population
    // ("1,736 tracks") rather than the top-100 cap below. Same JOIN +
    // Haversine the shuffle endpoint uses, so the numbers match.
    let totalTracks = 0;
    if (artists.length > 0) {
      const totalRows = await query(
        `SELECT COUNT(*) AS n
           FROM tracks t
           JOIN artists a ON a.name = t.artist_name AND a.source = t.source
          WHERE t.is_live = 1
            AND a.lat BETWEEN ? AND ? AND a.lng BETWEEN ? AND ?
            AND (${haversineKmFrag}) <= ?`,
        [...boundingBox(resolved.lat, resolved.lng, radiusKm), resolved.lat, resolved.lng, resolved.lat, radiusKm]
      );
      totalTracks = Number(totalRows[0]?.n) || 0;
    }

    // 2b) Top tracks by these artists. We re-join via artist name (the same
    // dedupe key the artists table uses). Sorted by distance, then net_lumps.
    let tracks = [];
    if (artistNames.length > 0) {
      const placeholders = artistNames.map(() => '?').join(',');
      const trackRows = await query(
        `SELECT
           ${TRACK_COLUMNS_SQL},
           a.city  AS artist_city,
           a.country AS artist_country,
           a.location_source AS artist_location_source,
           (${haversineKmFrag}) AS distance_km
         FROM tracks t
         JOIN artists a ON a.name = t.artist_name AND a.source = t.source
         WHERE t.is_live = 1
           AND a.lat IS NOT NULL
           AND a.name IN (${placeholders})
           AND (${haversineKmFrag}) <= ?
         ORDER BY distance_km ASC, net_lumps DESC, t.id DESC
         LIMIT ${TRACKS_LIMIT}`,
        [
          resolved.lat, resolved.lng, resolved.lat,  // SELECT distance
          ...artistNames,
          resolved.lat, resolved.lng, resolved.lat,  // WHERE distance
          radiusKm,
        ]
      );
      tracks = trackRows.map((t) => serializeTrack({
        ...t,
        artist_distance_miles: Math.round(Number(t.distance_km) / KM_PER_MILE),
      }));
    }

    res.json({
      query: q,
      resolved: {
        display_name: resolved.display_name,
        lat: resolved.lat,
        lng: resolved.lng,
      },
      radius_miles: radius,
      artist_count: artists.length,
      artists,
      track_count: tracks.length,
      total_tracks: totalTracks,
      tracks,
    });
  } catch (err) { next(err); }
});

// GET /api/discover/top-cities — top cities by artist count.
// Pre-deduped: rows are aggregated by lat/lng cluster (rounded to 2 dp,
// ~1.1km), so case-collisions like "moscow" + "Moscow" + "MOSCOW" merge.
//
// Phase 17.9: cap raised 30 -> 500. The catalog has 10k+ geocoded artists
// across many cities; capping at 30 made the catalog feel tiny and hid
// real coverage. The frontend renders all returned buckets; the page
// is a CSS-grid of city cards (no map library, no clustering needed).
// The grid aggregates every located artist; it only changes when the
// indexer or a backfill runs, so it is computed at most every 10 minutes.
const TOP_CITIES_TTL_MS = 10 * 60 * 1000;
let topCities = { at: 0, body: null };

router.get('/top-cities', async (_req, res, next) => {
  try {
    if (topCities.body && Date.now() - topCities.at < TOP_CITIES_TTL_MS) {
      return res.json(topCities.body);
    }
    // Step 1: aggregate by ~1km lat/lng bucket. MySQL strict mode requires
    // every selected column to be aggregated or in GROUP BY, so we keep
    // this query strictly aggregate-only.
    const buckets = await query(
      `SELECT
         ROUND(lat, 2) AS lat_bucket,
         ROUND(lng, 2) AS lng_bucket,
         AVG(lat) AS lat,
         AVG(lng) AS lng,
         COUNT(*) AS artist_count
       FROM artists
       WHERE lat IS NOT NULL AND city IS NOT NULL
       GROUP BY lat_bucket, lng_bucket
       ORDER BY artist_count DESC
       LIMIT 500`
    );

    // Step 2: bulk-fetch the per-bucket metadata in 4 queries instead of
    // 4 × N. The previous loop ran ~120 sub-queries at LIMIT 30; at
    // LIMIT 500 that would be ~2000 round-trips and a 50-100s page load.
    // We aggregate over the full artist set once per dimension and pick
    // the top entry per bucket in JS.
    const topKeys = new Set(buckets.map((b) => `${b.lat_bucket}_${b.lng_bucket}`));

    const cityRows = await query(
      `SELECT ROUND(lat, 2) AS lb, ROUND(lng, 2) AS gb, city, COUNT(*) AS n
         FROM artists
        WHERE lat IS NOT NULL AND city IS NOT NULL
        GROUP BY lb, gb, city`
    );
    const countryRows = await query(
      `SELECT ROUND(lat, 2) AS lb, ROUND(lng, 2) AS gb, country, COUNT(*) AS n
         FROM artists
        WHERE lat IS NOT NULL AND city IS NOT NULL AND country IS NOT NULL
        GROUP BY lb, gb, country`
    );
    const sourceRows = await query(
      `SELECT ROUND(lat, 2) AS lb, ROUND(lng, 2) AS gb, location_source, COUNT(*) AS n
         FROM artists
        WHERE lat IS NOT NULL AND city IS NOT NULL AND location_source IS NOT NULL
        GROUP BY lb, gb, location_source`
    );
    // Three sample names per bucket via window function, ordered by a hash of
    // the name with a seed that changes with each cache refresh (no RAND()).
    const sampleRows = await query(
      `SELECT lb, gb, name FROM (
         SELECT ROUND(lat, 2) AS lb, ROUND(lng, 2) AS gb, name,
                ROW_NUMBER() OVER (
                  PARTITION BY ROUND(lat, 2), ROUND(lng, 2) ORDER BY CRC32(CONCAT(name, ?))
                ) AS rn
           FROM artists
          WHERE lat IS NOT NULL AND city IS NOT NULL
       ) x
       WHERE rn <= 3`,
      [String(Date.now())]
    );

    // Reduce each per-bucket distribution to the single highest-count
    // entry. Tie-break by alphabetical for determinism (matches prior
    // behavior so the result for the long-stable buckets is unchanged).
    const pickTop = (rows, valueKey) => {
      const m = new Map();
      for (const r of rows) {
        const key = `${r.lb}_${r.gb}`;
        if (!topKeys.has(key)) continue;
        const v = r[valueKey];
        if (v == null) continue;
        const existing = m.get(key);
        const n = Number(r.n);
        if (!existing) {
          m.set(key, { value: v, n });
        } else if (n > existing.n || (n === existing.n && String(v) < String(existing.value))) {
          m.set(key, { value: v, n });
        }
      }
      return m;
    };
    const cityByBucket    = pickTop(cityRows, 'city');
    const countryByBucket = pickTop(countryRows, 'country');
    const sourceByBucket  = pickTop(sourceRows, 'location_source');

    const samplesByBucket = new Map();
    for (const r of sampleRows) {
      const key = `${r.lb}_${r.gb}`;
      if (!topKeys.has(key)) continue;
      const arr = samplesByBucket.get(key) || [];
      arr.push(r.name);
      samplesByBucket.set(key, arr);
    }

    const out = buckets.map((b) => {
      const key = `${b.lat_bucket}_${b.lng_bucket}`;
      return {
        city: cityByBucket.get(key)?.value || null,
        country: countryByBucket.get(key)?.value || null,
        location_source: sourceByBucket.get(key)?.value || null,
        lat: Number(b.lat),
        lng: Number(b.lng),
        artist_count: Number(b.artist_count),
        sample_artists: samplesByBucket.get(key) || [],
      };
    });
    topCities = { at: Date.now(), body: { cities: out } };
    res.json(topCities.body);
  } catch (err) { next(err); }
});

export default router;
