// List which Wikimedia rows hidden as 'license_unverified' Commons actually
// licenses, by reading each file's license from the Commons API (owner
// decision 6). Read-only on the database: it NEVER unhides anything. Output
// is a CSV for the owner to review; unhide chosen rows with
// scripts/hide-track.js <id> --unhide.
//
//   NODE_ENV=production LUMPYLP_ROLE=indexer node scripts/check-wikimedia-licenses.js --out=/root/wikimedia-licenses.csv
// Polite: 50 titles per request (the API's batch size), one request at a time.
import fs from 'node:fs';
import { loadEnv, assertIndexerUser } from '../lib/env.js';
import { wikimediaLicense } from '../services/wikimedia.js';

const UA = 'LumpyLP license check (https://lumpylp.com; contact takedowns@lumpylp.com)';
const csv = (v) => `"${String(v ?? '').replace(/"/g, '""').replace(/\s+/g, ' ').slice(0, 300)}"`;

// public_domain / cc / other: what Commons states; no_license: nothing stated.
export function classifyCommonsLicense(license) {
  if (!license) return 'no_license';
  const l = String(license).toLowerCase();
  if (/public ?domain|publicdomain|\bpd\b|cc0|zero\/1\.0/.test(l)) return 'public_domain';
  if (/creativecommons|cc[ -]by|cc-by/.test(l)) return 'cc';
  return 'other';
}

export async function checkWikimediaLicenses({ query, apiUrl = 'https://commons.wikimedia.org/w/api.php', out, delayMs = 1000, fetchImpl = fetch }) {
  const rows = await query(
    `SELECT id, external_id FROM tracks
     WHERE source = 'wikimedia' AND hidden_reason = 'license_unverified' ORDER BY id`
  );
  const lines = ['track_id,file,verdict,commons_license'];
  for (let i = 0; i < rows.length; i += 50) {
    const batch = rows.slice(i, i + 50);
    const u = new URL(apiUrl);
    u.search = new URLSearchParams({
      action: 'query', format: 'json', prop: 'imageinfo', iiprop: 'extmetadata',
      titles: batch.map((r) => r.external_id).join('|'),
    }).toString();
    const found = new Map();
    try {
      const res = await fetchImpl(u, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
      if (res.ok) {
        const data = await res.json();
        for (const p of Object.values(data?.query?.pages || {})) {
          found.set(p.title, wikimediaLicense(p.imageinfo?.[0]?.extmetadata));
        }
      }
    } catch { /* this batch stays unknown */ }
    for (const r of batch) {
      const lic = found.has(r.external_id) ? found.get(r.external_id) : undefined;
      const verdict = lic === undefined ? 'unknown' : classifyCommonsLicense(lic);
      lines.push([r.id, csv(r.external_id), verdict, csv(lic ?? '')].join(','));
    }
    if (delayMs) await new Promise((d) => setTimeout(d, delayMs));
  }
  fs.writeFileSync(out, lines.join('\n') + '\n', { mode: 0o600 });
  return { checked: rows.length, out };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  loadEnv('wikimedia-licenses', { role: 'indexer' });
  assertIndexerUser();
  const opts = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
  if (!opts.out) { console.error('usage: check-wikimedia-licenses.js --out=<file.csv>'); process.exit(2); }
  const { query, pool } = await import('../db.js');
  const r = await checkWikimediaLicenses({ query, out: opts.out });
  console.log(`checked ${r.checked} rows; wrote ${r.out}. Nothing was unhidden.`);
  await pool.end();
}
