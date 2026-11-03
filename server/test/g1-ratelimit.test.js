// Item 4: every endpoint group is rate limited; limits come from config so the
// tests use small values.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, req } from './helpers/app.js';
import { insertTrack, makeUser, closeAdmin } from './helpers/db.js';

const LIMITS = { login: 3, loginFailures: 2, signup: 2, password: 2, lumpWrites: 3, votes: 3,
  search: 3, stream: 3, discover: 2, api: 40 };
let app;
before(async () => {
  process.env.RATE_LIMITS = JSON.stringify(LIMITS);
  process.env.TURNSTILE_SECRET_KEY = 'unused-here';
  app = await startApp();
});
after(async () => { await app.close(); await closeAdmin(); });

// Fire `count` requests and return the statuses.
async function burst(count, fn) {
  const out = [];
  for (let i = 0; i < count; i++) out.push(await fn(i));
  return out;
}
function assertLimited(responses, limit, label) {
  const statuses = responses.map((r) => r.status);
  assert.ok(statuses.slice(0, limit).every((s) => s !== 429), `${label}: first ${limit} should pass: ${statuses}`);
  const last = responses[limit];
  assert.equal(last.status, 429, `${label}: request ${limit + 1} should be 429: ${statuses}`);
  assert.ok(Number(last.headers.get('retry-after')) > 0, `${label}: Retry-After`);
}

test('login: per-username failure limit', async () => {
  const u = await makeUser({ password: 'right password' });
  const rs = await burst(3, () => req(app.base, '/api/auth/login', { method: 'POST', json: { emailOrUsername: u.username, password: 'wrong' } }));
  assertLimited(rs, LIMITS.loginFailures, 'login failures');
});

test('login: per-IP limit', async () => {
  const rs = await burst(LIMITS.login + 1, (i) => req(app.base, '/api/auth/login', { method: 'POST', json: { emailOrUsername: `ip-${i}`, password: 'x' } }));
  // earlier test already used some of this IP's budget; the burst must end in 429
  assert.equal(rs.at(-1).status, 429);
});

test('signup: per-IP limit', async () => {
  const rs = await burst(LIMITS.signup + 1, (i) => req(app.base, '/api/auth/signup', { method: 'POST',
    json: { email: `rl${i}@example.test`, username: `rl${process.pid}${i}`, password: 'long enough pw', turnstile_token: 'x' } }));
  assertLimited(rs, LIMITS.signup, 'signup');
});

test('password change: per-user limit', async () => {
  const u = await makeUser({ password: 'the current pw' });
  const rs = await burst(LIMITS.password + 1, () => req(app.base, '/api/auth/me/password', { method: 'PATCH', token: u.token,
    json: { current_password: 'not it at all', new_password: 'another password' } }));
  assertLimited(rs, LIMITS.password, 'password');
});

test('lump writes: per-user limit', async () => {
  const u = await makeUser();
  const rs = await burst(LIMITS.lumpWrites + 1, (i) => req(app.base, '/api/lumps', { method: 'POST', token: u.token, json: { name: `L${i}` } }));
  assertLimited(rs, LIMITS.lumpWrites, 'lump writes');
  // a different user is not affected
  const other = await makeUser();
  assert.notEqual((await req(app.base, '/api/lumps', { method: 'POST', token: other.token, json: { name: 'mine' } })).status, 429);
});

test('votes: per-user limit', async () => {
  const u = await makeUser();
  const id = await insertTrack();
  const rs = await burst(LIMITS.votes + 1, (i) => req(app.base, `/api/tracks/${id}/vote`, { method: 'POST', token: u.token, json: { direction: i % 2 ? 1 : -1 } }));
  assertLimited(rs, LIMITS.votes, 'votes');
});

test('search: per-IP limit', async () => {
  const rs = await burst(LIMITS.search + 1, () => req(app.base, '/api/search?q=river'));
  assertLimited(rs, LIMITS.search, 'search');
});

test('stream: per-IP limit', async () => {
  const id = await insertTrack();
  const rs = await burst(LIMITS.stream + 1, () => req(app.base, `/api/stream/${id}`));
  assertLimited(rs, LIMITS.stream, 'stream');
});

test('discover cities: per-IP limit', async () => {
  const rs = await burst(LIMITS.discover + 1, () => req(app.base, '/api/discover/top-cities'));
  assertLimited(rs, LIMITS.discover, 'discover');
});

test('everything else under /api: general limit', async () => {
  const rs = await burst(LIMITS.api + 1, () => req(app.base, '/api/genres'));
  assert.equal(rs.at(-1).status, 429);
});
