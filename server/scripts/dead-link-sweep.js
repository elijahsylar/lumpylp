// Dead-link sweeper: the only process that marks tracks dead (relaunch item 5).
// HEAD-requests stream URLs, classifies them with lib/linkCheck.js (redirects
// followed, ccMixter checked with its Referer, 429/5xx/timeouts are "unknown",
// never dead) and records the verdict with recordCheck().
//
//   NODE_ENV=production node scripts/dead-link-sweep.js --mode=fresh|rescue|revive [--sources=a,b]
//
// Resumable: in fresh mode dead_checked_at IS NULL is the resume cursor.
// Per-source pause: 50 consecutive non-2xx responses from one source pause
// that source for 60 s. Run as the lumpylp_indexer DB user.

import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'node:fs';
import { loadEnv, assertIndexerUser } from '../lib/env.js';
import { checkUrl, recordCheck } from '../lib/linkCheck.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Env: see lib/env.js (NODE_ENV=production on the server).
loadEnv('sweep', { role: 'indexer' });
assertIndexerUser();

const { pool, query } = await import('../db.js');

// ── tunables ─────────────────────────────────────────────────────
const BATCH_SIZE                  = 500;        // rows per SELECT
const PARALLELISM                 = 32;         // concurrent HEADs (chunk 6: 8 -> 32)
const PER_SOURCE_PAUSE_THRESHOLD  = 50;         // consecutive non-2xx
const PER_SOURCE_PAUSE_MS         = 60_000;
// Phase 17.6 chunk 7: retry budget restored to 3 for the rescue pass.
// The chunk-4 cut (3 -> 1) traded accuracy for speed during the bulk
// sweep — every transient 5xx/429 became a give-up. v5 finished with
// 112,798 give-ups (38% of its checks). This rescue pass re-checks
// only those give-ups with the full retry budget so transient
// hiccups have a chance to settle.
const PROGRESS_LOG_EVERY          = 1000;       // tracks
const LOG_FILE = '/tmp/lumpylp-deadlink.log';

// Phase 17.6 chunk 4: source whitelist. Only sources in this list are
// pulled into the unchecked queue. Wikimedia and ccmixter are excluded
// because both showed heavy 429 storms in v1 + v2 — including them
// dragged global throughput down to 1.1/s. Their partial coverage from
// prior runs is preserved; a separate slow sweep can pick them up
// later if we care.
const INCLUDED_SOURCES = new Set([
  'audius',
  'jamendo',
  'archive_livemusic',
  'archive_netlabels',
  'archive_cylinders',
  'audionautix',
  'incompetech',
  'loc_jukebox',
]);

// Sweep mode (CLI --mode=, default fresh):
//   fresh  - tracks never checked (dead_checked_at IS NULL)
//   rescue - earlier give-ups (dead_status_code = -99)
//   revive - tracks currently marked dead; any that answer 2xx are revived.
//            Run this after migration 017 applies the old flags (owner decision 4).
// --sources=a,b overrides INCLUDED_SOURCES.
const ARGS = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const SWEEP_MODE = ARGS.mode || 'fresh';
// rescue and revive only take rows not yet checked in this run, otherwise a
// row that stays dead or unknown would be picked up again forever. The run
// start comes from the DB clock, the same clock recordCheck() writes with
// NOW(), so session time zones can't skew the comparison (review R5).
const [{ now: RUN_STARTED }] = await query(`SELECT DATE_FORMAT(NOW(), '%Y-%m-%d %H:%i:%s') AS now`);
const FILTERS = {
  fresh: 'dead_checked_at IS NULL',
  rescue: `dead_status_code = -99 AND dead_checked_at < '${RUN_STARTED}'`,
  revive: `is_dead = 1 AND (dead_checked_at IS NULL OR dead_checked_at < '${RUN_STARTED}')`,
};
if (!FILTERS[SWEEP_MODE]) { console.error(`unknown --mode=${SWEEP_MODE}`); process.exit(2); }
const FILTER_CLAUSE = FILTERS[SWEEP_MODE];
if (ARGS.sources) {
  INCLUDED_SOURCES.clear();
  for (const x of ARGS.sources.split(',')) INCLUDED_SOURCES.add(x.trim());
}

const STATUS_GAVE_UP = -99;

// ── state ────────────────────────────────────────────────────────
// Per-source state: throttle gate + consecutive-non-2xx counter +
// pausedUntil clock.
const sourceState = new Map();
function getSourceState(source) {
  let s = sourceState.get(source);
  if (!s) {
    s = { lastFetchAt: 0, consecutiveNonOk: 0, pausedUntil: 0 };
    sourceState.set(source, s);
  }
  return s;
}

// Phase 17.6 chunk 5: per-source serialization REMOVED. Earlier versions
// chained all calls for one source through a single promise so they ran
// sequentially with a 100ms gap. That cap looked sane in theory (=10
// req/s per source) but it confused "polite to one host" with "the
// host's actual throughput ceiling." Audius / archive.org CDNs handle
// many concurrent HEADs from one client just fine; the 100ms gate was
// a no-op anyway because real per-request latency (302 redirect →
// CDN → 200) is 500ms+, far exceeding the gap. Removing the chain
// lets the worker pool fire concurrent HEADs to the same source,
// raising per-source throughput from ~1/s to whatever the CDN allows.
//
// Per-source pausedUntil + consecutiveNonOk tracking is preserved as
// a backpressure circuit: 50 consecutive non-2xx triggers a 60s pause,
// which now applies as "sleep before this worker fires its next HEAD"
// rather than "block the source's serial chain." Workers landing on a
// paused source sleep concurrently and resume together — fine for our
// purposes.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── logging ──────────────────────────────────────────────────────
function logProgress(line) {
  const ts = new Date().toISOString();
  fs.appendFileSync(LOG_FILE, `${ts} ${line}\n`);
}

// ── per-track work ───────────────────────────────────────────────
//
// chunk 5: no source lock, no 100ms gate. Worker pool runs HEADs
// concurrently regardless of source. The pause circuit still holds:
// if a source gets pausedUntil set, every worker landing on a track
// from that source waits out the pause before firing.
async function processTrack(t) {
  const s = getSourceState(t.source);
  if (s.pausedUntil > Date.now()) {
    await sleep(s.pausedUntil - Date.now());
  }

  const result = await checkUrl(t.stream_url, { source: t.source });
  const is_dead = result.state === 'dead' ? 1 : 0;
  const code = result.state === 'unknown' ? STATUS_GAVE_UP : result.code;

  // Source-level pause logic. 2xx alive → reset; everything else
  // (including give-up) → bump consecutive counter. ++ on a shared
  // object property under concurrent workers is technically racy but
  // safe in practice: we lose at most O(parallelism) increments per
  // pause cycle, which doesn't change whether the threshold fires.
  const ok = is_dead === 0 && code !== STATUS_GAVE_UP;
  if (ok) {
    s.consecutiveNonOk = 0;
  } else {
    s.consecutiveNonOk++;
    if (s.consecutiveNonOk >= PER_SOURCE_PAUSE_THRESHOLD && s.pausedUntil <= Date.now()) {
      s.pausedUntil = Date.now() + PER_SOURCE_PAUSE_MS;
      logProgress(`[pause] source=${t.source} consecutive=${s.consecutiveNonOk} pausing for ${PER_SOURCE_PAUSE_MS}ms`);
      s.consecutiveNonOk = 0;
    }
  }

  await recordCheck(query, t.id, result);
  return { is_dead, code };
}

// ── batch loop ───────────────────────────────────────────────────
//
// Phase 17.6 chunk 3: worker-pool pattern, NOT chunk-of-N Promise.all.
// The previous version awaited each chunk's slowest member before
// starting the next — when wikimedia stalled for 60s on its rate-limit
// pause, the other 7 tracks in the chunk had finished in <1s but the
// next chunk wasn't allowed to start, so the global throughput
// collapsed to "1 chunk per 60s." Workers now pull from a shared queue
// independently: a wikimedia-stuck worker doesn't block the other 7,
// which keep chewing through audius/jamendo/etc.
async function processBatch(tracks) {
  const stats = { alive: 0, dead: 0, gave_up: 0 };
  let nextIdx = 0;
  const workers = Array.from({ length: PARALLELISM }, () => (async () => {
    while (true) {
      const i = nextIdx++;
      if (i >= tracks.length) return;
      const t = tracks[i];
      try {
        const r = await processTrack(t);
        if (r.is_dead === 1) stats.dead++;
        else if (r.code === STATUS_GAVE_UP) stats.gave_up++;
        else stats.alive++;
      } catch { /* swallow per-track errors; processTrack catches DB errors itself */ }
    }
  })());
  await Promise.all(workers);
  return stats;
}

async function run() {
  const startedAt = Date.now();
  let totalChecked = 0;
  let totalAlive = 0;
  let totalDead = 0;
  let totalGaveUp = 0;
  let lastReportAt = 0;

  logProgress(`[start] dead-link-sweep node=${process.version} pid=${process.pid} mode=${SWEEP_MODE}`);
  const initial = await query(`SELECT COUNT(*) AS n FROM tracks WHERE ${FILTER_CLAUSE}`);
  logProgress(`[start] candidates_initial=${initial[0].n}`);

  while (true) {
    // Phase 17.6 chunk 3: fair-share batch. Each iteration we ask which
    // sources still have unchecked rows, then take an equal slice from
    // each. Without this, ORDER BY id ASC LIMIT 500 would drain low-id
    // sources (audius/ccmixter/wikimedia) before higher-id ones
    // (archive_livemusic/incompetech) ever got a single check.
    const sources = await query(
      `SELECT source, COUNT(*) AS n
         FROM tracks
        WHERE ${FILTER_CLAUSE}
          AND stream_url IS NOT NULL
          AND stream_url <> ''
        GROUP BY source
        HAVING n > 0`
    );
    if (sources.length === 0) {
      logProgress(`[done] no more unchecked tracks`);
      break;
    }
    // Whitelist source names — they're written by indexer code so they
    // match /^[a-z_][a-z0-9_]*$/, but inlined into raw SQL below so
    // belt-and-suspenders a regex check. Then filter to the chunk-4
    // INCLUDED_SOURCES list (excludes wikimedia + ccmixter).
    const weighted = sources
      .filter((r) => /^[a-z_][a-z0-9_]*$/i.test(r.source))
      .filter((r) => INCLUDED_SOURCES.has(r.source))
      .map((r) => ({ source: r.source, n: Number(r.n) }));
    if (weighted.length === 0) {
      logProgress(`[done] no more unchecked tracks in INCLUDED_SOURCES`);
      break;
    }
    // Phase 17.6 chunk 6: weighted fair-share. Each source's slice is
    // proportional to its remaining-unchecked count, so audius (47% of
    // remaining work) gets ~half the workers and loc_jukebox (1%) gets
    // ~5 instead of an equal slice. Recomputed every batch — as
    // sources drain, survivors automatically pick up more share.
    const totalWeight = weighted.reduce((acc, w) => acc + w.n, 0);
    const subqueries = weighted.map(({ source, n }) => {
      const slice = Math.max(1, Math.round((BATCH_SIZE * n) / totalWeight));
      return `(SELECT id, source, stream_url FROM tracks
                WHERE ${FILTER_CLAUSE} AND source = '${source}'
                  AND stream_url IS NOT NULL AND stream_url <> ''
                ORDER BY id LIMIT ${slice})`;
    });
    const tracks = await query(subqueries.join(' UNION ALL '));
    if (tracks.length === 0) {
      logProgress(`[done] union returned 0 rows (sources may have raced empty)`);
      break;
    }
    const batchStats = await processBatch(tracks);
    totalChecked += tracks.length;
    totalAlive += batchStats.alive;
    totalDead += batchStats.dead;
    totalGaveUp += batchStats.gave_up;

    if (totalChecked - lastReportAt >= PROGRESS_LOG_EVERY) {
      const elapsedSec = (Date.now() - startedAt) / 1000;
      const rate = (totalChecked / Math.max(1, elapsedSec)).toFixed(1);
      logProgress(
        `[progress] checked=${totalChecked} alive=${totalAlive} dead=${totalDead} gave_up=${totalGaveUp} rate=${rate}/s`
      );
      lastReportAt = totalChecked;
    }
  }

  // Per-source final breakdown across all checked rows (including ones
  // checked by previous runs of this same script, which is fine — the
  // numbers reflect current DB state).
  const bySource = await query(
    `SELECT source,
            COUNT(*)                                                AS total,
            SUM(CASE WHEN is_dead = 1 THEN 1 ELSE 0 END)            AS dead,
            SUM(CASE WHEN is_dead = 0
                      AND dead_status_code BETWEEN 200 AND 299
                     THEN 1 ELSE 0 END)                              AS alive,
            SUM(CASE WHEN dead_status_code = ?
                     THEN 1 ELSE 0 END)                              AS gave_up
       FROM tracks
       WHERE dead_checked_at IS NOT NULL
       GROUP BY source
       ORDER BY source`,
    [STATUS_GAVE_UP]
  );

  const elapsedSec = (Date.now() - startedAt) / 1000;
  logProgress(
    `[final] checked=${totalChecked} alive=${totalAlive} dead=${totalDead} gave_up=${totalGaveUp} elapsed=${elapsedSec.toFixed(1)}s rate=${(totalChecked / Math.max(1, elapsedSec)).toFixed(1)}/s`
  );
  for (const row of bySource) {
    logProgress(
      `[final-source] ${row.source}: total=${row.total} alive=${row.alive} dead=${row.dead} gave_up=${row.gave_up}`
    );
  }

  await pool.end();
}

run().catch((e) => {
  logProgress(`[fatal] ${e.message}\n${e.stack}`);
  try { pool.end(); } catch { /* exiting anyway */ }
  process.exit(1);
});
