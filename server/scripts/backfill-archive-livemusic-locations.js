// Backfill country/city/location_raw for artists where source='archive_livemusic'
// AND country IS NULL AND city IS NULL AND location_raw IS NULL.
//
// Calls the same lib/etreeLocation.js lookup that
// services/archive_livemusic.js uses at ingest. Two-stage:
//   1. Curated etree band table (jam-scene cultural shorthand)
//   2. Wikidata fallback via lib/wikimediaLocation.js
// Conservative — bands that aren't in the table and don't match a
// Wikidata entity closely stay null. Better NULL than wrong.
//
// Coverage estimate at the time of writing: ~21.9% by artist (66-entry
// table + Wikidata) and ~63.6% by track count. Long-tail obscure bands
// dominate the misses; nothing short of per-show venue scraping would
// catch those, and that's a different chunk.
//
// Idempotent. Resumable. Safe to kill mid-run.
//
// Usage:
//   node server/scripts/backfill-archive-livemusic-locations.js [--dry-run] [--limit N]

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const { query } = await import('../db.js');
const { lookupArtist } = await import('../lib/etreeLocation.js');

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has('--dry-run');
const LIMIT_ARG = process.argv.find((a) => a.startsWith('--limit'));
const LIMIT = LIMIT_ARG
  ? parseInt(LIMIT_ARG.split('=')[1] || process.argv[process.argv.indexOf(LIMIT_ARG) + 1] || '0', 10)
  : 0;

async function main() {
  const sql = `
    SELECT id, name FROM artists
    WHERE source = 'archive_livemusic'
      AND country IS NULL AND city IS NULL
      AND location_raw IS NULL
    ORDER BY id
    ${LIMIT > 0 ? `LIMIT ${LIMIT}` : ''}
  `;
  const rows = await query(sql);
  console.log(`[archive_livemusic backfill] mode=${DRY_RUN ? 'DRY-RUN' : 'WRITE'}  candidates=${rows.length}${LIMIT > 0 ? ` (--limit ${LIMIT})` : ''}\n`);

  const stats = {
    processed: 0,
    taggedEtree: 0,
    taggedWikidata: 0,
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
           SET country = ?, city = ?, location_raw = ?, location_source = ?
           WHERE id = ? AND country IS NULL AND city IS NULL`,
          [loc.country, loc.city, loc.raw, loc.source, row.id]
        );
      }
      if (loc.source === 'etree') stats.taggedEtree++;
      else stats.taggedWikidata++;
      const taggedCount = stats.taggedEtree + stats.taggedWikidata;
      if (taggedCount <= 5) {
        console.log(`  ✓ id=${row.id}  ${row.name.padEnd(40)} → ${loc.raw}  [${loc.source}]`);
      }
    }
    if (stats.processed % 100 === 0) {
      const tagged = stats.taggedEtree + stats.taggedWikidata;
      console.log(`  ... ${stats.processed}/${rows.length} processed (${tagged} tagged, ${stats.notFound} not found)`);
    }
  }

  console.log('\n--- summary ---');
  console.log(`Artists processed:      ${stats.processed}`);
  console.log(`Tagged via etree table: ${stats.taggedEtree}`);
  console.log(`Tagged via Wikidata:    ${stats.taggedWikidata}`);
  console.log(`Total tagged:           ${stats.taggedEtree + stats.taggedWikidata}`);
  console.log(`Not found:              ${stats.notFound}`);
  if (stats.notFoundSamples.length) {
    console.log(`  Sample not-found names: ${stats.notFoundSamples.slice(0, 10).join(' / ')}`);
  }
  if (DRY_RUN) console.log('\n(dry-run — no DB writes performed)');
  process.exit(0);
}

main().catch((err) => {
  console.error('[archive_livemusic backfill] fatal:', err);
  process.exit(1);
});
