import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'node:fs';
import { pool, query } from '../db.js';
// Archive.org (general audio) was removed — its catalog skews to old radio,
// spoken word, and scraper junk that doesn't fit LumpyLP's indie/CC music
// focus. Phase 15 added Internet Archive *Netlabels* — a curated CC-only
// subset — which is fine.
import {
  fetchTracksPage as fetchCCMixter,
  CCMIXTER_QUERIES,
} from '../services/ccmixter.js';
import {
  fetchTracksPage as fetchJamendo,
  JAMENDO_QUERIES,
} from '../services/jamendo.js';
import {
  fetchTracksPage as fetchWikimedia,
  WIKIMEDIA_QUERIES,
} from '../services/wikimedia.js';
import {
  fetchTracksPage as fetchAudius,
  AUDIUS_QUERIES,
} from '../services/audius.js';
import {
  fetchTracksPage as fetchAudionautix,
  AUDIONAUTIX_QUERIES,
} from '../services/audionautix.js';
import {
  fetchTracksPage as fetchMusopen,
  MUSOPEN_QUERIES,
} from '../services/musopen.js';
import {
  fetchTracksPage as fetchArchiveNetlabels,
  ARCHIVE_NETLABELS_QUERIES,
} from '../services/archive_netlabels.js';
import {
  fetchTracksPage as fetchArchiveCylinders,
  ARCHIVE_CYLINDERS_QUERIES,
} from '../services/archive-cylinders.js';
import {
  fetchTracksPage as fetchLocJukebox,
  LOC_JUKEBOX_QUERIES,
} from '../services/loc_jukebox.js';
import {
  fetchTracksPage as fetchSoundcloud,
  SOUNDCLOUD_QUERIES,
} from '../services/soundcloud.js';
// Phase 17 sources:
import {
  fetchTracksPage as fetchArchiveLivemusic,
  ARCHIVE_LIVEMUSIC_QUERIES,
} from '../services/archive_livemusic.js';
import {
  fetchTracksPage as fetchIncompetech,
  INCOMPETECH_QUERIES,
} from '../services/incompetech.js';
import {
  fetchTracksPage as fetchEuropeana,
  EUROPEANA_QUERIES,
} from '../services/europeana.js';
import {
  fetchTracksPage as fetchSmithsonian,
  SMITHSONIAN_QUERIES,
} from '../services/smithsonian.js';
// Phase 17.6:
import {
  fetchTracksPage as fetchPhlow,
  PHLOW_QUERIES,
} from '../services/phlow.js';
import {
  fetchTracksPage as fetchArchiveSubjects,
  ARCHIVE_SUBJECTS_QUERIES,
} from '../services/archive_subjects.js';
import {
  fetchTracksPage as fetchArchivePd78s,
  ARCHIVE_PD78S_QUERIES,
} from '../services/archive_pd78s.js';
import {
  fetchTracksPage as fetchUcsbCylinders,
  UCSB_CYLINDERS_QUERIES,
} from '../services/ucsb_cylinders.js';
import { isJunkTrack } from './normalize.js';
import { passesQualityGate, logRejection } from './quality-gate.js';
import { normalizeGenre } from './genre-mapper.js';
import { loadEnv, assertIndexerUser } from '../lib/env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Env: see lib/env.js. On the server run with NODE_ENV=production so the
// indexer reads server/.env.production; locally it reads the dev .env.
loadEnv('indexer', { role: 'indexer' });

const DEFAULT_PAGE_DELAY_MS = 500;

// Genre substring matches that are always noise (audiobooks, podcasts, etc.)
// — hidden (never deleted) by cleanupNoise() regardless of source. Mostly historical at this point;
// the per-source allowlists prevent these terms from being assigned.
const GENRE_NOISE_TERMS = [
  'erotic', 'librivox', 'pokemon', 'televisiontunes', 'british_council',
  'podcast', 'politics', 'ustudent', 'kazeloon', 'children', 'audiobook',
];

// Source registry. earlyExitOnShortPage=true means: stop paginating a query
// when a returned page has < perPage/2 items. This lets ccMixter tag slices
// terminate naturally instead of pretending every slice has >=5 pages.
//
// Per-query overrides: a query object may carry its own pagesPerQuery
// to override the source-level value (used by the Audius walks, where
// trending queries are 1-page and walk queries are many-page).
const SOURCES = [
  { name: 'ccmixter',          fetch: fetchCCMixter,          queries: CCMIXTER_QUERIES,          pagesPerQuery: 50, pageDelayMs: 1000, earlyExitOnShortPage: true,  perPage: 100 },
  { name: 'jamendo',           fetch: fetchJamendo,           queries: JAMENDO_QUERIES,           pagesPerQuery: 5,  pageDelayMs: 800,  earlyExitOnShortPage: true, perPage: 200 },
  { name: 'wikimedia',         fetch: fetchWikimedia,         queries: WIKIMEDIA_QUERIES,         pagesPerQuery: 50, pageDelayMs: 800,  earlyExitOnShortPage: true, perPage: 50 },
  // Audius: most queries (trending/search) are 1-page since the API
  // doesn't paginate trending; the playlist-walk and user-walk queries
  // override pagesPerQuery to walk many pages internally.
  { name: 'audius',            fetch: fetchAudius,            queries: AUDIUS_QUERIES,            pagesPerQuery: 1,  pageDelayMs: 0   },
  // Phase 15A sources:
  { name: 'audionautix',       fetch: fetchAudionautix,       queries: AUDIONAUTIX_QUERIES,       pagesPerQuery: 1,   pageDelayMs: 2000 },
  // Musopen unauth is hard-capped at 10 records/page and uses cursor
  // pagination. earlyExit is off because cursor's last page is naturally
  // short. pagesPerQuery is a high ceiling — the walk terminates when
  // the cursor returns next=null.
  { name: 'musopen',           fetch: fetchMusopen,           queries: MUSOPEN_QUERIES,           pagesPerQuery: 1000, pageDelayMs: 800, earlyExitOnShortPage: false, perPage: 10 },
  // archive_netlabels: 78,111-item corpus per IA scrape numFound
  // (post-Phase-18 cursor fix). 78,111 / 100 per scrape batch = 782
  // pages min. Bumped from 200 (cap-era leftover, capped at ~10k
  // items) to 1,000 to drain the full netlabels collection. ~10.8h
  // wall clock at 500ms politeDelay.
  { name: 'archive_netlabels', fetch: fetchArchiveNetlabels,  queries: ARCHIVE_NETLABELS_QUERIES, pagesPerQuery: 1000, pageDelayMs: 500,  earlyExitOnShortPage: true, perPage: 50 },
  // Phase 15B sources:
  { name: 'loc_jukebox',       fetch: fetchLocJukebox,        queries: LOC_JUKEBOX_QUERIES,       pagesPerQuery: 100, pageDelayMs: 3000, earlyExitOnShortPage: true, perPage: 100 },
  { name: 'archive_cylinders', fetch: fetchArchiveCylinders,  queries: ARCHIVE_CYLINDERS_QUERIES, pagesPerQuery: 200, pageDelayMs: 500,  earlyExitOnShortPage: true, perPage: 50 },
  { name: 'soundcloud',        fetch: fetchSoundcloud,        queries: SOUNDCLOUD_QUERIES,        pagesPerQuery: 5,   pageDelayMs: 800,  earlyExitOnShortPage: true, perPage: 200 },
  // Phase 17 sources:
  // archive_livemusic: 289,459-item etree corpus. 289,459 / 100 =
  // 2,895 pages min. Bumped from 300 (cap-era leftover; got ~10k per
  // run before silently exiting at the deep-paging error) to 3,000
  // to drain full etree drift since the original pre-cap ingest.
  // Multi-day unattended run (~40h wall clock).
  { name: 'archive_livemusic', fetch: fetchArchiveLivemusic,  queries: ARCHIVE_LIVEMUSIC_QUERIES, pagesPerQuery: 3000, pageDelayMs: 500,  earlyExitOnShortPage: true, perPage: 50  },
  { name: 'incompetech',       fetch: fetchIncompetech,       queries: INCOMPETECH_QUERIES,       pagesPerQuery: 10,  pageDelayMs: 2000, earlyExitOnShortPage: true, perPage: 200 },
  { name: 'europeana',         fetch: fetchEuropeana,         queries: EUROPEANA_QUERIES,         pagesPerQuery: 50,  pageDelayMs: 800,  earlyExitOnShortPage: true, perPage: 100 },
  { name: 'smithsonian',       fetch: fetchSmithsonian,       queries: SMITHSONIAN_QUERIES,       pagesPerQuery: 20,  pageDelayMs: 1000, earlyExitOnShortPage: true, perPage: 100 },
  // Phase 17.6 — phlow.net curated CC netlabel catalog (1,018 releases).
  // Phlow doesn't host audio; each release dereferences to archive.org.
  // perPage=10 releases × ~7 IA tracks/release ≈ 70 tracks/page.
  // pagesPerQuery=120 covers all ~1,018 releases with headroom.
  { name: 'phlow',             fetch: fetchPhlow,             queries: PHLOW_QUERIES,             pagesPerQuery: 120, pageDelayMs: 0,    earlyExitOnShortPage: false, perPage: 10  },
  // Phase 17.6 second IA-meta source — archive.org subject-faceted CC/PD sweep.
  // 7 query slices (one per subject); per-slice spoken-word/SFX rejection
  // patterns set inside the resolver. perPage=50 matches archive-base's
  // SEARCH_PAGE_SIZE; pagesPerQuery=200 covers ~10k items per slice with
  // headroom (field-recording is the big one, ~83k CC items pre-filter).
  { name: 'archive_subjects',  fetch: fetchArchiveSubjects,   queries: ARCHIVE_SUBJECTS_QUERIES,  pagesPerQuery: 200, pageDelayMs: 500,  earlyExitOnShortPage: true,  perPage: 50  },
  // archive_pd78s — pre-1926 PD-by-age 78 RPM corpus (MMA / CLASSICS Act).
  // Single query against collection:78rpm + date filter; ~49k items.
  // The cutoff year is computed (pdCutoffYear in the resolver), so each
  // Jan 1 the next year's recordings are picked up without a code change.
  // Recon: internal research notes (not in this repo).
  // 49k items / 50 perPage = ~980 pages; 1200 pagesPerQuery has headroom
  // for the 2027 batch +3,153 etc.
  { name: 'archive_pd78s',     fetch: fetchArchivePd78s,      queries: ARCHIVE_PD78S_QUERIES,     pagesPerQuery: 1200, pageDelayMs: 500,  earlyExitOnShortPage: true, perPage: 50  },
  // ucsb_cylinders — UCSB Cylinder Audio Archive direct scrape. 10,000
  // sitemap URLs; pre-1923 filter keeps ~6,000-8,000 PD tracks. Audio on
  // S3 — no IA dependency. 2s polite-delay is baked into the resolver;
  // pageDelayMs=0 avoids double-sleeping. pagesPerQuery=500 covers all
  // 10,000 URLs at perPage=25 (400 pages) with headroom.
  // Recon: internal research notes (not in this repo)
  { name: 'ucsb_cylinders',   fetch: fetchUcsbCylinders,     queries: UCSB_CYLINDERS_QUERIES,    pagesPerQuery: 500,  pageDelayMs: 0,    earlyExitOnShortPage: true,  perPage: 25  },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Rules-based pre-filter — no AI, just obvious-garbage rejection.
const REJECT_TITLE_RE = /\b(sfx|loop|sample|test|ringtone|intro|clip|effect|ambient bed)\b/i;

function legacyShouldFilter(t) {
  if (typeof t.duration_seconds === 'number' && t.duration_seconds < 60) return 'too short (legacy <60s)';
  const title = (t.title || '').toString();
  if (!/\w/.test(title)) return 'title empty / whitespace / non-word';
  if (REJECT_TITLE_RE.test(title)) return 'title matches sfx/sample pattern';
  const junk = isJunkTrack(t);
  if (junk) return junk;
  return null;
}

async function ensureSchema() {
  const cols = await query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'tracks'
       AND COLUMN_NAME IN ('status', 'upvotes', 'downvotes')`
  );
  const have = new Set(cols.map((c) => c.COLUMN_NAME));
  if (!have.has('status')) {
    await query(`ALTER TABLE tracks ADD COLUMN status ENUM('fresh','approved','removed') DEFAULT 'fresh'`);
    console.log('[indexer:schema] added column status');
  }
  if (!have.has('upvotes')) {
    await query(`ALTER TABLE tracks ADD COLUMN upvotes INT DEFAULT 0`);
    console.log('[indexer:schema] added column upvotes');
  }
  if (!have.has('downvotes')) {
    await query(`ALTER TABLE tracks ADD COLUMN downvotes INT DEFAULT 0`);
    console.log('[indexer:schema] added column downvotes');
  }
}

export async function upsertTrack(t) {
  // Streaming only (relaunch item 2): resolvers still produce download_url,
  // but it is no longer stored or updated. The column stays, unused, so this
  // is reversible.
  //
  // hidden_reason (relaunch item 6): a resolver may ingest a row hidden (LoC,
  // Musopen European Archive). Set on INSERT only; ON DUPLICATE KEY never
  // touches the hide columns, so a re-ingest can't unhide a row or undo an
  // admin's takedown.
  await query(
    `INSERT INTO tracks
      (external_id, source, title, artist_name, genre, duration_seconds,
       stream_url, license, artwork_url, ai_curated, ai_confidence,
       country, region, hidden_at, hidden_reason)
     VALUES (?,?,?,?,?,?,?,?,?,NULL,NULL,?,?,IF(? IS NULL, NULL, NOW()),?)
     ON DUPLICATE KEY UPDATE
       title=VALUES(title),
       artist_name=VALUES(artist_name),
       genre=VALUES(genre),
       duration_seconds=VALUES(duration_seconds),
       stream_url=VALUES(stream_url),
       license=VALUES(license),
       artwork_url=VALUES(artwork_url),
       country=COALESCE(country, VALUES(country)),
       region=COALESCE(region, VALUES(region)),
       indexed_at=CURRENT_TIMESTAMP`,
    [
      t.external_id, t.source, t.title, t.artist_name, t.genre ?? null,
      t.duration_seconds ?? null, t.stream_url ?? null, t.license ?? null, t.artwork_url ?? null,
      t.country || null, t.region || null,
      t.hidden_reason || null, t.hidden_reason || null,
    ]
  );

  // Phase 17.8: capture artist location at ingest when the source carries
  // it on the track payload (e.g. audius user.location). COALESCE preserves
  // any existing values on duplicate-key — backfill scripts and prior
  // ingests stay authoritative; we only fill NULLs.
  await query(
    `INSERT INTO artists (name, source, country, city, location_raw, location_source)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       country         = COALESCE(country, VALUES(country)),
       city            = COALESCE(city, VALUES(city)),
       location_raw    = COALESCE(location_raw, VALUES(location_raw)),
       location_source = COALESCE(location_source, VALUES(location_source))`,
    [
      t.artist_name, t.source,
      t._artist_country || null,
      t._artist_city || null,
      t._artist_location_raw || null,
      t._artist_location_source || null,
    ]
  );

  if (t.genre) {
    await query(
      `INSERT INTO genres (name, track_count) VALUES (?, 1)
       ON DUPLICATE KEY UPDATE track_count = track_count + 1`,
      [t.genre]
    );
  }
}

// Normalize genre on the track in-place. Falls back to query.name as a hint
// (audionautix sets _genre_hint), or to the existing track.genre value.
function applyGenreNormalization(t, query) {
  const candidates = [t.genre, t._genre_hint, query?.name].filter(Boolean);
  for (const c of candidates) {
    const norm = normalizeGenre(c);
    if (norm) { t.genre = norm; delete t._genre_hint; return; }
  }
  t.genre = null;
  delete t._genre_hint;
}

async function indexSource(source, opts) {
  const { dryRun, dryRunStream } = opts;
  const stats = {
    fetched: 0,
    accepted: 0,
    rejectedLegacy: 0,
    rejectedGate: 0,
    upsertErrors: 0,
    queryErrors: 0,
    rejectionReasons: new Map(),  // reason -> count
    sampleAccepted: [],
    sampleRejected: [],            // [{title, reason}]
  };

  const delay = source.pageDelayMs ?? DEFAULT_PAGE_DELAY_MS;
  const allQueries = source.queries || [{ name: 'default' }];
  const queries = opts.maxQueries != null ? allQueries.slice(0, opts.maxQueries) : allQueries;
  const perPage = source.perPage ?? 100;

  for (const q of queries) {
    let queryAccepted = 0;
    // Per-query pagesPerQuery override (used by audius walks where
    // trending queries are 1-page but the walk queries are many-page).
    const queryPages = q.pagesPerQuery ?? source.pagesPerQuery;
    const pageCap = opts.maxPages != null
      ? Math.min(queryPages, opts.maxPages)
      : queryPages;
    // Phase 17 circuit breaker: if a query slice hits N consecutive
    // page failures, stop paging and move to the next query. Without
    // this LoC's 429 storms can chew through pagesPerQuery=100 worth
    // of timeouts before we move on.
    const FAILURE_LIMIT = 3;
    let consecutiveFailures = 0;
    for (let page = 1; page <= pageCap; page++) {
      let tracks;
      try {
        tracks = await source.fetch(q, page, perPage);
        consecutiveFailures = 0;
      } catch (err) {
        // Any source can throw a *_NOT_CONFIGURED tagged error to opt
        // out cleanly when its API key isn't set. The whole source is
        // skipped (not just the failing query) since the env-key
        // condition is global to the source.
        if (err && typeof err.code === 'string' && err.code.endsWith('_NOT_CONFIGURED')) {
          console.log(`[indexer:${source.name}] skipping — ${err.message}`);
          return stats;
        }
        stats.queryErrors++;
        consecutiveFailures++;
        console.error(`[indexer:${source.name}:${q.name}] page ${page} failed:`, err.message);
        if (consecutiveFailures >= FAILURE_LIMIT) {
          console.error(`[indexer:${source.name}:${q.name}] ${FAILURE_LIMIT} consecutive failures — skipping rest of slice`);
          break;
        }
        if (page < pageCap) await sleep(delay);
        continue;
      }

      if (!tracks || tracks.length === 0) break;
      stats.fetched += tracks.length;

      for (const t of tracks) {
        // 1. legacy junk filter (URL-in-title, sfx/sample names, etc.)
        const legacy = legacyShouldFilter(t);
        if (legacy) {
          recordRejection(stats, source.name, t, legacy);
          continue;
        }

        // 2. genre normalization (track is mutated in place; null is fine)
        applyGenreNormalization(t, q);

        // 3. quality gate (license normalization happens inside passesQualityGate)
        const gate = passesQualityGate(t);
        if (!gate.ok) {
          recordRejection(stats, source.name, t, gate.reason);
          continue;
        }

        // Accepted.
        if (stats.sampleAccepted.length < 5) {
          const geo = t.country || t.region ? ` ${t.country || '-'}/${t.region || '-'}` : '';
          stats.sampleAccepted.push(`${t.title} — ${t.artist_name} [${t.genre || '?'}, ${t.license}, ${t.duration_seconds ?? '?'}s${geo}]`);
        }

        if (dryRun) {
          if (dryRunStream) {
            dryRunStream.write(JSON.stringify({
              source: t.source, external_id: t.external_id, title: t.title,
              artist: t.artist_name, genre: t.genre, license: t.license,
              duration: t.duration_seconds,
              country: t.country || null, region: t.region || null,
              stream_url: t.stream_url,
            }) + '\n');
          }
          stats.accepted++;
          queryAccepted++;
          continue;
        }

        try {
          await upsertTrack(t);
          stats.accepted++;
          queryAccepted++;
        } catch (err) {
          stats.upsertErrors++;
          console.error(
            `[indexer:${source.name}:${q.name}] upsert failed`,
            t.external_id, err.message
          );
        }
      }

      const shortPage = tracks.length < Math.max(1, Math.floor(perPage / 2));
      if (source.earlyExitOnShortPage && shortPage) break;
      if (page < pageCap) await sleep(delay);
    }
    console.log(`[indexer:${source.name}:${q.name}] +${queryAccepted} accepted`);
  }

  return stats;
}

function recordRejection(stats, sourceName, t, reason) {
  if (reason && reason.startsWith('too short') || reason === 'title matches sfx/sample pattern' || reason === 'title has no alphanumerics' || reason === 'title contains URL' || reason === 'artist contains URL' || reason === 'title empty / whitespace / non-word') {
    stats.rejectedLegacy++;
  } else {
    stats.rejectedGate++;
  }
  const r = reason || 'unknown';
  stats.rejectionReasons.set(r, (stats.rejectionReasons.get(r) || 0) + 1);
  if (stats.sampleRejected.length < 5) {
    stats.sampleRejected.push({ title: String(t.title || '').slice(0, 80), reason: r });
  }
  logRejection({
    source: sourceName,
    external_id: t.external_id,
    reason: r,
    title: t.title,
  });
}

// Post-run cleanup. Catalog rows are never deleted (relaunch rule): noise
// genres are hidden with reason 'quality', and genre counts are rebuilt from
// live tracks without deleting genre rows (the indexer DB user has no DELETE).
export async function cleanupNoise() {
  console.log('[indexer:cleanup] hiding noise tracks…');

  for (const term of GENRE_NOISE_TERMS) {
    const r = await query(
      `UPDATE tracks SET hidden_at = NOW(), hidden_reason = 'quality', hidden_note = ?
       WHERE LOWER(genre) LIKE ? AND hidden_at IS NULL`,
      [`indexer cleanup: genre matches '${term}'`, `%${term}%`]
    );
    if (r.affectedRows) {
      console.log(`[indexer:cleanup] hid ${r.affectedRows} tracks matching '${term}'`);
    }
  }

  await query(`UPDATE genres SET track_count = 0`);
  const rebuilt = await query(
    `INSERT INTO genres (name, track_count)
     SELECT genre, COUNT(*) FROM tracks
     WHERE genre IS NOT NULL AND is_live = 1
     GROUP BY genre
     ON DUPLICATE KEY UPDATE track_count = VALUES(track_count)`
  );
  console.log(`[indexer:cleanup] rebuilt genre counts: ${rebuilt.affectedRows} rows touched`);
}

function summarize(name, s) {
  console.log(`\n=== [${name}] dry-run summary ===`);
  console.log(`  fetched:           ${s.fetched}`);
  console.log(`  accepted:          ${s.accepted}`);
  console.log(`  rejected (legacy): ${s.rejectedLegacy}`);
  console.log(`  rejected (gate):   ${s.rejectedGate}`);
  console.log(`  query errors:      ${s.queryErrors}`);
  console.log(`  upsert errors:     ${s.upsertErrors}`);
  if (s.sampleAccepted.length) {
    console.log(`  --- sample accepted (${s.sampleAccepted.length}) ---`);
    for (const t of s.sampleAccepted) console.log(`    + ${t}`);
  }
  if (s.sampleRejected.length) {
    console.log(`  --- sample rejected (${s.sampleRejected.length}) ---`);
    for (const r of s.sampleRejected) console.log(`    - ${r.title}  [${r.reason}]`);
  }
  if (s.rejectionReasons.size) {
    console.log(`  --- rejection reasons (top 10) ---`);
    const sorted = [...s.rejectionReasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    for (const [r, n] of sorted) console.log(`    ${n.toString().padStart(6)}  ${r}`);
  }
}

function parseArgs(argv) {
  const args = { dryRun: false, sources: null, maxPages: null, maxQueries: null, skipCleanup: false };
  for (const a of argv) {
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--skip-cleanup') args.skipCleanup = true;
    else if (a.startsWith('--source=')) {
      args.sources = a.slice('--source='.length).split(',').map((s) => s.trim()).filter(Boolean);
    }
    else if (a.startsWith('--max-pages=')) {
      const n = parseInt(a.slice('--max-pages='.length), 10);
      if (Number.isFinite(n) && n > 0) args.maxPages = n;
    }
    else if (a.startsWith('--max-queries=')) {
      const n = parseInt(a.slice('--max-queries='.length), 10);
      if (Number.isFinite(n) && n > 0) args.maxQueries = n;
    }
  }
  return args;
}

export async function runIndex(opts = {}) {
  const started = Date.now();
  if (!opts.dryRun) await ensureSchema();

  const allStats = new Map();
  const filteredSources = opts.sources
    ? SOURCES.filter((s) => opts.sources.includes(s.name))
    : SOURCES;
  if (opts.sources && filteredSources.length === 0) {
    console.error(`[indexer] no sources matched --source=${opts.sources.join(',')}. Available: ${SOURCES.map((s) => s.name).join(', ')}`);
    return { total: 0, errors: 0, filtered: 0 };
  }

  for (const source of filteredSources) {
    let dryRunStream = null;
    if (opts.dryRun) {
      const p = `/tmp/lumpylp-dryrun-${source.name}.log`;
      dryRunStream = fs.createWriteStream(p, { flags: 'w' });
      console.log(`[indexer:${source.name}] dry-run → ${p}`);
    }
    const stats = await indexSource(source, {
      dryRun: opts.dryRun,
      dryRunStream,
      maxPages: opts.maxPages,
      maxQueries: opts.maxQueries,
    });
    if (dryRunStream) dryRunStream.end();
    allStats.set(source.name, stats);
    if (opts.dryRun) {
      summarize(source.name, stats);
    } else {
      console.log(
        `[indexer:${source.name}] subtotal — ${stats.accepted} upserts, ${stats.rejectedLegacy + stats.rejectedGate} rejected, ${stats.upsertErrors + stats.queryErrors} errors`
      );
    }
  }

  // Phase 17 PART 6 protocol: don't run cleanupNoise() between per-source
  // ingestions. The Phase 15C race-condition fix is to call it exactly
  // once after all sources finish (orchestration handled by the live
  // wrapper). When `--skip-cleanup` is passed the indexer leaves the
  // genres table to be rebuilt later.
  if (!opts.dryRun && !opts.skipCleanup) await cleanupNoise();

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  let total = 0, errors = 0, rejected = 0;
  for (const s of allStats.values()) {
    total += s.accepted;
    errors += s.upsertErrors + s.queryErrors;
    rejected += s.rejectedLegacy + s.rejectedGate;
  }
  console.log(
    `\n[indexer] done — ${total} ${opts.dryRun ? 'would-insert' : 'upserts'}, ${rejected} rejected, ${errors} errors, ${elapsed}s`
  );
  return { total, errors, rejected };
}

const args = parseArgs(process.argv.slice(2));

// Scheduling lives outside the process (systemd timers on the server), so a
// crash or overlap can't go unnoticed. The old in-process scheduled mode
// started a multi-day sweep every 6 hours from inside Node; it was removed.
if (import.meta.url === `file://${process.argv[1]}`) {
  assertIndexerUser();
  runIndex({
    dryRun: args.dryRun,
    sources: args.sources,
    maxPages: args.maxPages,
    maxQueries: args.maxQueries,
    skipCleanup: args.skipCleanup,
  })
    .then(() => pool.end())
    .catch((e) => {
      console.error('[indexer] fatal', e);
      pool.end();
      process.exit(1);
    });
}
