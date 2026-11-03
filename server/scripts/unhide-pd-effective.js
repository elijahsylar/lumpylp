// Unhide tracks whose US public-domain date has arrived (17 USC 1401).
// Only rows hidden for that reason (pd_not_yet_<year>) with pd_effective_on
// on or before today; every other hide stays. Dry-run unless --apply.
// Meant for a systemd timer on Jan 1 each year (server rebuild).
//
//   NODE_ENV=production node scripts/unhide-pd-effective.js [--apply] [--today=YYYY-MM-DD]
// Runs as lumpylp_indexer.
import { loadEnv, assertIndexerUser } from '../lib/env.js';

export async function unhidePdEffective({ query, today, apply = false }) {
  const day = today || new Date().toISOString().slice(0, 10);
  const [{ n }] = await query(
    `SELECT COUNT(*) AS n FROM tracks
     WHERE hidden_reason LIKE 'pd\\_not\\_yet\\_%' AND pd_effective_on IS NOT NULL AND pd_effective_on <= ?`,
    [day]
  );
  const eligible = Number(n);
  if (!apply || !eligible) return { today: day, eligible, unhidden: 0 };
  const ids = (await query(
    `SELECT id FROM tracks
     WHERE hidden_reason LIKE 'pd\\_not\\_yet\\_%' AND pd_effective_on IS NOT NULL AND pd_effective_on <= ?`,
    [day]
  )).map((r) => r.id);
  const r = await query(
    `UPDATE tracks SET hidden_at = NULL, hidden_reason = NULL, hidden_note = NULL
     WHERE hidden_reason LIKE 'pd\\_not\\_yet\\_%' AND pd_effective_on IS NOT NULL AND pd_effective_on <= ?`,
    [day]
  );
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    await query(
      `INSERT INTO moderation_log (track_id, actor, action, note) VALUES ${chunk.map(() => '(?, ?, ?, ?)').join(',')}`,
      chunk.flatMap((id) => [id, 'script:unhide-pd-effective', 'unhide', `public domain from ${day}`])
    );
  }
  return { today: day, eligible, unhidden: r.affectedRows };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  loadEnv('unhide-pd', { role: 'indexer' });
  assertIndexerUser();
  const opts = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
  const { query, pool } = await import('../db.js');
  const r = await unhidePdEffective({ query, today: opts.today, apply: !!opts.apply });
  console.log(`${r.today}: ${r.eligible} eligible, ${r.unhidden} unhidden${opts.apply ? '' : ' (dry run; add --apply)'}`);
  await pool.end();
}
