// PATCH /api/lumps/:id/tracks/reorder must get each of the lump's tracks once.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, req } from './helpers/app.js';
import { q, makeUser, closeAdmin } from './helpers/db.js';

let app, user, lumpId, ids;
before(async () => {
  process.env.RATE_LIMITS = JSON.stringify({ lumpWrites: 1000 });
  app = await startApp();
  user = await makeUser();
  const made = await req(app.base, '/api/lumps', { method: 'POST', token: user.token, json: { name: `reorder ${process.pid}` } });
  assert.equal(made.status, 201);
  lumpId = made.body.lump.id;
  ids = (await q('SELECT id FROM tracks WHERE is_live = 1 ORDER BY id LIMIT 3')).map((r) => r.id);
  for (const id of ids) {
    const add = await req(app.base, `/api/lumps/${lumpId}/tracks`, { method: 'POST', token: user.token, json: { track_id: id } });
    assert.equal(add.status, 201);
  }
});
after(async () => { await app.close(); await closeAdmin(); });

const reorder = (track_ids) => req(app.base, `/api/lumps/${lumpId}/tracks/reorder`, { method: 'PATCH', token: user.token, json: { track_ids } });

test('a full reorder is applied', async () => {
  const [a, b, c] = ids;
  assert.equal((await reorder([c, a, b])).status, 200);
  const rows = await q('SELECT track_id FROM lump_tracks WHERE lump_id = ? ORDER BY position', [lumpId]);
  assert.deepEqual(rows.map((r) => r.track_id), [c, a, b]);
});

test('a repeated id is refused and the order is unchanged', async () => {
  const [a, b] = ids;
  const before = await q('SELECT track_id, position FROM lump_tracks WHERE lump_id = ? ORDER BY position', [lumpId]);
  const r = await reorder([a, a, b]);
  assert.equal(r.status, 400);
  assert.deepEqual(await q('SELECT track_id, position FROM lump_tracks WHERE lump_id = ? ORDER BY position', [lumpId]), before);
});
