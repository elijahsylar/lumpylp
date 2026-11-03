// Item 7 + owner decision 5: within-source dedupe keeps the best row, carries
// lumps and votes over, hides (never deletes) the rest, and can be undone exactly.
import './helpers/as-indexer.js';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { q, insertTrack, makeUser, closeAdmin } from './helpers/db.js';

let ids = {}, users = {}, lumps = {}, snap;
const SRC = 'jamendo';
before(async () => {
  const D = { source: SRC, artist_name: 'Dupe Artist', title: 'Dupe & Song', duration_seconds: 201 };
  ids.loser1 = await insertTrack({ ...D, external_id: 'dd-1', artwork_url: null, genre: null });
  ids.keeper = await insertTrack({ ...D, external_id: 'dd-2', title: 'the dupe and song', artwork_url: 'https://x/a.jpg', genre: 'jazz' });
  ids.loser2 = await insertTrack({ ...D, external_id: 'dd-3', artist_name: 'DUPE ARTIST ', artwork_url: null, genre: 'jazz' });
  ids.otherDuration = await insertTrack({ ...D, external_id: 'dd-4', duration_seconds: 202 });
  ids.otherSource = await insertTrack({ ...D, external_id: 'dd-5', source: 'ccmixter' });
  ids.nullDur1 = await insertTrack({ ...D, external_id: 'dd-6', duration_seconds: null });
  ids.nullDur2 = await insertTrack({ ...D, external_id: 'dd-7', duration_seconds: null });
  ids.live1 = await insertTrack({ ...D, external_id: 'dd-8', source: 'archive_livemusic' });
  ids.live2 = await insertTrack({ ...D, external_id: 'dd-9', source: 'archive_livemusic' });
  ids.filler = await insertTrack({ external_id: 'dd-10', title: 'Filler' });
  users.a = await makeUser(); users.b = await makeUser();
  const L1 = await q(`INSERT INTO user_lumps (user_id, name) VALUES (?, 'L1')`, [users.a.id]);
  const L2 = await q(`INSERT INTO user_lumps (user_id, name) VALUES (?, 'L2')`, [users.b.id]);
  lumps = { L1: L1.insertId, L2: L2.insertId };
  await q(`INSERT INTO lump_tracks (lump_id, track_id, position) VALUES (?, ?, 1), (?, ?, 2)`, [lumps.L1, ids.filler, lumps.L1, ids.loser1]);
  await q(`INSERT INTO lump_tracks (lump_id, track_id, position) VALUES (?, ?, 1), (?, ?, 2)`, [lumps.L2, ids.keeper, lumps.L2, ids.loser2]);
  await q(`INSERT INTO votes (user_id, track_id, direction) VALUES (?, ?, 1), (?, ?, -1), (?, ?, 1)`,
    [users.a.id, ids.loser1, users.b.id, ids.loser2, users.b.id, ids.keeper]);
  // Counters as the API keeps them (recounted from votes on every vote).
  await q(`UPDATE tracks t SET upvotes = (SELECT COUNT(*) FROM votes WHERE track_id = t.id AND direction = 1),
           downvotes = (SELECT COUNT(*) FROM votes WHERE track_id = t.id AND direction = -1) WHERE t.id IN (?)`, [Object.values(ids)]);
  snap = await snapshot();
});
after(async () => {
  await closeAdmin();
  const { pool } = await import('../db.js');
  await pool.end();
});

async function snapshot() {
  const all = Object.values(ids);
  return {
    lt: await q(`SELECT * FROM lump_tracks WHERE lump_id IN (?) ORDER BY id`, [Object.values(lumps)]),
    votes: await q(`SELECT * FROM votes WHERE user_id IN (?) ORDER BY id`, [[users.a.id, users.b.id]]),
    tracks: await q(`SELECT id, hidden_at, hidden_reason, duplicate_of, upvotes, downvotes FROM tracks WHERE id IN (?) ORDER BY id`, [all]),
  };
}

test('dry run plans the group, writes a CSV and changes nothing', async () => {
  const { planDedupe, writePlanCsv } = await import('../scripts/dedupe-within-source.js');
  const { query } = await import('../db.js');
  const plan = await planDedupe({ query, sources: [SRC, 'ccmixter', 'archive_livemusic'] });
  const mine = plan.groups.filter((g) => [ids.keeper, ids.loser1, ids.loser2].includes(g.keeper));
  assert.equal(mine.length, 1);
  assert.equal(mine[0].keeper, ids.keeper);
  assert.deepEqual(mine[0].losers.sort(), [ids.loser1, ids.loser2].sort());
  assert.ok(!plan.groups.some((g) => g.source === 'archive_livemusic'), 'livemusic excluded by default');
  const all = new Set(plan.groups.flatMap((g) => [g.keeper, ...g.losers]));
  for (const k of ['otherDuration', 'otherSource', 'nullDur1', 'nullDur2', 'live1', 'live2']) assert.equal(all.has(ids[k]), false, k);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dd-')), 'plan.csv');
  writePlanCsv(plan, file);
  const csv = fs.readFileSync(file, 'utf8');
  assert.match(csv, /^source,group_key,keeper_id,loser_id,/);
  assert.ok(csv.includes(String(ids.loser1)));
  assert.deepEqual(await snapshot(), snap);
});

test('livemusic can be planned explicitly for review (dry-run CSV for the owner)', async () => {
  const { planDedupe } = await import('../scripts/dedupe-within-source.js');
  const { query } = await import('../db.js');
  const plan = await planDedupe({ query, sources: ['archive_livemusic'], includeLivemusic: true });
  assert.ok(plan.groups.some((g) => [ids.live1, ids.live2].includes(g.keeper)));
});

test('apply hides losers, carries lumps and votes over, recounts; undo restores the earlier state', async () => {
  const { planDedupe, applyDedupe, undoDedupe } = await import('../scripts/dedupe-within-source.js');
  const { query, pool } = await import('../db.js');
  const plan = await planDedupe({ query, sources: [SRC] });
  plan.groups = plan.groups.filter((g) => g.keeper === ids.keeper);
  const runId = await applyDedupe({ pool, plan });

  const t = Object.fromEntries((await q(`SELECT id, hidden_reason, duplicate_of, is_live, upvotes, downvotes FROM tracks WHERE id IN (?)`,
    [[ids.keeper, ids.loser1, ids.loser2]])).map((r) => [r.id, r]));
  for (const l of [ids.loser1, ids.loser2]) {
    assert.equal(t[l].hidden_reason, 'duplicate'); assert.equal(t[l].duplicate_of, ids.keeper); assert.equal(t[l].is_live, 0);
  }
  assert.equal(t[ids.keeper].is_live, 1);
  // L1: loser1 at position 2 now points at the keeper, same position.
  const l1 = await q(`SELECT track_id, position FROM lump_tracks WHERE lump_id = ? ORDER BY position`, [lumps.L1]);
  assert.deepEqual(l1.map((r) => [r.track_id, r.position]), [[ids.filler, 1], [ids.keeper, 2]]);
  // L2 held both: only the keeper remains.
  const l2 = await q(`SELECT track_id FROM lump_tracks WHERE lump_id = ?`, [lumps.L2]);
  assert.deepEqual(l2.map((r) => r.track_id), [ids.keeper]);
  // Votes: a's moved; b's conflicting loser vote dropped, b's keeper vote kept.
  const v = await q(`SELECT user_id, track_id, direction FROM votes WHERE track_id IN (?) ORDER BY user_id`, [[ids.keeper, ids.loser1, ids.loser2]]);
  assert.deepEqual(v.map((r) => [r.user_id, r.track_id, r.direction]), [[users.a.id, ids.keeper, 1], [users.b.id, ids.keeper, 1]]);
  assert.deepEqual([t[ids.keeper].upvotes, t[ids.keeper].downvotes], [2, 0]);

  await undoDedupe({ pool, runId });
  assert.deepEqual(await snapshot(), snap);
});

test('R2/R8: undo never reverses a later takedown, and survives a deleted lump', async () => {
  const { planDedupe, applyDedupe, undoDedupe } = await import('../scripts/dedupe-within-source.js');
  const { query, pool } = await import('../db.js');
  const D = { source: 'jamendo', artist_name: 'Undo Artist', title: 'Undo Song', duration_seconds: 305 };
  const k = await insertTrack({ ...D, external_id: 'uu-1', artwork_url: 'https://x/a.jpg' });
  const l1 = await insertTrack({ ...D, external_id: 'uu-2' });
  const l2 = await insertTrack({ ...D, external_id: 'uu-3' });
  const u = await makeUser();
  const { insertId: lump } = await q(`INSERT INTO user_lumps (user_id, name) VALUES (?, 'undo')`, [u.id]);
  await q(`INSERT INTO lump_tracks (lump_id, track_id, position) VALUES (?, ?, 1), (?, ?, 2)`, [lump, k, lump, l2]);
  const plan = await planDedupe({ query, sources: ['jamendo'] });
  plan.groups = plan.groups.filter((g) => g.keeper === k);
  const runId = await applyDedupe({ pool, plan });
  // Later: an admin takes down l1, and the lump that held l2 is deleted.
  await q(`UPDATE tracks SET hidden_reason = 'takedown', hidden_note = 'notice' WHERE id = ?`, [l1]);
  await q(`DELETE FROM user_lumps WHERE id = ?`, [lump]);
  const report = await undoDedupe({ pool, runId });
  const [r1] = await q(`SELECT hidden_reason FROM tracks WHERE id = ?`, [l1]);
  const [r2] = await q(`SELECT hidden_at, hidden_reason FROM tracks WHERE id = ?`, [l2]);
  assert.equal(r1.hidden_reason, 'takedown', 'takedown kept');
  assert.equal(r2.hidden_at, null, 'other duplicate restored');
  assert.ok(report.skipped.some((s) => s.loser_id === l1));
  assert.ok(report.skipped.some((s) => /lump/.test(s.why)));
  const logs = await q(`SELECT track_id, action FROM moderation_log WHERE actor LIKE 'script:dedupe-undo%'`);
  assert.ok(logs.some((x) => x.track_id === l2 && x.action === 'unhide'));
});
