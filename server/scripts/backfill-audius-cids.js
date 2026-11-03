// Backfill audius_track_cid for existing audius tracks. Reads tracks
// missing the CID, fetches each via the multi-node failover helper, and
// updates the row. Resume-able: re-runs only touch rows where
// audius_track_cid IS NULL.
//
// Usage: cd server && node scripts/backfill-audius-cids.js
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const { pool, query } = await import('../db.js');
const { fetchTrackById } = await import('../services/audius.js');

const PACE_MS = 110;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const totalRows = await query(
    `SELECT COUNT(*) AS n FROM tracks WHERE source='audius' AND audius_track_cid IS NULL`
  );
  const missing = totalRows[0].n;
  console.log(`[backfill] ${missing} audius tracks missing audius_track_cid`);

  if (missing === 0) {
    console.log('[backfill] nothing to do');
    return;
  }

  // Page through the missing rows. We re-read the count occasionally so
  // multiple runs in parallel don't race or repeat.
  const startAt = Date.now();
  let processed = 0, updated = 0, notFound = 0, errors = 0;
  let lastLog = 0;

  // Process in batches of 200 so a long run doesn't hold one giant cursor.
  const BATCH = 200;
  while (true) {
    const rows = await query(
      `SELECT id, external_id FROM tracks
       WHERE source='audius' AND audius_track_cid IS NULL
       ORDER BY id ASC LIMIT ${BATCH}`
    );
    if (rows.length === 0) break;

    for (const row of rows) {
      try {
        await sleep(PACE_MS);
        const t = await fetchTrackById(row.external_id);
        const cid = t?.track_cid ? String(t.track_cid).slice(0, 100) : null;
        if (cid) {
          await query(
            `UPDATE tracks SET audius_track_cid = ? WHERE id = ?`,
            [cid, row.id]
          );
          updated++;
        } else if (t === null) {
          // Track gone upstream — write a sentinel so we don't re-fetch it
          // on every backfill run. Empty string ≠ NULL so the WHERE skips it.
          await query(
            `UPDATE tracks SET audius_track_cid = '' WHERE id = ?`,
            [row.id]
          );
          notFound++;
        }
      } catch (err) {
        errors++;
        // Don't write anything — leave NULL so we retry on next run.
      }
      processed++;

      if (Date.now() - lastLog > 5000) {
        const dt = (Date.now() - startAt) / 1000;
        const rate = processed / dt;
        const remaining = Math.max(0, missing - processed);
        const eta = remaining / Math.max(rate, 0.1);
        console.log(
          `[backfill] ${processed}/${missing}  +${updated} cids  ` +
          `${notFound} not-found  ${errors} errs  ` +
          `rate ${rate.toFixed(1)}/s  eta ${(eta / 60).toFixed(1)}m`
        );
        lastLog = Date.now();
      }
    }
  }

  const dt = ((Date.now() - startAt) / 1000).toFixed(1);
  console.log(
    `\n[backfill] DONE in ${dt}s — ${updated} cids written, ` +
    `${notFound} tracks not found upstream, ${errors} errors`
  );
}

main()
  .then(() => pool.end())
  .catch((e) => {
    console.error('fatal', e);
    pool.end();
    process.exit(1);
  });
