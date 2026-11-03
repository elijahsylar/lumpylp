// Express application factory. Routes and middleware only; no listen() and
// no env loading, so tests can build the app against a local test database.
// server/index.js loads the env and starts the HTTP server.
import express from 'express';
import cors from 'cors';

export async function createApp() {
  const { query } = await import('./db.js');
  const { default: tracksRouter, streamRouter } = await import('./routes/tracks.js');
  const { default: genresRouter } = await import('./routes/genres.js');
  const { default: artistsRouter } = await import('./routes/artists.js');
  const { default: authRouter } = await import('./routes/auth.js');
  const { default: votesRouter } = await import('./routes/votes.js');
  const { default: lumpsRouter } = await import('./routes/lumps.js');
  const { default: adminRouter } = await import('./routes/admin.js');
  const { default: discoverRouter } = await import('./routes/discover.js');
  const { optionalAuth } = await import('./middleware/auth.js');
  const { SOURCE_FILTERS, resolveSourceFilter } = await import('./lib/sources.js');
  const { limiters } = await import('./lib/rateLimits.js');
  const lim = limiters();
  const { TRACK_COLUMNS_SQL, serializeTracks } = await import('./lib/trackShape.js');
  const { parsePage, PAGE_TOO_DEEP, cappedCount } = await import('./lib/paging.js');

  const app = express();
  // Client IPs (for rate limits) come from X-Forwarded-For only when the
  // request arrives from a trusted proxy: by default the local nginx.
  app.set('trust proxy', process.env.TRUST_PROXY || 'loopback');

  // The SPA is served same-origin, so no cross-origin access is needed.
  // Only the configured public origin may read API responses cross-origin.
  app.use(cors({ origin: process.env.PUBLIC_URL ? [process.env.PUBLIC_URL] : false }));

  app.use(express.json());

  // Review R9: if nginx doesn't forward client IPs, every request looks like
  // 127.0.0.1 and the IP-keyed rate limits become site-wide. Warn once in
  // production when the first 50 API requests carried no X-Forwarded-For.
  if (process.env.NODE_ENV === 'production') {
    let seen = 0, forwarded = 0, warned = false;
    app.use('/api', (req, _res, next) => {
      if (!warned && seen < 50) {
        seen += 1;
        if (req.headers['x-forwarded-for']) forwarded += 1;
        if (seen === 50 && forwarded === 0) {
          warned = true;
          console.warn('[api] WARNING: 50 requests and none had X-Forwarded-For; rate limits are keyed on the proxy address. ' +
            'Check that nginx sets X-Forwarded-For from CF-Connecting-IP.');
        }
      }
      next();
    });
  }
  app.use('/api', lim.api);

  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  // Public client config. support_url is for voluntary support (a payment
  // link that unlocks nothing; no code checks payment status anywhere).
  // Only an https URL is passed through.
  app.get('/api/config', (_req, res) => {
    let support = null;
    try {
      const u = new URL(process.env.SUPPORT_URL || '');
      if (u.protocol === 'https:') support = u.toString();
    } catch { /* unset or invalid */ }
    res.json({ support_url: support, turnstile_site_key: process.env.TURNSTILE_SITE_KEY || null });
  });

  app.use('/api/auth', authRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api/lumps', lumpsRouter);
  app.use('/api/tracks', tracksRouter);
  app.use('/api/tracks', votesRouter); // POST /:id/vote, GET /:id/votes
  app.use('/api/stream', lim.stream, streamRouter);
  app.use('/api/genres', genresRouter);
  app.use('/api/artists', artistsRouter);
  app.use('/api/discover', lim.discover, discoverRouter);

  const SEARCH_PER_PAGE = 20;
  const SEARCH_MAX_PAGE = 50;
  const SEARCH_MAX_RESULTS = SEARCH_PER_PAGE * SEARCH_MAX_PAGE;
  const PREFIX_CANDIDATES = 2000;
  // InnoDB's default FULLTEXT stopword list: such words never match in
  // boolean mode, so they are left out of the required terms.
  const FT_STOPWORDS = new Set(('a about an are as at be by com de en for from how i in is it la of on or that '
    + 'the this to was what when where who will with und www').split(' '));

  // The filter options the Search page renders as tabs. Served from the
  // canonical registry in lib/sources.js so the client never hardcodes a
  // source list that can drift from what the indexer actually writes.
  app.get('/api/sources', (_req, res) => {
    res.json({
      sources: SOURCE_FILTERS.map(({ value, label }) => ({ value, label })),
    });
  });

  // Catalog-wide totals. This is the single source of truth for every
  // "N tracks" string in the UI (search placeholder, About page, Home hero)
  // — those used to be three separate hardcoded numbers that drifted.
  //
  // COUNT(*) on tracks is a full InnoDB scan (~1s at 200k rows, worse in
  // prod), so the result is cached in-process. The number is a headline
  // figure, not an accounting record; a minute of staleness is fine.
  const STATS_TTL_MS = 60_000;
  let statsCache = { at: 0, data: null };

  app.get('/api/stats', async (_req, res, next) => {
    try {
      if (statsCache.data && Date.now() - statsCache.at < STATS_TTL_MS) {
        return res.json(statsCache.data);
      }
      // Live tracks only (not dead, not hidden); uses ix_live_fresh.
    const [{ tracks }] = await query('SELECT COUNT(*) AS tracks FROM tracks WHERE is_live = 1');
      const data = { tracks: Number(tracks) || 0 };
      statsCache = { at: Date.now(), data };
      res.json(data);
    } catch (err) { next(err); }
  });

  // Search (relaunch item 8). Words of 3+ characters that aren't stopwords
  // use the FULLTEXT index in boolean mode, every word required, each as a
  // prefix (+river* +ston*). A query with no such word (e.g. "ab", "the")
  // falls back to a prefix match on title or artist, which can use their
  // B-tree indexes. There is no leading-% LIKE: the old OR LIKE '%q%' turned
  // every search into a full scan (1.0-1.5 s at 650k rows).
  app.get('/api/search', lim.search, optionalAuth, async (req, res, next) => {
    try {
      const q = String(req.query.q || '').trim().slice(0, 200);
      if (!q) {
        return res.json({ page: 1, perPage: SEARCH_PER_PAGE, total: 0, total_capped: false, tracks: [] });
      }

      const page = parsePage(req.query.page, SEARCH_MAX_PAGE);
      if (!page) return res.status(400).json(PAGE_TOO_DEEP);
      const offset = (page - 1) * SEARCH_PER_PAGE;
      const sourceFilter = String(req.query.source || '');
      const genreFilter = String(req.query.genre || '');
      const sort = String(req.query.sort || 'relevance');

      const words = q.toLowerCase().split(/\s+/)
        .map((w) => w.replace(/[^\p{L}\p{N}]+/gu, ''))
        .filter(Boolean);
      const ftWords = words.filter((w) => w.length >= 3 && !FT_STOPWORDS.has(w));
      const wheres = ['t.is_live = 1']; // not dead (sweep) and not hidden
      const whereParams = [];
      let fromSql = 'FROM tracks t';
      const fromParams = [];
      let matchExpr = null;
      let matchParam = null;
      if (ftWords.length) {
        matchExpr = 'MATCH(t.title, t.artist_name) AGAINST(? IN BOOLEAN MODE)';
        matchParam = ftWords.slice(0, 8).map((w) => `+${w}*`).join(' ');
        wheres.push(matchExpr);
        whereParams.push(matchParam);
      } else {
        // Prefix on title OR artist, as a union of two index range scans
        // (ix_live_title, ix_live_artist). A plain OR made MySQL walk the
        // whole title index (2 s at 650k rows). Up to PREFIX_CANDIDATES
        // matches per side; short queries are for quick lookups.
        const prefix = q.replace(/[\\%_]/g, (c) => `\\${c}`) + '%';
        fromSql = `FROM tracks t JOIN (
            (SELECT id FROM tracks WHERE is_live = 1 AND title LIKE ? LIMIT ${PREFIX_CANDIDATES})
            UNION
            (SELECT id FROM tracks WHERE is_live = 1 AND artist_name LIKE ? LIMIT ${PREFIX_CANDIDATES})
          ) pm ON pm.id = t.id`;
        fromParams.push(prefix, prefix);
      }

      // Unknown values resolve to null and are ignored (show everything)
      // rather than producing a WHERE that matches nothing.
      const srcFilter = resolveSourceFilter(sourceFilter);
      if (srcFilter) {
        wheres.push(srcFilter.sql);
        whereParams.push(...srcFilter.params);
      }
      if (genreFilter) {
        wheres.push('t.genre = ?');
        whereParams.push(genreFilter);
      }
      const whereSql = `WHERE ${wheres.join(' AND ')}`;

      const orderByMap = {
        relevance:     matchExpr ? `${matchExpr} DESC, t.id DESC` : 't.title ASC, t.id ASC',
        title_asc:     't.title ASC, t.id ASC',
        title_desc:    't.title DESC, t.id DESC',
        duration_asc:  't.duration_seconds ASC, t.id ASC',
        duration_desc: 't.duration_seconds DESC, t.id DESC',
      };
      const orderBy = orderByMap[sort] || orderByMap.relevance;
      const orderParams = orderBy.includes('AGAINST') ? [matchParam] : [];

      const userId = req.user?.id || 0;

      let rows;
      if (matchExpr && orderBy.includes('AGAINST')) {
        // Relevance: rank on the FULLTEXT index alone (MySQL's fast top-N
        // path), then apply the live/source/genre filters to that short list.
        // Widen the list only if filters left the page short.
        const need = offset + SEARCH_PER_PAGE;
        const restWheres = wheres.filter((w) => w !== matchExpr);
        const restParams = whereParams.slice(1);
        let ftTotal = null; // FULLTEXT matches before filters, counted only if needed
        for (let k = need * 2 + 100; ; k *= 4) {
          rows = await query(
            `SELECT ${TRACK_COLUMNS_SQL},
                    v.direction AS user_vote
             FROM (SELECT id, MATCH(title, artist_name) AGAINST(? IN BOOLEAN MODE) AS score
                     FROM tracks
                    WHERE MATCH(title, artist_name) AGAINST(? IN BOOLEAN MODE)
                    ORDER BY score DESC
                    LIMIT ${k}) m
             JOIN tracks t ON t.id = m.id
             LEFT JOIN votes v ON v.track_id = t.id AND v.user_id = ?
             WHERE ${restWheres.join(' AND ')}
             ORDER BY m.score DESC, t.id DESC
             LIMIT ${SEARCH_PER_PAGE} OFFSET ${offset}`,
            [matchParam, matchParam, userId, ...restParams]
          );
          if (rows.length === SEARCH_PER_PAGE || k >= SEARCH_MAX_RESULTS * 20) break;
          // Stop widening once k covers every match there is (review R17).
          if (ftTotal === null) {
            const [{ n }] = await query(
              `SELECT COUNT(*) AS n FROM tracks WHERE MATCH(title, artist_name) AGAINST(? IN BOOLEAN MODE)`, [matchParam]);
            ftTotal = Number(n);
          }
          if (k >= ftTotal) break;
        }
      } else {
        rows = await query(
          `SELECT ${TRACK_COLUMNS_SQL},
                  v.direction AS user_vote
           ${fromSql}
           LEFT JOIN votes v ON v.track_id = t.id AND v.user_id = ?
           ${whereSql}
           ORDER BY ${orderBy}
           LIMIT ${SEARCH_PER_PAGE} OFFSET ${offset}`,
          [...fromParams, userId, ...whereParams, ...orderParams]
        );
      }

      // Search totals stop at SEARCH_MAX_RESULTS (the 50 pages one can reach).
      const { total, total_capped } = await cappedCount(query, `${fromSql} ${whereSql}`,
        [...fromParams, ...whereParams], SEARCH_MAX_RESULTS);

      res.json({ page, perPage: SEARCH_PER_PAGE, total, total_capped, tracks: serializeTracks(rows) });
    } catch (err) { next(err); }
  });

  // Errors reaching here are unhandled — they carry internal detail (SQL
  // text, table names, file paths) that must not go to the client. Log the
  // real thing, return a fixed string. Routes that want to tell the user
  // something specific respond directly with their own res.status().json().
  app.use((err, req, res, _next) => {
    console.error(`[api] ${req.method} ${req.originalUrl} —`, err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
