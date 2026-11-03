import { Router } from 'express';
import https from 'node:https';
import { query } from '../db.js';
import { optionalAuth } from '../middleware/auth.js';
import { TRACK_COLUMNS_SQL, serializeTrack, serializeTracks } from '../lib/trackShape.js';
import { parsePage, PAGE_TOO_DEEP, cappedCount } from '../lib/paging.js';

const router = Router();

// Community-moderation threshold. Tracks at net_lumps <= -DUMPED_THRESHOLD
// are "dumped" and hidden from heap/top views unless include_dumped=1.
const DUMPED_THRESHOLD = 5;

// Each order matches an index from migration 019 (ix_live_heap,
// ix_live_fresh, ix_live_title and their genre variants), all one direction,
// so MySQL reads the first page straight off the index without sorting.
const ORDER_BY = {
  heap:  't.net_score DESC, t.upvotes DESC, t.indexed_at DESC, t.id DESC',
  fresh: 't.indexed_at DESC, t.id DESC',
  alpha: 't.title ASC, t.id ASC',
};

router.get('/', optionalAuth, async (req, res, next) => {
  try {
    const page = parsePage(req.query.page);
    if (!page) return res.status(400).json(PAGE_TOO_DEEP);
    const perPage = 20;
    const offset = (page - 1) * perPage;
    const genre = req.query.genre;
    const artist = req.query.artist;
    const includeDumped = req.query.include_dumped === '1';

    // Default sort: heap when filtering by genre, fresh otherwise.
    const requestedSort = String(req.query.sort || '');
    const sort = ORDER_BY[requestedSort]
      ? requestedSort
      : (genre ? 'heap' : 'fresh');

    const where = ['t.is_live = 1']; // not dead (sweep) and not hidden
    const params = [];
    if (genre)  { where.push('t.genre = ?');       params.push(genre); }
    if (artist) { where.push('t.artist_name = ?'); params.push(artist); }
    if (sort === 'heap' && !includeDumped) {
      where.push(`t.net_score > ${-DUMPED_THRESHOLD}`);
    }
    const whereSql = `WHERE ${where.join(' AND ')}`;

    const userId = req.user?.id || 0;

    const rows = await query(
      `SELECT ${TRACK_COLUMNS_SQL},
              v.direction AS user_vote
       FROM tracks t
       LEFT JOIN votes v ON v.track_id = t.id AND v.user_id = ?
       ${whereSql}
       ORDER BY ${ORDER_BY[sort]}
       LIMIT ${perPage} OFFSET ${offset}`,
      [userId, ...params]
    );

    const { total, total_capped } = await cappedCount(query, `FROM tracks t ${whereSql}`, params);

    res.json({ page, perPage, total, total_capped, sort, tracks: serializeTracks(rows) });
  } catch (err) { next(err); }
});

// GET /api/tracks/top?window=today|week|month|all — top of the top.
// For windowed views we recompute net_lumps from the votes table within
// the window (tracks.upvotes/downvotes are all-time). All-time falls back
// to the precomputed columns for speed.
const WINDOW_INTERVALS = {
  today: '1 DAY',
  week:  '7 DAY',
  month: '30 DAY',
};

router.get('/top', optionalAuth, async (req, res, next) => {
  try {
    const page = parsePage(req.query.page);
    if (!page) return res.status(400).json(PAGE_TOO_DEEP);
    const perPage = 20;
    const offset = (page - 1) * perPage;
    const includeDumped = req.query.include_dumped === '1';
    const win = String(req.query.window || 'all');
    const userId = req.user?.id || 0;

    if (win === 'all' || !WINDOW_INTERVALS[win]) {
      // All-time — use the precomputed columns.
      const wheres = ['t.is_live = 1', 't.voted = 1'];
      if (!includeDumped) wheres.push(`t.net_score > ${-DUMPED_THRESHOLD}`);
      const whereSql = `WHERE ${wheres.join(' AND ')}`;

      const rows = await query(
        `SELECT ${TRACK_COLUMNS_SQL},
                t.net_score AS window_net,
                v.direction AS user_vote
         FROM tracks t
         LEFT JOIN votes v ON v.track_id = t.id AND v.user_id = ?
         ${whereSql}
         ORDER BY t.net_score DESC, t.upvotes DESC, t.indexed_at DESC, t.id DESC
         LIMIT ${perPage} OFFSET ${offset}`,
        [userId]
      );
      const { total, total_capped } = await cappedCount(query, `FROM tracks t ${whereSql}`);
      return res.json({ page, perPage, total, total_capped, window: 'all', tracks: serializeTracks(rows) });
    }

    // Windowed — join against an aggregate of recent votes.
    const interval = WINDOW_INTERVALS[win];
    const wheres = ['(wv.up + wv.down) > 0', 't.is_live = 1'];
    if (!includeDumped) wheres.push(`t.net_score > ${-DUMPED_THRESHOLD}`);
    const whereSql = `WHERE ${wheres.join(' AND ')}`;

    const rows = await query(
      `SELECT ${TRACK_COLUMNS_SQL},
              (wv.up - wv.down) AS window_net,
              v.direction AS user_vote
       FROM tracks t
       JOIN (
         SELECT track_id,
                SUM(CASE WHEN direction =  1 THEN 1 ELSE 0 END) AS up,
                SUM(CASE WHEN direction = -1 THEN 1 ELSE 0 END) AS down
         FROM votes
         WHERE updated_at >= NOW() - INTERVAL ${interval}
         GROUP BY track_id
       ) wv ON wv.track_id = t.id
       LEFT JOIN votes v ON v.track_id = t.id AND v.user_id = ?
       ${whereSql}
       ORDER BY (wv.up - wv.down) DESC, t.net_score DESC, t.id DESC
       LIMIT ${perPage} OFFSET ${offset}`,
      [userId]
    );
    const [{ total }] = await query(
      `SELECT COUNT(*) AS total
       FROM tracks t
       JOIN (
         SELECT track_id,
                SUM(CASE WHEN direction =  1 THEN 1 ELSE 0 END) AS up,
                SUM(CASE WHEN direction = -1 THEN 1 ELSE 0 END) AS down
         FROM votes
         WHERE updated_at >= NOW() - INTERVAL ${interval}
         GROUP BY track_id
       ) wv ON wv.track_id = t.id
       ${whereSql}`
    );
    res.json({ page, perPage, total, window: win, tracks: serializeTracks(rows) });
  } catch (err) { next(err); }
});

// /shuffle must be declared BEFORE /random and /:id. Express's first-match
// routing means 'shuffle' would otherwise be captured as an id by /:id (or
// shadowed by /random if order shifted). Phase 18.0: server-backed shuffle
// for filter-source views (genre, artist) where the loaded scroll subset is
// only a fraction of the full result set.
// Allowed values for the ?radius= param on location-source shuffle.
// Mirrors ALLOWED_RADII in routes/discover.js — kept in sync by hand
// since the two routes don't share a constant module.
const SHUFFLE_ALLOWED_RADII = new Set([25, 50, 100, 250]);
const SHUFFLE_KM_PER_MILE = 1.609344;
const SHUFFLE_EARTH_RADIUS_KM = 6371;

router.get('/shuffle', optionalAuth, async (req, res, next) => {
  try {
    const genre = req.query.genre;
    const artist = req.query.artist;
    const includeDumped = req.query.include_dumped === '1';

    // Location filter — lat/lng/radius. All three must be present and valid
    // together, or all three absent. Partial = 400. When present we JOIN
    // artists on (name, source) and add a Haversine WHERE clause.
    const latRaw = req.query.lat;
    const lngRaw = req.query.lng;
    const radiusRaw = req.query.radius;
    const anyLocParam = latRaw != null || lngRaw != null || radiusRaw != null;
    let locFilter = null;
    if (anyLocParam) {
      const lat = Number(latRaw);
      const lng = Number(lngRaw);
      const radius = parseInt(radiusRaw, 10);
      if (
        !Number.isFinite(lat) || lat < -90  || lat > 90  ||
        !Number.isFinite(lng) || lng < -180 || lng > 180 ||
        !SHUFFLE_ALLOWED_RADII.has(radius)
      ) {
        return res.status(400).json({
          error: 'lat must be -90..90, lng -180..180, radius in {25,50,100,250}',
        });
      }
      locFilter = { lat, lng, radiusKm: radius * SHUFFLE_KM_PER_MILE };
    }

    // n: clamp 1..100, default 50.
    let n = parseInt(req.query.n, 10);
    if (!Number.isFinite(n) || n < 1) n = 50;
    n = Math.min(100, n);

    // exclude: comma-separated ids. Split, validate each as a positive int,
    // cap at first 200, bind as individual placeholders. Never string-splice
    // into the SQL — the cap limits damage but doesn't prevent injection.
    const excludeIds = String(req.query.exclude || '')
      .split(',')
      .map((s) => parseInt(s, 10))
      .filter((id) => Number.isInteger(id) && id > 0)
      .slice(0, 200);

    const userId = req.user?.id || 0;
    const exclude = new Set(excludeIds);
    let picked;
    if (!genre && !artist && !locFilter) {
      picked = await randomLiveIds(n, exclude, includeDumped);
    } else {
      // Filtered shuffle: read the candidate ids straight off an index
      // (genre, artist or the artists near a point), then sample in Node.
      const where = ['t.is_live = 1'];
      const params = [];
      if (genre)  { where.push('t.genre = ?');       params.push(genre); }
      if (artist) { where.push('t.artist_name = ?'); params.push(artist); }
      if (!includeDumped) where.push(`t.net_score > ${-DUMPED_THRESHOLD}`);
      let locJoinSql = '';
      if (locFilter) {
        // Bounding box first (uses idx_artists_location), exact distance after.
        const dLat = locFilter.radiusKm / 111.045;
        const dLng = Math.min(180, locFilter.radiusKm / (111.045 * Math.max(0.01, Math.cos((locFilter.lat * Math.PI) / 180))));
        locJoinSql = 'JOIN artists a ON a.name = t.artist_name AND a.source = t.source';
        where.push('a.lat BETWEEN ? AND ? AND a.lng BETWEEN ? AND ?');
        params.push(locFilter.lat - dLat, locFilter.lat + dLat, locFilter.lng - dLng, locFilter.lng + dLng);
        where.push(`(
          ${SHUFFLE_EARTH_RADIUS_KM} * ACOS(LEAST(1.0,
            COS(RADIANS(?)) * COS(RADIANS(a.lat)) *
            COS(RADIANS(a.lng) - RADIANS(?)) +
            SIN(RADIANS(?)) * SIN(RADIANS(a.lat))
          ))
        ) <= ?`);
        params.push(locFilter.lat, locFilter.lng, locFilter.lat, locFilter.radiusKm);
      }
      const cand = await query(
        `SELECT t.id FROM tracks t ${locJoinSql} WHERE ${where.join(' AND ')} LIMIT ${SHUFFLE_CANDIDATE_CAP}`,
        params
      );
      picked = sample(cand.map((r) => r.id).filter((id) => !exclude.has(id)), n);
    }
    const rows = await fetchTracksById(picked, userId);
    res.json({ tracks: serializeTracks(rows) });
  } catch (err) { next(err); }
});

// /random must be declared BEFORE /:id so Express doesn't route 'random' as an id.
router.get('/random', async (_req, res, next) => {
  try {
    const [id] = await randomLiveIds(1, new Set(), false);
    const rows = await fetchTracksById(id ? [id] : [], 0);
    if (!rows.length) return res.status(404).json({ error: 'no tracks' });
    res.json(serializeTrack(rows[0]));
  } catch (err) { next(err); }
});

// ── random selection without sorting by RAND() ─────────────────────────
// Sorting the table by RAND() scans and sorts every row on every call (1.2 s at
// 650k rows). Instead: draw random ids between MIN(id) and MAX(id) and keep
// those that are live (primary-key lookups), topping up a few rounds; ids
// have gaps, so draw several per wanted track.
const SHUFFLE_CANDIDATE_CAP = 100_000;
let idRange = { at: 0, min: 0, max: 0 };

async function liveIdRange() {
  if (Date.now() - idRange.at < 60_000 && idRange.max) return idRange;
  const [r] = await query(`SELECT MIN(id) AS min, MAX(id) AS max FROM tracks`);
  idRange = { at: Date.now(), min: Number(r.min) || 0, max: Number(r.max) || 0 };
  return idRange;
}

async function randomLiveIds(n, exclude, includeDumped) {
  const { min, max } = await liveIdRange();
  if (!max) return [];
  const got = new Set();
  const dumped = includeDumped ? '' : ` AND net_score > ${-DUMPED_THRESHOLD}`;
  for (let round = 0; round < 6 && got.size < n; round++) {
    const want = (n - got.size) * 4 + 8;
    const draw = new Set();
    while (draw.size < want && draw.size < max - min + 1) draw.add(min + Math.floor(Math.random() * (max - min + 1)));
    const rows = await query(
      `SELECT id FROM tracks WHERE id IN (${[...draw].map(() => '?').join(',')}) AND is_live = 1${dumped}`,
      [...draw]
    );
    for (const r of rows) {
      if (got.size >= n) break;
      if (!exclude.has(r.id)) got.add(r.id);
    }
  }
  if (got.size < n) {
    // Sparse or tiny catalog: walk forward from a random point, then wrap.
    const start = min + Math.floor(Math.random() * (max - min + 1));
    for (const [cmp, s] of [['>=', start], ['>=', min]]) {
      const rows = await query(
        `SELECT id FROM tracks WHERE id ${cmp} ? AND is_live = 1${dumped} ORDER BY id LIMIT ${n * 2 + exclude.size}`,
        [s]
      );
      for (const r of rows) {
        if (got.size >= n) break;
        if (!exclude.has(r.id)) got.add(r.id);
      }
      if (got.size >= n) break;
    }
  }
  return sample([...got], n);
}

// Fisher-Yates partial shuffle: n random items from arr, in random order.
function sample(arr, n) {
  const a = arr.slice();
  const k = Math.min(n, a.length);
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(Math.random() * (a.length - i));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, k);
}

// Full rows for ids, in the order given.
async function fetchTracksById(ids, userId) {
  if (!ids.length) return [];
  const rows = await query(
    `SELECT ${TRACK_COLUMNS_SQL}, v.direction AS user_vote
     FROM tracks t
     LEFT JOIN votes v ON v.track_id = t.id AND v.user_id = ?
     WHERE t.id IN (${ids.map(() => '?').join(',')})`,
    [userId, ...ids]
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

router.get('/:id', async (req, res, next) => {
  try {
    const rows = await query(`SELECT ${TRACK_COLUMNS_SQL} FROM tracks t WHERE t.id = ? AND t.is_live = 1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(serializeTrack(rows[0]));
  } catch (err) { next(err); }
});

export default router;

// Audio proxy router — mounted at /api/stream in index.js.
// ccMixter requires `Referer: https://ccmixter.org/` (anti-leech), so we
// fetch server-side and pipe to the client. Other sources just 302-redirect.
export const streamRouter = Router();

const PROXY_TIMEOUT_MS = 10_000;

// The only upstream the proxy may fetch: https://ccmixter.org/... Older rows
// store http:// URLs, which are upgraded. Anything else (another host, a
// look-alike domain, another scheme) is refused, so a tampered stream_url can
// never turn the proxy into a fetcher for arbitrary URLs.
export function ccmixterProxyTarget(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.hostname !== 'ccmixter.org') return null;
  u.protocol = 'https:';
  u.port = '';
  return u;
}

streamRouter.get('/:trackId', async (req, res, next) => {
  try {
    const rows = await query(
      `SELECT id, source, external_id, stream_url, is_live
       FROM tracks WHERE id = ?`,
      [req.params.trackId]
    );
    if (!rows.length) return res.status(404).json({ error: 'not found' });

    const { source, stream_url } = rows[0];
    const trackId = rows[0].id;

    // Dead (per the sweep) or hidden tracks are gone: 410, never fetched.
    // This route never writes to the database; only the dead-link sweep
    // judges whether a track is dead (relaunch item 5).
    if (!rows[0].is_live) {
      return res.status(410).json({ error: 'track is no longer available' });
    }

    if (!stream_url) return res.status(404).json({ error: 'no stream' });

    // Audius — multi-node failover. We server-side resolve the CDN URL by
    // rotating through healthy discovery nodes, then redirect the browser
    // directly to the CDN. Avoids storing or sending node-specific URLs to
    // the browser. Stored stream_url is ignored at runtime — we use
    // external_id + a fresh node selection per request.
    if (source === 'audius') {
      const externalId = rows[0].external_id;
      try {
        const { resolveStreamCdnUrl } = await import('../services/audius.js');
        const result = await resolveStreamCdnUrl(externalId);
        if (result.cdnUrl) {
          return res.redirect(302, result.cdnUrl);
        }
        if (result.notFound) {
          // Gone upstream. Not marked dead here: only the sweep does that.
          return res.status(404).json({ error: 'track not found upstream' });
        }
        // 5xx / timeout — temp fail, may recover.
        console.warn('[stream] audius unavailable', trackId, result.error || 'unknown');
        return res.status(503).json({ error: 'upstream unavailable' });
      } catch (err) {
        console.warn('[stream] audius unreachable', trackId, err.message);
        return res.status(503).json({ error: 'upstream unavailable' });
      }
    }

    if (source !== 'ccmixter') {
      // Jamendo / Wikimedia: 302 redirect; we can't observe success from
      // here (browser fetches the CDN directly); the sweep checks these.
      return res.redirect(302, stream_url);
    }

    const target = ccmixterProxyTarget(stream_url);
    if (!target) return res.status(404).json({ error: 'no stream' });

    const upstreamReq = https.get(
      target,
      {
        headers: {
          // ccMixter's anti-leech check wants its own site as the Referer.
          Referer: 'https://ccmixter.org/',
          'User-Agent': 'Mozilla/5.0',
          ...(req.headers.range ? { Range: req.headers.range } : {}),
        },
        // TLS is verified (Node's default); ccMixter's chain validates as of 2026-10.
        timeout: PROXY_TIMEOUT_MS,
      },
      (upstream) => {
        const code = upstream.statusCode || 0;
        if (code === 404 || code === 410) {
          upstream.resume();
          if (!res.headersSent) res.status(404).json({ error: 'track not found upstream' });
          return;
        }
        if (code >= 500 || code === 0) {
          upstream.resume();
          if (!res.headersSent) res.status(502).json({ error: 'upstream unavailable' });
          return;
        }
        if (code >= 400) {
          upstream.resume();
          if (!res.headersSent) res.status(502).json({ error: 'upstream unavailable' });
          return;
        }

        res.status(code);
        for (const h of ['content-type', 'content-length', 'accept-ranges', 'content-range']) {
          if (upstream.headers[h]) res.setHeader(h, upstream.headers[h]);
        }
        upstream.pipe(res);
      }
    );

    upstreamReq.on('timeout', () => upstreamReq.destroy(new Error('upstream timeout')));
    upstreamReq.on('error', (err) => {
      console.error('[stream] upstream error', err.message);
      if (!res.headersSent) res.status(502).json({ error: 'upstream error' });
      else res.destroy();
    });

    req.on('close', () => upstreamReq.destroy());
  } catch (err) { next(err); }
});
