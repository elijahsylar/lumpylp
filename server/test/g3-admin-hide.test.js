// Item 14: admins can hide a track quickly with a reason; logged; reversible.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { startApp, req } from './helpers/app.js';
import { q, insertTrack, makeUser, closeAdmin } from './helpers/db.js';

let app, admin, user;
before(async () => {
  process.env.RATE_LIMITS = JSON.stringify({ api: 100000, search: 100000 });
  app = await startApp();
  admin = await makeUser({ role: 'admin' });
  user = await makeUser();
});
after(async () => { await app.close(); await closeAdmin(); });

const visible = async (id) => {
  const r = await req(app.base, '/api/search?q=Takedowncheck');
  return r.body.tracks.some((t) => t.id === id);
};

test('hide removes a track from listings and streams; unhide restores it; both are logged', async () => {
  const id = await insertTrack({ title: 'Takedowncheck Song' });
  assert.equal(await visible(id), true);
  const h = await req(app.base, `/api/admin/tracks/${id}/hide`, { method: 'POST', token: admin.token, json: { reason: 'takedown', note: 'notice 2026-10-25' } });
  assert.equal(h.status, 200);
  assert.equal(await visible(id), false);
  assert.equal((await req(app.base, `/api/stream/${id}`)).status, 410);
  assert.equal((await req(app.base, `/api/tracks/${id}`)).status, 404);
  const list = await req(app.base, '/api/admin/tracks/hidden?reason=takedown', { token: admin.token });
  assert.ok(list.body.tracks.some((t) => t.id === id && t.hidden_reason === 'takedown'));
  const u = await req(app.base, `/api/admin/tracks/${id}/unhide`, { method: 'POST', token: admin.token, json: {} });
  assert.equal(u.status, 200);
  assert.equal(await visible(id), true);
  const log = await q(`SELECT action, reason, note, user_id FROM moderation_log WHERE track_id = ? ORDER BY id`, [id]);
  assert.deepEqual(log.map((l) => [l.action, l.reason, l.note, l.user_id]),
    [['hide', 'takedown', 'notice 2026-10-25', admin.id], ['unhide', null, null, admin.id]]);
});

test('invalid reason 400, unknown track 404, normal user 403', async () => {
  const id = await insertTrack();
  assert.equal((await req(app.base, `/api/admin/tracks/${id}/hide`, { method: 'POST', token: admin.token, json: { reason: 'because' } })).status, 400);
  assert.equal((await req(app.base, `/api/admin/tracks/${id}/hide`, { method: 'POST', token: admin.token, json: { reason: 'takedown', note: 'x'.repeat(300) } })).status, 400);
  assert.equal((await req(app.base, `/api/admin/tracks/999999999/hide`, { method: 'POST', token: admin.token, json: { reason: 'takedown' } })).status, 404);
  assert.equal((await req(app.base, `/api/admin/tracks/${id}/hide`, { method: 'POST', token: user.token, json: { reason: 'takedown' } })).status, 403);
});

test('the CLI hides a track when the API is down', async () => {
  const id = await insertTrack({ title: 'Takedowncheck Cli' });
  const r = spawnSync(process.execPath, ['scripts/hide-track.js', String(id), '--reason=takedown', '--note=cli test'],
    { cwd: new URL('..', import.meta.url).pathname, env: { ...process.env }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const [row] = await q(`SELECT hidden_reason, hidden_note FROM tracks WHERE id = ?`, [id]);
  assert.deepEqual([row.hidden_reason, row.hidden_note], ['takedown', 'cli test']);
  const [log] = await q(`SELECT actor, action FROM moderation_log WHERE track_id = ?`, [id]);
  assert.match(log.actor, /^cli:/);
});
