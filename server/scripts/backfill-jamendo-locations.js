// Backfill country/city for artists where source='jamendo' AND country IS NULL.
//
// Reads each artist by name from artists table, queries Jamendo's
// /v3.0/artists/locations?namesearch=NAME endpoint, takes the row
// where the returned name matches ours exactly (case-insensitive),
// converts ISO-3 country to ISO-2, and writes country/city/source.
//
// Idempotent: WHERE country IS NULL means re-running picks up where we
// stopped. Safe to kill mid-run.
//
// Usage:
//   node server/scripts/backfill-jamendo-locations.js [--dry-run] [--limit N]

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const { query } = await import('../db.js');
const { iso3ToIso2 } = await import('../lib/countries.js');

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has('--dry-run');
const LIMIT_ARG = process.argv.find((a) => a.startsWith('--limit'));
const LIMIT = LIMIT_ARG ? parseInt(LIMIT_ARG.split('=')[1] || process.argv[process.argv.indexOf(LIMIT_ARG) + 1] || '0', 10) : 0;

const CLIENT_ID = process.env.JAMENDO_CLIENT_ID || '2dfa3139';
const BASE = 'https://api.jamendo.com/v3.0/artists/locations/';
const RATE_MS = 110; // ~9 req/s, comfortably under Jamendo's limits

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJamendoLocation(name) {
  const url = `${BASE}?client_id=${CLIENT_ID}&format=json&namesearch=${encodeURIComponent(name)}&limit=1`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'LumpyLP/0.1 (lumpylp.com)' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const hit = (data.results || [])[0];
    if (!hit) return null;
    // Strict name match — Jamendo's namesearch is fuzzy.
    if ((hit.name || '').trim().toLowerCase() !== name.trim().toLowerCase()) return null;
    const loc = (hit.locations || [])[0];
    if (!loc) return null;
    return {
      countryIso3: (loc.country || '').trim() || null,
      city: (loc.city || '').trim() || null,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const sql = `
    SELECT id, name FROM artists
    WHERE source = 'jamendo' AND country IS NULL
    ORDER BY id
    ${LIMIT > 0 ? `LIMIT ${LIMIT}` : ''}
  `;
  const rows = await query(sql);
  console.log(`[jamendo backfill] mode=${DRY_RUN ? 'DRY-RUN' : 'WRITE'}  candidates=${rows.length}${LIMIT > 0 ? ` (--limit ${LIMIT})` : ''}\n`);

  const stats = {
    processed: 0,
    tagged: 0,
    notFound: 0,
    iso3ConversionFailures: [],
    notFoundSamples: [],
  };

  for (const row of rows) {
    stats.processed++;
    const result = await fetchJamendoLocation(row.name);
    if (!result) {
      stats.notFound++;
      if (stats.notFoundSamples.length < 10) stats.notFoundSamples.push(row.name);
    } else {
      let countryStored = null;
      if (result.countryIso3) {
        const iso2 = iso3ToIso2(result.countryIso3);
        if (iso2) {
          countryStored = iso2;
        } else {
          stats.iso3ConversionFailures.push({ id: row.id, name: row.name, raw: result.countryIso3 });
          countryStored = result.countryIso3; // fall back to raw alpha-3
        }
      }
      if (!DRY_RUN) {
        await query(
          `UPDATE artists SET country = ?, city = ?, location_source = 'jamendo'
           WHERE id = ? AND country IS NULL`,
          [countryStored, result.city, row.id]
        );
      }
      stats.tagged++;
      if (stats.tagged <= 5) {
        console.log(`  ✓ id=${row.id}  ${row.name.padEnd(30)} → country=${countryStored ?? '(none)'} city=${result.city ?? '(none)'}`);
      }
    }
    if (stats.processed % 100 === 0) {
      console.log(`  ... ${stats.processed}/${rows.length} processed (${stats.tagged} tagged, ${stats.notFound} not found)`);
    }
    await sleep(RATE_MS);
  }

  console.log('\n--- summary ---');
  console.log(`Artists processed:      ${stats.processed}`);
  console.log(`Tagged successfully:    ${stats.tagged}`);
  console.log(`Not found on Jamendo:   ${stats.notFound}`);
  if (stats.notFoundSamples.length) {
    console.log(`  Sample not-found names: ${stats.notFoundSamples.slice(0, 10).join(' / ')}`);
  }
  console.log(`ISO-3 conversion failures: ${stats.iso3ConversionFailures.length}`);
  if (stats.iso3ConversionFailures.length) {
    for (const f of stats.iso3ConversionFailures) {
      console.log(`  unknown ISO-3 "${f.raw}" for artist "${f.name}" (id=${f.id})`);
    }
  }
  if (DRY_RUN) console.log('\n(dry-run — no DB writes performed)');
  process.exit(0);
}

main().catch((err) => {
  console.error('[jamendo backfill] fatal:', err);
  process.exit(1);
});
