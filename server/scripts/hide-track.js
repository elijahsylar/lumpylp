// Hide (or unhide) a track from the command line, for when the API is down.
// Same rules and log as the admin API (lib/moderation.js).
//
//   NODE_ENV=production node scripts/hide-track.js <track-id> --reason=takedown --note="notice of 2026-11-02"
//   NODE_ENV=production node scripts/hide-track.js <track-id> --unhide
import os from 'node:os';
import { loadEnv } from '../lib/env.js';
import { validateHide, hideTrack, unhideTrack } from '../lib/moderation.js';

loadEnv('hide-track');
const args = process.argv.slice(2);
const trackId = parseInt(args[0], 10);
const opt = Object.fromEntries(args.slice(1).map((a) => { const [k, ...v] = a.replace(/^--/, '').split('='); return [k, v.join('=') || true]; }));
if (!Number.isInteger(trackId) || trackId < 1) {
  console.error('usage: hide-track.js <track-id> --reason=<takedown|rights|quality|admin> [--note=...] | --unhide');
  process.exit(2);
}
const { query, pool } = await import('../db.js');
const actor = `cli:${os.userInfo().username}`;
let ok;
if (opt.unhide) {
  ok = await unhideTrack(query, { trackId, actor });
} else {
  const problem = validateHide({ reason: opt.reason, note: opt.note ?? null });
  if (problem) { console.error(problem); await pool.end(); process.exit(2); }
  ok = await hideTrack(query, { trackId, reason: opt.reason, note: opt.note ?? null, actor });
}
console.log(ok ? `${opt.unhide ? 'unhid' : 'hid'} track ${trackId}` : `no track ${trackId}`);
await pool.end();
process.exit(ok ? 0 : 1);
