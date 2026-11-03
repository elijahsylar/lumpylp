// Baseline API behaviour on synthetic data: the floor every later gate builds on.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, req } from './helpers/app.js';
import { closeAdmin } from './helpers/db.js';

let app;
before(async () => { app = await startApp(); });
after(async () => { await app.close(); await closeAdmin(); });

test('health', async () => {
  const r = await req(app.base, '/api/health');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true });
});

test('track list returns a page of tracks', async () => {
  const r = await req(app.base, '/api/tracks');
  assert.equal(r.status, 200);
  assert.equal(r.body.tracks.length, 20);
  for (const t of r.body.tracks) assert.ok(t.id && t.title && t.artist_name && t.source);
});

test('track detail and search work', async () => {
  const list = await req(app.base, '/api/tracks');
  const t = list.body.tracks[0];
  const one = await req(app.base, `/api/tracks/${t.id}`);
  assert.equal(one.status, 200);
  assert.equal(one.body.id, t.id);
  const word = t.title.split(' ')[0];
  const s = await req(app.base, `/api/search?q=${encodeURIComponent(word)}`);
  assert.equal(s.status, 200);
  assert.ok(s.body.tracks.length > 0);
});
