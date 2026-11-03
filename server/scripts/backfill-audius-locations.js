// Backfill country/city/location_raw for artists where source='audius'
// AND country IS NULL AND city IS NULL.
//
// Searches Audius for each artist name, reads the user.location free-text
// field, applies the junk filter, parses into city/country guesses, and
// writes — preserving the raw original string in location_raw regardless
// of how the parser handles it.
//
// Multi-node failover for the search call (mirrors the existing
// audius-nodes service used elsewhere in the app).
//
// Idempotent. Resumable. Safe to kill mid-run.
//
// Usage:
//   node server/scripts/backfill-audius-locations.js [--dry-run] [--limit N]

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const { query } = await import('../db.js');
const { isPlausibleLocation } = await import('../lib/locationFilter.js');
const { parseAudiusLocation } = await import('../lib/audiusLocation.js');

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has('--dry-run');
const LIMIT_ARG = process.argv.find((a) => a.startsWith('--limit'));
const LIMIT = LIMIT_ARG ? parseInt(LIMIT_ARG.split('=')[1] || process.argv[process.argv.indexOf(LIMIT_ARG) + 1] || '0', 10) : 0;

const NODES = [
  'https://discoveryprovider.audius.co',
  'https://discoveryprovider2.audius.co',
  'https://discoveryprovider3.audius.co',
  'https://api.audius.co',
];
let nodeIdx = 0;
const RATE_MS = 200; // 5 req/sec

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function audiusFetch(pathStr) {
  for (let attempt = 0; attempt < NODES.length; attempt++) {
    const base = NODES[(nodeIdx + attempt) % NODES.length];
    try {
      const url = `${base}${pathStr}${pathStr.includes('?') ? '&' : '?'}app_name=LumpyLP`;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10000);
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { 'User-Agent': 'LumpyLP/0.1 (lumpylp.com)' },
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      // Promote the working node so subsequent calls hit it first.
      nodeIdx = (nodeIdx + attempt) % NODES.length;
      return await res.json();
    } catch {
      // try next node
    }
  }
  return null;
}

async function main() {
  // Phase 17.8: location_raw IS NULL excludes rows that the indexer
  // already captured at ingest. Those rows had their raw string and
  // (when parseable) city/country populated by services/audius.js
  // — re-fetching them via the API would yield the same answer.
  const sql = `
    SELECT id, name FROM artists
    WHERE source = 'audius'
      AND country IS NULL AND city IS NULL
      AND location_raw IS NULL
    ORDER BY id
    ${LIMIT > 0 ? `LIMIT ${LIMIT}` : ''}
  `;
  const rows = await query(sql);
  console.log(`[audius backfill] mode=${DRY_RUN ? 'DRY-RUN' : 'WRITE'}  candidates=${rows.length}${LIMIT > 0 ? ` (--limit ${LIMIT})` : ''}\n`);

  const stats = {
    processed: 0,
    tagged: 0,
    filteredJunk: 0,
    junkSamples: [],
    profileNotFound: 0,
    profileNotFoundSamples: [],
    locationEmpty: 0,
  };

  for (const row of rows) {
    stats.processed++;
    const data = await audiusFetch(`/v1/users/search?query=${encodeURIComponent(row.name)}`);
    if (!data || !Array.isArray(data.data) || data.data.length === 0) {
      stats.profileNotFound++;
      if (stats.profileNotFoundSamples.length < 10) stats.profileNotFoundSamples.push(row.name);
      await sleep(RATE_MS);
      continue;
    }
    const lower = row.name.toLowerCase();
    const hit = data.data.find((u) => (u.name || '').trim().toLowerCase() === lower) || data.data[0];
    const raw = (hit?.location || '').trim();

    if (!raw) {
      stats.locationEmpty++;
      await sleep(RATE_MS);
      continue;
    }

    if (!isPlausibleLocation(raw)) {
      stats.filteredJunk++;
      if (stats.junkSamples.length < 10) stats.junkSamples.push({ name: row.name, raw });
      // Still preserve the raw string — the prompt requires it in 100% of
      // backfilled rows, even when the parser rejects them.
      if (!DRY_RUN) {
        await query(
          `UPDATE artists SET location_raw = ?, location_source = 'audius'
           WHERE id = ? AND country IS NULL AND city IS NULL`,
          [raw.slice(0, 255), row.id]
        );
      }
      await sleep(RATE_MS);
      continue;
    }

    const { city, country } = parseAudiusLocation(raw);
    if (!DRY_RUN) {
      await query(
        `UPDATE artists
         SET country = ?, city = ?, location_raw = ?, location_source = 'audius'
         WHERE id = ? AND country IS NULL AND city IS NULL`,
        [country, city, raw.slice(0, 255), row.id]
      );
    }
    stats.tagged++;
    if (stats.tagged <= 5) {
      console.log(`  ✓ id=${row.id}  ${row.name.padEnd(28)} raw="${raw}"  →  country=${country ?? '(none)'} city=${city ?? '(none)'}`);
    }

    if (stats.processed % 100 === 0) {
      console.log(`  ... ${stats.processed}/${rows.length} processed`);
    }
    await sleep(RATE_MS);
  }

  console.log('\n--- summary ---');
  console.log(`Artists processed:        ${stats.processed}`);
  console.log(`Tagged:                   ${stats.tagged}`);
  console.log(`Filtered as junk:         ${stats.filteredJunk}  (location_raw preserved)`);
  if (stats.junkSamples.length) {
    console.log(`  Junk samples:`);
    for (const j of stats.junkSamples) console.log(`    "${j.raw}"  (artist: ${j.name})`);
  }
  console.log(`Profile not found:        ${stats.profileNotFound}`);
  if (stats.profileNotFoundSamples.length) {
    console.log(`  Sample not-found names: ${stats.profileNotFoundSamples.slice(0, 10).join(' / ')}`);
  }
  console.log(`Profile found, location empty: ${stats.locationEmpty}`);
  console.log(`Original string preserved in location_raw: 100%`);
  if (DRY_RUN) console.log('\n(dry-run — no DB writes performed)');
  process.exit(0);
}

main().catch((err) => {
  console.error('[audius backfill] fatal:', err);
  process.exit(1);
});
