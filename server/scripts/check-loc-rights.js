// List which hidden Library of Congress American Folklife Center rows could be
// unhidden, by reading each item's rights statement from loc.gov (owner
// decision 3). Read-only on the database: it NEVER unhides anything. Output
// is a CSV for the owner to review; unhide chosen rows with
// scripts/hide-track.js <id> --unhide.
//
//   NODE_ENV=production node scripts/check-loc-rights.js --out=/root/loc-rights.csv [--delay-ms=1500]
// Polite: one request at a time with a delay, cached per item id.
import fs from 'node:fs';
import { loadEnv, assertIndexerUser } from '../lib/env.js';

const UA = 'LumpyLP rights check (https://lumpylp.com; contact takedowns@lumpylp.com)';

// candidate: LoC says no known restrictions / public domain.
// restricted: LoC asks for permission or names a rights holder.
// unknown: no usable statement.
export function classifyRights(text) {
  const t = String(text || '').toLowerCase();
  if (!t.trim()) return 'unknown';
  if (/permission|rights holder|rightsholder|copyright holder|may be protected|restricted|written consent/.test(t)
      && !/not aware of any u\.s\. copyright or other restrictions/.test(t)) return 'restricted';
  if (/no known (copyright )?restrictions|public domain|not aware of any u\.s\. copyright or other restrictions|free to use/.test(t)) return 'candidate';
  return 'unknown';
}

function rightsText(json) {
  const r = json?.item?.rights ?? json?.item?.rights_advisory ?? json?.rights;
  return Array.isArray(r) ? r.join(' ') : String(r || '');
}

const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""').replace(/\s+/g, ' ').slice(0, 500)}"`;

export async function checkLocRights({ query, baseUrl = 'https://www.loc.gov', out, delayMs = 1500, fetchImpl = fetch }) {
  const rows = await query(
    `SELECT id, external_id, title FROM tracks
     WHERE source = 'loc_jukebox' AND hidden_reason = 'rights_check_pending' ORDER BY id`
  );
  const cache = new Map();
  const lines = ['external_id,track_id,verdict,title,rights_statement'];
  for (const r of rows) {
    if (!cache.has(r.external_id)) {
      let text = '';
      try {
        const res = await fetchImpl(`${baseUrl}/item/${encodeURIComponent(r.external_id)}/?fo=json`, {
          headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000),
        });
        if (res.ok) text = rightsText(await res.json());
      } catch { /* leave unknown */ }
      cache.set(r.external_id, text);
      if (delayMs) await new Promise((d) => setTimeout(d, delayMs));
    }
    const text = cache.get(r.external_id);
    lines.push([r.external_id, r.id, classifyRights(text), csvCell(r.title), csvCell(text)].join(','));
  }
  fs.writeFileSync(out, lines.join('\n') + '\n', { mode: 0o600 });
  return { checked: rows.length, items: cache.size, out };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  loadEnv('loc-rights', { role: 'indexer' });
  assertIndexerUser();
  const opts = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
  if (!opts.out) { console.error('usage: check-loc-rights.js --out=<file.csv> [--delay-ms=1500]'); process.exit(2); }
  const { query, pool } = await import('../db.js');
  const r = await checkLocRights({ query, out: opts.out, delayMs: Number(opts['delay-ms'] ?? 1500) });
  console.log(`checked ${r.checked} rows (${r.items} items); wrote ${r.out}. Nothing was unhidden.`);
  await pool.end();
}
