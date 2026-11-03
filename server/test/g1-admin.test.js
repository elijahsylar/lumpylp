// Item 1: /api/admin/* requires an admin role, checked server-side on every request.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, req } from './helpers/app.js';
import { q, makeUser, closeAdmin } from './helpers/db.js';

let app, user, adminUser;
before(async () => {
  app = await startApp();
  user = await makeUser();
  adminUser = await makeUser({ role: 'admin' });
});
after(async () => { await app.close(); await closeAdmin(); });

// Every route the admin router declares, read from the router itself so a
// newly added admin route is covered automatically.
async function adminRoutes() {
  const { default: router } = await import('../routes/admin.js');
  const out = [];
  for (const layer of router.stack) {
    if (!layer.route) continue;
    for (const m of Object.keys(layer.route.methods)) {
      out.push([m.toUpperCase(), '/api/admin' + layer.route.path.replace(':id', '1')]);
    }
  }
  assert.ok(out.length >= 2, 'admin router should expose routes');
  return out;
}

test('no token: 401 on every admin route', async () => {
  for (const [method, path] of await adminRoutes()) {
    const r = await req(app.base, path, { method, json: method === 'GET' ? undefined : { reason: 'admin' } });
    assert.equal(r.status, 401, `${method} ${path}`);
  }
});

test('normal user: 403 on every admin route', async () => {
  for (const [method, path] of await adminRoutes()) {
    const r = await req(app.base, path, { method, token: user.token, json: method === 'GET' ? undefined : { reason: 'admin' } });
    assert.equal(r.status, 403, `${method} ${path}`);
  }
});

test('admin: 200 on track-health', async () => {
  const r = await req(app.base, '/api/admin/track-health', { token: adminUser.token });
  assert.equal(r.status, 200);
  assert.equal(typeof r.body.total, 'number');
});

test('the hard-delete route is gone, even for an admin', async () => {
  const r = await req(app.base, '/api/admin/tracks/dead?confirm=YES', { method: 'DELETE', token: adminUser.token });
  assert.equal(r.status, 404);
});

test('role is read from the DB on each request (promote and demote)', async () => {
  const u = await makeUser();
  assert.equal((await req(app.base, '/api/admin/track-health', { token: u.token })).status, 403);
  await q(`UPDATE users SET role = 'admin' WHERE id = ?`, [u.id]);
  assert.equal((await req(app.base, '/api/admin/track-health', { token: u.token })).status, 200);
  await q(`UPDATE users SET role = 'user' WHERE id = ?`, [u.id]);
  assert.equal((await req(app.base, '/api/admin/track-health', { token: u.token })).status, 403);
});
