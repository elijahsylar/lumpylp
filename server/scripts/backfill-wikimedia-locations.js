// Backfill country/city/location_raw for artists where source='wikimedia'
// AND country IS NULL AND city IS NULL AND location_raw IS NULL.
//
// Calls the same lib/wikimediaLocation.js lookup that services/wikimedia.js
// uses at ingest. Hits Wikidata's Action API (wbsearchentities +
// wbgetentities) per unique artist name. Conservative: skips any name
// whose top wbsearchentities result doesn't match closely.
//
// Idempotent. Resumable. Safe to kill mid-run.
//
// Usage:
//   node server/scripts/backfill-wikimedia-locations.js [--dry-run] [--limit N]

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const { query } = await import('../db.js');
const { lookupArtist } = await import('../lib/wikimediaLocation.js');

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has('--dry-run');
const LIMIT_ARG = process.argv.find((a) => a.startsWith('--limit'));
const LIMIT = LIMIT_ARG
  ? parseInt(LIMIT_ARG.split('=')[1] || process.argv[process.argv.indexOf(LIMIT_ARG) + 1] || '0', 10)
  : 0;

async function main() {
  const sql = `
    SELECT id, name FROM artists
    WHERE source = 'wikimedia'
      AND country IS NULL AND city IS NULL
      AND location_raw IS NULL
    ORDER BY id
    ${LIMIT > 0 ? `LIMIT ${LIMIT}` : ''}
  `;
  const rows = await query(sql);
  console.log(`[wikimedia backfill] mode=${DRY_RUN ? 'DRY-RUN' : 'WRITE'}  candidates=${rows.length}${LIMIT > 0 ? ` (--limit ${LIMIT})` : ''}\n`);

  const stats = {
    processed: 0,
    tagged: 0,
    notFound: 0,
    notFoundSamples: [],
  };

  for (const row of rows) {
    stats.processed++;
    const loc = await lookupArtist(row.name);
    if (!loc) {
      stats.notFound++;
      if (stats.notFoundSamples.length < 10) stats.notFoundSamples.push(row.name);
    } else {
      if (!DRY_RUN) {
        await query(
          `UPDATE artists
           SET country = ?, city = ?, location_raw = ?, location_source = 'wikidata'
           WHERE id = ? AND country IS NULL AND city IS NULL`,
          [loc.country, loc.city, loc.raw, row.id]
        );
      }
      stats.tagged++;
      if (stats.tagged <= 5) {
        console.log(`  ✓ id=${row.id}  ${row.name.padEnd(40)} → ${loc.raw}`);
      }
    }
    if (stats.processed % 100 === 0) {
      console.log(`  ... ${stats.processed}/${rows.length} processed (${stats.tagged} tagged, ${stats.notFound} not found)`);
    }
  }

  console.log('\n--- summary ---');
  console.log(`Artists processed:      ${stats.processed}`);
  console.log(`Tagged successfully:    ${stats.tagged}`);
  console.log(`Not found on Wikidata:  ${stats.notFound}`);
  if (stats.notFoundSamples.length) {
    console.log(`  Sample not-found names: ${stats.notFoundSamples.slice(0, 10).join(' / ')}`);
  }
  if (DRY_RUN) console.log('\n(dry-run — no DB writes performed)');
  process.exit(0);
}

main().catch((err) => {
  console.error('[wikimedia backfill] fatal:', err);
  process.exit(1);
});
