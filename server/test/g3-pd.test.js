// Item 6 + owner decision 3: mislabelled public-domain rows are hidden with a
// reason; 1926 rows come back on 2027-01-01; the query bug is fixed.
import './helpers/as-indexer.js';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import mysql from 'mysql2/promise';
import { q, insertTrack, closeAdmin } from './helpers/db.js';
import { PLANTED, PD1926_IDS } from './db/fixtures.js';

after(async () => {
  await closeAdmin();
  const { pool } = await import('../db.js');
  await pool.end();
});
const byExt = async (ids) => q(`SELECT external_id, hidden_at, hidden_reason, pd_effective_on, license, is_live FROM tracks WHERE external_id IN (?)`, [ids]);

test('National Jukebox rows: hidden and relabelled', async () => {
  for (const r of await byExt(PLANTED.jukebox)) {
    assert.ok(r.hidden_at); assert.equal(r.hidden_reason, 'rights_loc_jukebox');
    assert.equal(r.license, 'loc-jukebox-stream-only'); assert.equal(r.is_live, 0);
  }
  const [{ n }] = await q(`SELECT COUNT(*) n FROM tracks WHERE source='loc_jukebox' AND external_id LIKE 'jukebox-%' AND hidden_at IS NULL`);
  assert.equal(Number(n), 0);
});

test('American Folklife Center rows: hidden, rights check pending, license untouched', async () => {
  for (const r of await byExt(PLANTED.afc)) {
    assert.equal(r.hidden_reason, 'rights_check_pending'); assert.equal(r.license, 'public-domain');
  }
});

test('Musopen European Archive PD rows hidden; near-misses untouched', async () => {
  for (const r of await byExt(PLANTED.musopenEA)) assert.equal(r.hidden_reason, 'rights_musopen_european_archive');
  for (const r of await byExt([...PLANTED.musopenEAnotPD, ...PLANTED.musopenOther])) {
    assert.equal(r.hidden_at, null); assert.equal(r.is_live, 1);
  }
});

test('1926 rows hidden until 2027-01-01; a 1925 row untouched', async () => {
  const rows = await byExt(PLANTED.pd1926);
  assert.equal(rows.length, 3);
  for (const r of rows) {
    assert.equal(r.hidden_reason, 'pd_not_yet_1926');
    assert.equal(r.pd_effective_on.toISOString().slice(0, 10), '2027-01-01');
  }
  const [ok] = await byExt(PLANTED.pd1925);
  assert.equal(ok.hidden_at, null);
  // Owner decision (follow-up 4): archive_subjects rows from 1926 items join the set.
  for (const r of await byExt(PLANTED.subjects1926)) {
    assert.equal(r.hidden_reason, 'pd_not_yet_1926');
    assert.equal(r.pd_effective_on.toISOString().slice(0, 10), '2027-01-01');
    assert.equal(r.license, 'cc-by-sa', 'uploader label kept');
  }
});

test('unhide script: nothing on 2026-12-31, only the 1926 rows on 2027-01-01, dry-run by default', async () => {
  const { unhidePdEffective } = await import('../scripts/unhide-pd-effective.js');
  const { query } = await import('../db.js');
  let r = await unhidePdEffective({ query, today: '2026-12-31', apply: true });
  assert.equal(r.unhidden, 0);
  r = await unhidePdEffective({ query, today: '2027-01-01', apply: false });
  assert.equal(r.eligible, 4, '3 archive_pd78s + 1 archive_subjects'); assert.equal(r.unhidden, 0);
  assert.equal((await byExt(PLANTED.pd1926)).filter((x) => x.hidden_at).length, 3);
  r = await unhidePdEffective({ query, today: '2027-01-01', apply: true });
  assert.equal(r.unhidden, 4);
  for (const x of await byExt(PLANTED.pd1926)) { assert.equal(x.hidden_at, null); assert.equal(x.is_live, 1); }
  for (const x of await byExt([...PLANTED.jukebox, ...PLANTED.afc, ...PLANTED.musopenEA])) assert.ok(x.hidden_at, 'other reasons stay hidden');
});

test('the pd78s query bug is fixed: cutoff by year, inclusive of the last PD year only', async () => {
  const { pdCutoffYear, buildSearchQuery } = await import('../services/archive_pd78s.js');
  assert.equal(pdCutoffYear(new Date('2026-10-25T12:00:00Z')), 1925);
  assert.equal(pdCutoffYear(new Date('2027-01-01T12:00:00Z')), 1926);
  const qs = buildSearchQuery(new Date('2026-10-25T12:00:00Z'));
  assert.match(qs, /date:\[\* TO 1925-12-31\]/);
  assert.doesNotMatch(qs, /1926/);
});

test('re-ingest cannot bring these rows back as PD: resolvers label and hide', async () => {
  const loc = await import('../services/loc_jukebox.js');
  const j = loc.locLicenseFor('jukebox-123');
  assert.deepEqual(j, { license: 'loc-jukebox-stream-only', hidden_reason: 'rights_loc_jukebox' });
  assert.deepEqual(loc.locLicenseFor('2017655315'), { license: 'public-domain', hidden_reason: 'rights_check_pending' });
  const { musopenHiddenReason } = await import('../services/musopen.js');
  assert.equal(musopenHiddenReason({ artist_name: 'X (European Archive)', license: 'PUBLIC DOMAIN' }), 'rights_musopen_european_archive');
  assert.equal(musopenHiddenReason({ artist_name: 'Musopen Symphony', license: 'PUBLIC DOMAIN' }), null);
  // The indexer stores hidden_reason on INSERT only, never on update.
  const { upsertTrack } = await import('../indexer/index.js');
  await upsertTrack({ external_id: 'jukebox-777777', source: 'loc_jukebox', title: 'T', artist_name: 'A', stream_url: 'https://tile.loc.gov/x.mp3', ...j });
  const [row] = await q(`SELECT hidden_reason, hidden_at, license FROM tracks WHERE external_id = 'jukebox-777777'`);
  assert.equal(row.hidden_reason, 'rights_loc_jukebox'); assert.ok(row.hidden_at);
});

test('the committed 1926 list is the one migration 018 uses', () => {
  const mig = fs.readFileSync(new URL('../migrations/018_relaunch_hide_mislabelled_pd.sql', import.meta.url), 'utf8');
  const inMig = [...mig.matchAll(/^\s*\('([^']+)'\)[,;]$/gm)].map((m) => m[1].replace(/''/g, "'"));
  assert.deepEqual(inMig, PD1926_IDS);
  assert.equal(PD1926_IDS.length, 3192);
});

test('ceilings: migration 018 aborts, changing nothing, when a predicate matches far too many rows', async () => {
  const DB = 'lumpylp_ceiling_test';
  const server = path.resolve(new URL('..', import.meta.url).pathname);
  const c = await mysql.createConnection({ host: '127.0.0.1', port: 33306, user: 'root', password: '', multipleStatements: true });
  try {
    await c.query(`DROP DATABASE IF EXISTS ${DB}; CREATE DATABASE ${DB}; USE ${DB}`);
    await c.query('SET FOREIGN_KEY_CHECKS=0;' + fs.readFileSync(path.join(server, 'db/schema.sql'), 'utf8'));
    const rows = Array.from({ length: 2600 }, (_, i) => [`ea-${i}`, 'musopen', 't', 'Orchestra (European Archive)', 'public-domain', 'https://dl.musopen.org/x.mp3']);
    await c.query(`INSERT INTO tracks (external_id, source, title, artist_name, license, stream_url) VALUES ?`, [rows]);
    await c.query(`INSERT INTO tracks (external_id, source, title, artist_name, license, stream_url) VALUES ('jukebox-1','loc_jukebox','t','a','public-domain','x')`);
    for (const m of ['015_relaunch_users_role_token_version.sql', '016_relaunch_drop_stripe.sql', '017_relaunch_hidden_tracks.sql']) {
      await c.query(fs.readFileSync(path.join(server, 'migrations', m), 'utf8'));
    }
    await assert.rejects(c.query(fs.readFileSync(path.join(server, 'migrations/018_relaunch_hide_mislabelled_pd.sql'), 'utf8')),
      (e) => e.errno === 3141 || assert.fail(`${e.errno} ${e.message}`));
    await c.query('ROLLBACK');
    const [[{ n }]] = await c.query(`SELECT COUNT(*) n FROM tracks WHERE hidden_at IS NOT NULL`);
    assert.equal(Number(n), 0, 'nothing hidden, including the jukebox row hidden before the failing step');
  } finally {
    await c.query(`DROP DATABASE IF EXISTS ${DB}`);
    await c.end();
  }
});

test('indexer cleanup hides noise-genre tracks and never deletes rows (runs as lumpylp_indexer)', async () => {
  const id = await insertTrack({ genre: 'audiobook chapter', title: 'Noise Probe' });
  const [{ n: before }] = await q(`SELECT COUNT(*) n FROM tracks`);
  const { cleanupNoise } = await import('../indexer/index.js');
  await cleanupNoise();
  const [{ n: afterCount }] = await q(`SELECT COUNT(*) n FROM tracks`);
  assert.equal(Number(afterCount), Number(before));
  const [row] = await q(`SELECT hidden_reason, is_live FROM tracks WHERE id = ?`, [id]);
  assert.deepEqual([row.hidden_reason, row.is_live], ['quality', 0]);
});

test('R1: migration 018 runs end to end on a database whose default collation differs from tracks', async () => {
  const DB = 'lumpylp_collation_test';
  const server = path.resolve(new URL('..', import.meta.url).pathname);
  const c = await mysql.createConnection({ host: '127.0.0.1', port: 33306, user: 'root', password: '', multipleStatements: true });
  try {
    await c.query(`DROP DATABASE IF EXISTS ${DB}; CREATE DATABASE ${DB} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci; USE ${DB}`);
    await c.query('SET FOREIGN_KEY_CHECKS=0;' + fs.readFileSync(path.join(server, 'db/schema.sql'), 'utf8'));
    await c.query(`INSERT INTO tracks (external_id, source, title, artist_name, license, stream_url) VALUES (?, 'archive_pd78s', 't', 'a', 'public-domain', 'x')`,
      [`${PD1926_IDS[0]}:01 side a`]);
    for (const m of ['015_relaunch_users_role_token_version.sql', '016_relaunch_drop_stripe.sql', '017_relaunch_hidden_tracks.sql', '018_relaunch_hide_mislabelled_pd.sql']) {
      await c.query(fs.readFileSync(path.join(server, 'migrations', m), 'utf8'));
    }
    const [[r]] = await c.query(`SELECT hidden_reason FROM tracks`);
    assert.equal(r.hidden_reason, 'pd_not_yet_1926');
  } finally {
    await c.query(`DROP DATABASE IF EXISTS ${DB}`);
    await c.end();
  }
});
