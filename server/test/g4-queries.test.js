// Item 8: the rewritten listing, search and shuffle queries keep their
// behaviour. Speed is measured separately by test/perf/perf.js at production
// scale; these check correctness on the small DB.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startApp, req } from './helpers/app.js';
import { q, insertTrack, closeAdmin } from './helpers/db.js';

let app, ids = {};
before(async () => {
  process.env.RATE_LIMITS = JSON.stringify({ api: 1e9, search: 1e9, stream: 1e9, discover: 1e9 });
  app = await startApp();
  ids.a = await insertTrack({ title: 'Quokka Lantern', artist_name: 'Zyx Band', genre: 'g4genre' });
  ids.b = await insertTrack({ title: 'Quokka Harbor', artist_name: 'Zyx Band', genre: 'g4genre' });
  ids.dead = await insertTrack({ title: 'Quokka Ghost', artist_name: 'Zyx Band', genre: 'g4genre' });
  await q(`UPDATE tracks SET is_dead = 1, dead_marked_at = NOW() WHERE id = ?`, [ids.dead]);
  ids.hidden = await insertTrack({ title: 'Quokka Hidden', artist_name: 'Zyx Band', genre: 'g4genre' });
  await q(`UPDATE tracks SET hidden_at = NOW(), hidden_reason = 'admin' WHERE id = ?`, [ids.hidden]);
  ids.the = await insertTrack({ title: 'The Wombat', artist_name: 'Ab Trio' });
});
after(async () => { await app.close(); await closeAdmin(); });

const liveIds = (body) => (body.tracks || []).map((t) => t.id);

test('pages beyond 500 are refused; totals report whether they were capped', async () => {
  assert.equal((await req(app.base, '/api/tracks?page=501')).status, 400);
  assert.equal((await req(app.base, '/api/search?q=quokka&page=51')).status, 400, 'search stops at page 50');
  assert.equal((await req(app.base, '/api/search?q=quokka&page=50')).status, 200);
  const r = await req(app.base, '/api/tracks');
  assert.equal(r.status, 200);
  assert.equal(typeof r.body.total, 'number');
  assert.equal(r.body.total_capped, false);
});

test('search: words, prefixes, short queries, stopwords and operator junk', async () => {
  let r = await req(app.base, '/api/search?q=quokka');
  assert.deepEqual(liveIds(r.body).sort(), [ids.a, ids.b].sort(), 'live matches only');
  r = await req(app.base, '/api/search?q=quok');
  assert.ok(liveIds(r.body).includes(ids.a), 'prefix match');
  r = await req(app.base, '/api/search?q=quokka%20lantern');
  assert.deepEqual(liveIds(r.body), [ids.a], 'all words required');
  r = await req(app.base, '/api/search?q=Ab');
  assert.ok(liveIds(r.body).includes(ids.the), 'short query: prefix on title or artist');
  r = await req(app.base, '/api/search?q=the');
  assert.equal(r.status, 200);
  assert.ok(liveIds(r.body).includes(ids.the), 'stopword-only query falls back to prefix');
  for (const junk of ['%2B-*', '%22', '()', '%40%40']) {
    r = await req(app.base, `/api/search?q=${junk}`);
    assert.equal(r.status, 200, junk);
  }
  r = await req(app.base, '/api/search?q=quokka&sort=title_asc');
  assert.deepEqual(liveIds(r.body), [ids.b, ids.a]);
});

test('shuffle and random only ever return live tracks, and respect filters', async () => {
  for (let i = 0; i < 5; i++) {
    const r = await req(app.base, '/api/tracks/shuffle?genre=g4genre&n=10');
    assert.deepEqual(liveIds(r.body).sort(), [ids.a, ids.b].sort());
  }
  const ex = await req(app.base, `/api/tracks/shuffle?genre=g4genre&n=10&exclude=${ids.a}`);
  assert.deepEqual(liveIds(ex.body), [ids.b]);
  const all = await req(app.base, '/api/tracks/shuffle?n=50');
  assert.equal(all.body.tracks.length, 50);
  assert.equal(new Set(liveIds(all.body)).size, 50, 'no repeats');
  const [{ n }] = await q(`SELECT COUNT(*) n FROM tracks WHERE id IN (?) AND is_live = 0`, [liveIds(all.body)]);
  assert.equal(Number(n), 0);
  for (let i = 0; i < 10; i++) {
    const r = await req(app.base, '/api/tracks/random');
    const [row] = await q(`SELECT is_live FROM tracks WHERE id = ?`, [r.body.id]);
    assert.equal(row.is_live, 1);
  }
});

test('alpha sort is by title, then id', async () => {
  const r = await req(app.base, '/api/tracks?genre=g4genre&sort=alpha');
  assert.deepEqual(liveIds(r.body), [ids.b, ids.a]);
});

test('no ORDER BY RAND() is left in the API', () => {
  for (const f of ['../routes/tracks.js', '../routes/discover.js', '../routes/artists.js', '../app.js']) {
    assert.doesNotMatch(fs.readFileSync(new URL(f, import.meta.url), 'utf8'), /ORDER BY RAND\(\)/i, f);
  }
});
