// Pass-2 backfill: resolve lat/lng for artists that have city/country
// populated but no geocoded coordinates yet. Uses Nominatim via the
// shared geocode utility (cache-first, polite rate limit).
//
// Always sets location_geocoded_at = NOW() — even on miss — so we don't
// re-try the same query forever. lat/lng remain NULL on miss.
//
// Idempotent. Resumable. Safe to kill mid-run.
//
// Usage:
//   node server/scripts/backfill-geocode-artists.js [--dry-run] [--limit N]

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const { query } = await import('../db.js');
const { geocode } = await import('../lib/geocode.js');

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has('--dry-run');
const LIMIT_ARG = process.argv.find((a) => a.startsWith('--limit'));
const LIMIT = LIMIT_ARG ? parseInt(LIMIT_ARG.split('=')[1] || process.argv[process.argv.indexOf(LIMIT_ARG) + 1] || '0', 10) : 0;

function buildQuery(row) {
  const city = (row.city || '').trim();
  const country = (row.country || '').trim();
  if (city && country) return `${city}, ${country}`;
  if (city) return city;
  if (country) return country;
  return null;
}

async function cacheStateBefore() {
  const r = await query('SELECT COUNT(*) AS n FROM geocode_cache');
  return r[0]?.n || 0;
}

function fmtTime(ms) {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

async function main() {
  const sql = `
    SELECT id, name, city, country FROM artists
    WHERE (city IS NOT NULL OR country IS NOT NULL)
      AND lat IS NULL
      AND location_geocoded_at IS NULL
    ORDER BY id
    ${LIMIT > 0 ? `LIMIT ${LIMIT}` : ''}
  `;
  const rows = await query(sql);
  console.log(`[geocode backfill] mode=${DRY_RUN ? 'DRY-RUN' : 'WRITE'}  candidates=${rows.length}${LIMIT > 0 ? ` (--limit ${LIMIT})` : ''}\n`);

  const cacheBefore = await cacheStateBefore();
  const startedAt = Date.now();

  const stats = {
    processed: 0,
    geocoded: 0,
    misses: 0,
    skippedEmptyQuery: 0,
    missSamples: [],
  };

  for (const row of rows) {
    stats.processed++;
    const q = buildQuery(row);
    if (!q) {
      stats.skippedEmptyQuery++;
      continue;
    }

    let result = null;
    if (!DRY_RUN) {
      result = await geocode(q);
    } else {
      // In dry-run, only show what query we WOULD send.
      console.log(`  [dry] artist id=${row.id}  ${row.name.padEnd(28)}  q="${q}"`);
      stats.processed === 1 && console.log('  (dry-run: skipping actual Nominatim calls and DB writes)');
      // Don't sleep / hit Nominatim in dry-run — just enumerate.
      continue;
    }

    if (result) {
      stats.geocoded++;
      await query(
        `UPDATE artists
           SET lat = ?, lng = ?, location_geocoded_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [result.lat, result.lng, row.id]
      );
      if (stats.geocoded <= 5) {
        console.log(`  ✓ id=${row.id}  ${row.name.padEnd(28)}  q="${q}"  →  ${result.lat}, ${result.lng}`);
      }
    } else {
      stats.misses++;
      if (stats.missSamples.length < 10) stats.missSamples.push(q);
      await query(
        `UPDATE artists
           SET location_geocoded_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [row.id]
      );
    }

    if (stats.processed % 50 === 0) {
      const elapsed = Date.now() - startedAt;
      const perItem = elapsed / stats.processed;
      const remaining = (rows.length - stats.processed) * perItem;
      console.log(
        `  ... ${stats.processed}/${rows.length} processed (${stats.geocoded} ✓ / ${stats.misses} ✗)  elapsed=${fmtTime(elapsed)}  ETA=${fmtTime(remaining)}`
      );
    }
  }

  const totalMs = Date.now() - startedAt;
  const cacheAfter = await cacheStateBefore();
  const cacheNew = cacheAfter - cacheBefore;
  const cacheHits = stats.geocoded > 0 ? Math.max(0, stats.geocoded - cacheNew) : 0;

  console.log('\n--- summary ---');
  console.log(`Artists with location data:    ${rows.length}`);
  console.log(`Successfully geocoded:         ${stats.geocoded}`);
  console.log(`Geocoder returned no result:   ${stats.misses}`);
  if (stats.missSamples.length) {
    console.log(`  Sample misses:`);
    for (const m of stats.missSamples) console.log(`    "${m}"`);
  }
  console.log(`Skipped (empty query):         ${stats.skippedEmptyQuery}`);
  console.log(`Cache hits / new entries:      ~${cacheHits} hits / ${cacheNew} new (estimated; cache-hit rate = ${stats.geocoded > 0 ? Math.round(cacheHits / stats.geocoded * 100) : 0}%)`);
  console.log(`Total time:                    ${fmtTime(totalMs)}`);
  if (DRY_RUN) console.log('\n(dry-run — no Nominatim calls and no DB writes performed)');
  process.exit(0);
}

main().catch((err) => {
  console.error('[geocode backfill] fatal:', err);
  process.exit(1);
});
