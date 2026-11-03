// Dedupe tracks within one source (relaunch item 7). Rows with the same
// source, normalized artist, normalized title and duration are one recording
// listed more than once (e.g. the same song on several releases).
//
// Dry run (default): plans groups and writes a CSV; changes nothing.
// --apply: per group, keeps the best row and, for every other row:
//   - re-points lump entries to the kept row (if the lump already holds it,
//     the duplicate entry is removed; positions are left as they are, gaps
//     are harmless because lumps sort by position),
//   - moves votes to the kept row (if the user also voted on it, their vote
//     on the kept row wins and the other is removed),
//   - hides the row (hidden_reason 'duplicate', duplicate_of = kept id);
//   then recounts the kept row's votes. Every change is logged in
//   track_merge_log under a run id.
// --undo=<run_id>: restores lump entries, votes and the hidden rows, except
//   where something changed since (a later takedown, a deleted lump); those
//   are skipped and reported. Vote counters are recomputed from votes.
//
// archive_livemusic is excluded unless --include-livemusic (owner decision 5):
// different shows of the same song can share a title and duration.
// archive_pd78s is excluded unless --include-pd78s (follow-up decision 5).
//
//   NODE_ENV=production node scripts/dedupe-within-source.js [--sources=a,b] [--out=plan.csv]
//   NODE_ENV=production node scripts/dedupe-within-source.js --apply [--sources=a,b]
//   NODE_ENV=production node scripts/dedupe-within-source.js --undo=<run_id>
// Runs as lumpylp_indexer. Never deletes a catalog row.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { loadEnv, assertIndexerUser } from '../lib/env.js';

export function normalizeName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/^the /, '')
    .replace(/\s+/g, ' ');
}

// Better row first: live, has artwork, has genre, more votes, older id.
function rank(a, b) {
  const score = (t) => [t.is_dead ? 0 : 1, t.artwork_url ? 1 : 0, t.genre ? 1 : 0, (t.upvotes || 0) + (t.downvotes || 0)];
  const sa = score(a), sb = score(b);
  for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return sb[i] - sa[i];
  return a.id - b.id;
}

export async function planDedupe({ query, sources, includeLivemusic = false, includePd78s = false }) {
  let list = sources;
  if (!list) list = (await query(`SELECT DISTINCT source FROM tracks`)).map((r) => r.source);
  if (!includeLivemusic) list = list.filter((s) => s !== 'archive_livemusic');
  // archive_pd78s: same title/artist/duration across IA items is usually a
  // different transfer of one recording; left out of the first run (owner
  // decision, follow-up 5) until its dry-run CSV has been reviewed.
  if (!includePd78s) list = list.filter((s) => s !== 'archive_pd78s');
  const groups = [];
  for (const source of list) {
    const rows = await query(
      `SELECT id, source, artist_name, title, duration_seconds, is_dead, artwork_url, genre, upvotes, downvotes
       FROM tracks WHERE source = ? AND duration_seconds IS NOT NULL AND hidden_at IS NULL`,
      [source]
    );
    const byKey = new Map();
    for (const r of rows) {
      const key = `${normalizeName(r.artist_name)}|${normalizeName(r.title)}|${r.duration_seconds}`;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(r);
    }
    for (const [key, members] of byKey) {
      if (members.length < 2) continue;
      members.sort(rank);
      groups.push({ source, key, keeper: members[0].id, losers: members.slice(1).map((m) => m.id), members });
    }
  }
  return { groups, sources: list };
}

const csv = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
export function writePlanCsv(plan, file) {
  const lines = ['source,group_key,keeper_id,loser_id,loser_title,loser_artist,duration_seconds'];
  for (const g of plan.groups) {
    const byId = new Map(g.members.map((m) => [m.id, m]));
    for (const l of g.losers) {
      const m = byId.get(l);
      lines.push([csv(g.source), csv(g.key), g.keeper, l, csv(m.title), csv(m.artist_name), m.duration_seconds].join(','));
    }
  }
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return lines.length - 1;
}

async function recount(conn, trackId) {
  await conn.query(
    `UPDATE tracks SET
       upvotes = (SELECT COUNT(*) FROM votes WHERE track_id = ? AND direction = 1),
       downvotes = (SELECT COUNT(*) FROM votes WHERE track_id = ? AND direction = -1)
     WHERE id = ?`,
    [trackId, trackId, trackId]
  );
}

const asJson = (row) => JSON.stringify(row, (_k, v) => (v instanceof Date ? v.toISOString() : v));

async function mergeGroup(conn, runId, keeper, loser) {
  const log = (kind, rowId, before) => conn.query(
    `INSERT INTO track_merge_log (run_id, kind, loser_id, keeper_id, row_id, before_json) VALUES (?, ?, ?, ?, ?, ?)`,
    [runId, kind, loser, keeper, rowId, before == null ? null : asJson(before)]
  );
  // Lump entries.
  const [lts] = await conn.query(`SELECT * FROM lump_tracks WHERE track_id = ?`, [loser]);
  for (const lt of lts) {
    const [[has]] = await conn.query(`SELECT COUNT(*) AS n FROM lump_tracks WHERE lump_id = ? AND track_id = ?`, [lt.lump_id, keeper]);
    if (Number(has.n)) {
      await log('lump_track_drop', lt.id, lt);
      await conn.query(`DELETE FROM lump_tracks WHERE id = ?`, [lt.id]);
    } else {
      await log('lump_track_move', lt.id, lt);
      await conn.query(`UPDATE lump_tracks SET track_id = ? WHERE id = ?`, [keeper, lt.id]);
    }
  }
  // Votes.
  const [vs] = await conn.query(`SELECT * FROM votes WHERE track_id = ?`, [loser]);
  for (const v of vs) {
    const [[has]] = await conn.query(`SELECT COUNT(*) AS n FROM votes WHERE user_id = ? AND track_id = ?`, [v.user_id, keeper]);
    if (Number(has.n)) {
      await log('vote_drop', v.id, v);
      await conn.query(`DELETE FROM votes WHERE id = ?`, [v.id]);
    } else {
      await log('vote_move', v.id, v);
      // Keep updated_at: it drives the windowed "top" views.
      await conn.query(`UPDATE votes SET track_id = ?, updated_at = updated_at WHERE id = ?`, [keeper, v.id]);
    }
  }
  // Hide the duplicate.
  const [[t]] = await conn.query(
    `SELECT id, hidden_at, hidden_reason, hidden_note, duplicate_of, upvotes, downvotes FROM tracks WHERE id = ?`, [loser]);
  await log('hide', loser, t);
  await conn.query(
    `UPDATE tracks SET hidden_at = NOW(), hidden_reason = 'duplicate', duplicate_of = ?,
            hidden_note = 'same recording as the kept row' WHERE id = ?`,
    [keeper, loser]
  );
  await recount(conn, loser);
}

export async function applyDedupe({ pool, plan, runId = `dd${Date.now()}${crypto.randomBytes(3).toString('hex')}` }) {
  const conn = await pool.getConnection();
  try {
    for (const g of plan.groups) {
      await conn.beginTransaction();
      try {
        // The kept row's counters before anything moves, so --undo can put
        // back exactly what was there (even if it didn't match the votes).
        const [[k]] = await conn.query(`SELECT id, upvotes, downvotes FROM tracks WHERE id = ?`, [g.keeper]);
        await conn.query(
          `INSERT INTO track_merge_log (run_id, kind, loser_id, keeper_id, row_id, before_json) VALUES (?, 'counts', ?, ?, ?, ?)`,
          [runId, g.keeper, g.keeper, g.keeper, asJson(k)]
        );
        for (const loser of g.losers) await mergeGroup(conn, runId, g.keeper, loser);
        await recount(conn, g.keeper);
        await conn.commit();
      } catch (err) {
        await conn.rollback();
        throw err;
      }
    }
  } finally {
    conn.release();
  }
  return runId;
}

const fromJson = (s) => (typeof s === 'string' ? JSON.parse(s) : s);
const toDate = (v) => (v == null ? null : new Date(v));

// Undo a run. Each change is restored only if things are still as the run
// left them, so undo never reverses something done since (review R2): a
// duplicate an admin has since taken down stays hidden, a lump that was
// deleted is not resurrected. Vote counters are recomputed from the votes
// table for every touched track (review R8). Returns { undone, skipped }.
export async function undoDedupe({ pool, runId }) {
  const conn = await pool.getConnection();
  const skipped = [];
  let undone = 0;
  const touched = new Set();
  const exists = async (sql, params) => Number((await conn.query(sql, params))[0][0].n) > 0;
  try {
    await conn.beginTransaction();
    const [entries] = await conn.query(
      `SELECT * FROM track_merge_log WHERE run_id = ? AND undone_at IS NULL ORDER BY id DESC`, [runId]);
    for (const e of entries) {
      const b = fromJson(e.before_json);
      touched.add(e.keeper_id); touched.add(e.loser_id);
      const skip = (why) => skipped.push({ kind: e.kind, loser_id: e.loser_id, row_id: e.row_id, why });
      if (e.kind === 'counts') continue; // counters are recomputed below
      if (e.kind === 'hide') {
        const [[t]] = await conn.query(`SELECT hidden_reason, duplicate_of FROM tracks WHERE id = ?`, [b.id]);
        if (!t || t.hidden_reason !== 'duplicate' || t.duplicate_of !== e.keeper_id) {
          skip(`track is now ${t?.hidden_reason ? `hidden as ${t.hidden_reason}` : 'changed'}; left as is`);
          continue;
        }
        await conn.query(`UPDATE tracks SET hidden_at = ?, hidden_reason = ?, hidden_note = ?, duplicate_of = ? WHERE id = ?`,
          [toDate(b.hidden_at), b.hidden_reason, b.hidden_note, b.duplicate_of, b.id]);
        if (!b.hidden_at) {
          await conn.query(`INSERT INTO moderation_log (track_id, actor, action, note) VALUES (?, ?, 'unhide', ?)`,
            [b.id, `script:dedupe-undo:${runId}`, `undo of dedupe run ${runId}`]);
        }
      } else if (e.kind === 'lump_track_move') {
        if (!(await exists(`SELECT COUNT(*) n FROM lump_tracks WHERE id = ? AND track_id = ?`, [b.id, e.keeper_id]))) {
          skip('lump entry was changed or removed since; left as is'); continue;
        }
        await conn.query(`UPDATE lump_tracks SET track_id = ?, position = ? WHERE id = ?`, [b.track_id, b.position, b.id]);
      } else if (e.kind === 'lump_track_drop') {
        if (!(await exists(`SELECT COUNT(*) n FROM user_lumps WHERE id = ?`, [b.lump_id]))) {
          skip('lump was deleted since; entry not restored'); continue;
        }
        if (await exists(`SELECT COUNT(*) n FROM lump_tracks WHERE id = ? OR (lump_id = ? AND track_id = ?)`, [b.id, b.lump_id, b.track_id])) {
          skip('lump already holds this track again; not duplicated'); continue;
        }
        await conn.query(`INSERT INTO lump_tracks (id, lump_id, track_id, position, added_at) VALUES (?, ?, ?, ?, ?)`,
          [b.id, b.lump_id, b.track_id, b.position, toDate(b.added_at)]);
      } else if (e.kind === 'vote_move') {
        if (!(await exists(`SELECT COUNT(*) n FROM votes WHERE id = ? AND track_id = ?`, [b.id, e.keeper_id]))) {
          skip('vote was changed or removed since; left as is'); continue;
        }
        await conn.query(`UPDATE votes SET track_id = ?, direction = ?, weight = ?, updated_at = ? WHERE id = ?`,
          [b.track_id, b.direction, b.weight, toDate(b.updated_at), b.id]);
      } else if (e.kind === 'vote_drop') {
        if (!(await exists(`SELECT COUNT(*) n FROM users WHERE id = ?`, [b.user_id]))) {
          skip('voter account was deleted since; vote not restored'); continue;
        }
        if (await exists(`SELECT COUNT(*) n FROM votes WHERE id = ? OR (user_id = ? AND track_id = ?)`, [b.id, b.user_id, b.track_id])) {
          skip('user has voted on this track again; not duplicated'); continue;
        }
        await conn.query(`INSERT INTO votes (id, user_id, track_id, direction, weight, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [b.id, b.user_id, b.track_id, b.direction, b.weight, toDate(b.created_at), toDate(b.updated_at)]);
      }
      undone += 1;
    }
    for (const id of touched) await recount(conn, id);
    await conn.query(`UPDATE track_merge_log SET undone_at = NOW() WHERE run_id = ?`, [runId]);
    await conn.commit();
    return { undone, skipped };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  loadEnv('dedupe', { role: 'indexer' });
  assertIndexerUser();
  const opts = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
  const { query, pool } = await import('../db.js');
  try {
    if (opts.undo) {
      const r = await undoDedupe({ pool, runId: opts.undo });
      console.log(`undid ${r.undone} changes from run ${opts.undo}; ${r.skipped.length} skipped`);
      for (const k of r.skipped) console.log(`  skipped ${k.kind} for track ${k.loser_id}: ${k.why}`);
    } else {
      const plan = await planDedupe({
        query,
        sources: opts.sources ? String(opts.sources).split(',') : null,
        includeLivemusic: !!opts['include-livemusic'],
        includePd78s: !!opts['include-pd78s'],
      });
      const losers = plan.groups.reduce((s, g) => s + g.losers.length, 0);
      const out = opts.out || `dedupe-plan-${new Date().toISOString().slice(0, 10)}.csv`;
      writePlanCsv(plan, out);
      console.log(`${plan.groups.length} groups, ${losers} duplicate rows across ${plan.sources.join(', ')}; plan written to ${out}`);
      if (opts.apply) {
        const runId = await applyDedupe({ pool, plan });
        console.log(`applied as run ${runId}; undo with --undo=${runId}`);
      } else {
        console.log('dry run: nothing changed (add --apply)');
      }
    }
  } finally {
    await pool.end();
  }
}
