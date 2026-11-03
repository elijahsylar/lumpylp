// Item 3: the support link comes from config and unlocks nothing.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, req } from './helpers/app.js';
import { closeAdmin } from './helpers/db.js';

let app;
before(async () => { app = await startApp(); });
after(async () => { await app.close(); await closeAdmin(); });

test('/api/config returns the support URL only when it is https', async () => {
  process.env.TURNSTILE_SITE_KEY = 'site-key-x';
  process.env.SUPPORT_URL = 'https://buy.stripe.com/test_link';
  let r = await req(app.base, '/api/config');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { support_url: 'https://buy.stripe.com/test_link', turnstile_site_key: 'site-key-x' });
  process.env.SUPPORT_URL = 'http://insecure.example/pay';
  r = await req(app.base, '/api/config');
  assert.equal(r.body.support_url, null);
  process.env.SUPPORT_URL = 'javascript:alert(1)';
  r = await req(app.base, '/api/config');
  assert.equal(r.body.support_url, null);
  delete process.env.SUPPORT_URL;
  r = await req(app.base, '/api/config');
  assert.equal(r.body.support_url, null);
});

test('CORS: no wildcard; only the configured public origin is allowed', async () => {
  const r = await req(app.base, '/api/health', { headers: { origin: 'https://evil.example' } });
  assert.notEqual(r.headers.get('access-control-allow-origin'), '*');
  assert.notEqual(r.headers.get('access-control-allow-origin'), 'https://evil.example');
});

test('the server listens on 127.0.0.1 by default', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.match(src, /process\.env\.HOST \|\| '127\.0\.0\.1'/);
});

test('no Stripe or upload code is left in the server or client source', async () => {
  const { execFileSync } = await import('node:child_process');
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  let raw = '';
  try {
    raw = execFileSync('git', ['grep', '--untracked', '-n', '-i', '-E', 'stripe|artist_upload|signup-init|paid_at',
      '--', 'server/*.js', 'server/routes', 'server/lib', 'server/middleware', 'server/scripts', 'client/src',
      ':!server/test',
      // The migration runner removes the Stripe columns, so it names them.
      ':!server/scripts/run-migration-016.sh'], { cwd: root, encoding: 'utf8' });
  } catch (err) {
    if (err.status !== 1) throw err; // git grep exits 1 when nothing matches
  }
  const out = raw.split('\n').filter(Boolean)
    // The support-link config names Stripe in a comment ("a Stripe Payment Link").
    .filter((l) => !/Payment Link/i.test(l));
  assert.deepEqual(out, []);
});
