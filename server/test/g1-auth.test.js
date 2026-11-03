// Items 3 and 15: free signup with Turnstile, Stripe gone, token revocation,
// bcrypt limits, no cookie auth, no paid_at gate.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import jwt from 'jsonwebtoken';
import { startApp, req } from './helpers/app.js';
import { q, makeUser, closeAdmin } from './helpers/db.js';

let app, stub, stubCalls = [];
before(async () => {
  // Local stand-in for Cloudflare's siteverify endpoint.
  stub = http.createServer((rq, rs) => {
    let body = '';
    rq.on('data', (c) => { body += c; });
    rq.on('end', () => {
      const p = new URLSearchParams(body);
      stubCalls.push({ secret: p.get('secret'), response: p.get('response') });
      rs.setHeader('content-type', 'application/json');
      rs.end(JSON.stringify({ success: p.get('response') === 'good-token' && p.get('secret') === 'turnstile-test-secret' }));
    });
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  process.env.TURNSTILE_VERIFY_URL = `http://127.0.0.1:${stub.address().port}/siteverify`;
  process.env.TURNSTILE_SECRET_KEY = 'turnstile-test-secret';
  process.env.TURNSTILE_SITE_KEY = 'turnstile-test-site-key';
  process.env.RATE_LIMITS = JSON.stringify({ signup: 1000, login: 1000, loginFailures: 1000, password: 1000 });
  app = await startApp();
});
after(async () => { await app.close(); await closeAdmin(); stub.close(); });

const signup = (json) => req(app.base, '/api/auth/signup', { method: 'POST', json });
let n = 0;
const fresh = () => { n += 1; return { email: `new${process.pid}x${n}@example.test`, username: `new${process.pid}x${n}`, password: 'a decent password', turnstile_token: 'good-token' }; };

test('signup creates a free account and returns a working token', async () => {
  const body = fresh();
  const r = await signup(body);
  assert.equal(r.status, 201);
  assert.ok(r.body.token);
  assert.equal(r.body.user.username, body.username);
  assert.equal('paid_at' in r.body.user, false);
  const me = await req(app.base, '/api/auth/me', { token: r.body.token });
  assert.equal(me.status, 200);
  assert.equal(stubCalls.at(-1).secret, 'turnstile-test-secret');
});

test('signup without or with a bad Turnstile token is refused', async () => {
  const a = fresh(); delete a.turnstile_token;
  assert.equal((await signup(a)).status, 400);
  const b = { ...fresh(), turnstile_token: 'bad-token' };
  assert.equal((await signup(b)).status, 403);
  const [{ c }] = await q(`SELECT COUNT(*) c FROM users WHERE username IN (?, ?)`, [a.username, b.username]);
  assert.equal(Number(c), 0);
});

test('signup fails closed (503) when no Turnstile secret is configured', async () => {
  const saved = process.env.TURNSTILE_SECRET_KEY;
  delete process.env.TURNSTILE_SECRET_KEY;
  try { assert.equal((await signup(fresh())).status, 503); }
  finally { process.env.TURNSTILE_SECRET_KEY = saved; }
});

test('duplicate email and duplicate username get the same generic 409', async () => {
  const body = fresh();
  assert.equal((await signup(body)).status, 201);
  const dupEmail = await signup({ ...fresh(), email: body.email });
  const dupUser = await signup({ ...fresh(), username: body.username });
  assert.equal(dupEmail.status, 409);
  assert.equal(dupUser.status, 409);
  assert.deepEqual(dupEmail.body, dupUser.body);
});

test('password length: under 8 and over 72 bytes are rejected', async () => {
  assert.equal((await signup({ ...fresh(), password: 'short' })).status, 400);
  assert.equal((await signup({ ...fresh(), password: 'é'.repeat(40) })).status, 400); // 80 bytes
  assert.equal((await signup({ ...fresh(), password: 'a'.repeat(72) })).status, 201);
});

test('new password hashes use bcrypt cost 12', async () => {
  const body = fresh();
  await signup(body);
  const [row] = await q(`SELECT password_hash FROM users WHERE username = ?`, [body.username]);
  assert.match(row.password_hash, /^\$2[aby]\$12\$/);
});

test('login works with no paid_at, and fails generically', async () => {
  const u = await makeUser({ password: 'pw for login test' });
  await q(`UPDATE users SET paid_at = NULL WHERE id = ?`, [u.id]);
  const ok = await req(app.base, '/api/auth/login', { method: 'POST', json: { emailOrUsername: u.username, password: 'pw for login test' } });
  assert.equal(ok.status, 200);
  const bad1 = await req(app.base, '/api/auth/login', { method: 'POST', json: { emailOrUsername: u.username, password: 'wrong' } });
  const bad2 = await req(app.base, '/api/auth/login', { method: 'POST', json: { emailOrUsername: 'nobody-here', password: 'wrong' } });
  assert.equal(bad1.status, 401);
  assert.deepEqual(bad1.body, bad2.body);
  // Lumps work without paid_at.
  const lumps = await req(app.base, '/api/lumps', { token: ok.body.token });
  assert.equal(lumps.status, 200);
});

test('tokens last 7 days', async () => {
  const u = await makeUser();
  const p = jwt.decode(u.token);
  assert.equal(p.exp - p.iat, 7 * 24 * 3600);
});

test('changing the password revokes existing tokens', async () => {
  const u = await makeUser({ password: 'old password here' });
  const r = await req(app.base, '/api/auth/me/password', { method: 'PATCH', token: u.token,
    json: { current_password: 'old password here', new_password: 'new password here' } });
  assert.equal(r.status, 200);
  assert.equal((await req(app.base, '/api/auth/me', { token: u.token })).status, 401);
  const login = await req(app.base, '/api/auth/login', { method: 'POST', json: { emailOrUsername: u.username, password: 'new password here' } });
  assert.equal((await req(app.base, '/api/auth/me', { token: login.body.token })).status, 200);
});

test('the legacy cookie no longer authenticates', async () => {
  const u = await makeUser();
  const r = await req(app.base, '/api/auth/me', { headers: { cookie: `lumpylp_token=${u.token}` } });
  assert.equal(r.status, 401);
});

test('Stripe endpoints are gone', async () => {
  assert.equal((await req(app.base, '/api/auth/signup-init', { method: 'POST', json: fresh() })).status, 404);
  assert.equal((await req(app.base, '/api/auth/check-pending?session_id=cs_test_x')).status, 404);
  assert.equal((await req(app.base, '/api/webhooks/stripe', { method: 'POST', json: {} })).status, 404);
});

test('pending_signups and the Stripe user columns are gone', async () => {
  assert.equal((await q(`SHOW TABLES LIKE 'pending_signups'`)).length, 0);
  const cols = (await q(`SHOW COLUMNS FROM users`)).map((c) => c.Field);
  for (const c of ['stripe_customer_id', 'stripe_payment_intent_id', 'signup_method', 'coupon_code_used']) {
    assert.equal(cols.includes(c), false, c);
  }
});
