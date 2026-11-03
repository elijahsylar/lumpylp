// Item 5: only the sweep marks tracks dead; one flag; dead tracks never served.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startApp, req } from './helpers/app.js';
import { q, insertTrack, closeAdmin } from './helpers/db.js';
import { PLANTED } from './db/fixtures.js';

let app;
before(async () => {
  process.env.RATE_LIMITS = JSON.stringify({ api: 100000, stream: 100000, search: 100000 });
  app = await startApp();
});
after(async () => { await app.close(); await closeAdmin(); });

test('migration 017 made the dead flags agree (no is_dead row without dead_marked_at)', async () => {
  const [{ n }] = await q(`SELECT COUNT(*) n FROM tracks WHERE is_dead = 1 AND dead_marked_at IS NULL`);
  assert.equal(Number(n), 0);
  const rows = await q(`SELECT is_dead, dead_marked_at, dead_reason, is_live FROM tracks WHERE external_id IN (?)`, [PLANTED.dead]);
  assert.equal(rows.length, 3);
  for (const r of rows) {
    assert.equal(r.is_dead, 1);
    assert.ok(r.dead_marked_at);
    assert.equal(r.dead_reason, 'sweep_404');
    assert.equal(r.is_live, 0);
  }
});

test('the stream route writes nothing to the database', async () => {
  const src = fs.readFileSync(new URL('../routes/tracks.js', import.meta.url), 'utf8');
  const streamPart = src.slice(src.indexOf('export const streamRouter'));
  assert.doesNotMatch(streamPart, /UPDATE\s+tracks|INSERT\s+INTO|markPlay/i);
});

test('20 aborted or completed stream requests leave the row unchanged', async () => {
  const id = await insertTrack({ title: 'Abort Probe' });
  const [before] = await q(`SELECT * FROM tracks WHERE id = ?`, [id]);
  for (let i = 0; i < 20; i++) {
    const ac = new AbortController();
    const p = fetch(`${app.base}/api/stream/${id}`, { redirect: 'manual', signal: ac.signal }).catch(() => {});
    if (i % 2) ac.abort();
    await p;
  }
  const [after] = await q(`SELECT * FROM tracks WHERE id = ?`, [id]);
  assert.deepEqual(after, before);
});

test('a dead track is gone from every listing and its stream returns 410', async () => {
  const id = await insertTrack({ title: 'Deadcheck Zebra', genre: 'zebra-genre', upvotes: 9 });
  await q(`UPDATE tracks SET is_dead = 1, dead_marked_at = NOW(), dead_reason = 'sweep_404' WHERE id = ?`, [id]);
  const paths = ['/api/tracks?genre=zebra-genre', '/api/tracks?sort=heap', '/api/tracks/top', '/api/search?q=Deadcheck',
    '/api/tracks/shuffle?genre=zebra-genre&n=100'];
  for (const p of paths) {
    const r = await req(app.base, p);
    assert.equal(r.status, 200, p);
    assert.equal(JSON.stringify(r.body).includes(`"id":${id},`), false, p);
  }
  assert.equal((await req(app.base, `/api/tracks/${id}`)).status, 404);
  assert.equal((await req(app.base, `/api/stream/${id}`)).status, 410);
});

