// Regression tests for the independent review's findings (see the log).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import mysql from 'mysql2/promise';
import { startApp, req } from './helpers/app.js';
import { q, insertTrack, makeUser, closeAdmin } from './helpers/db.js';

let app;
before(async () => {
  process.env.RATE_LIMITS = JSON.stringify({ api: 1e9, discover: 1e9 });
  app = await startApp();
});
after(async () => { await app.close(); await closeAdmin(); });

test('R21: the API user cannot change roles or token versions it does not own the write path for', async () => {
  const c = await mysql.createConnection({ host: '127.0.0.1', port: 33306, user: 'lumpylp_app', password: 'app-test-only', database: process.env.DB_NAME });
  try {
    await assert.rejects(c.query(`UPDATE users SET role = 'admin' WHERE id = 0`), (e) => e.errno === 1143 || e.errno === 1142);
    await assert.rejects(c.query(`DELETE FROM users WHERE id = 0`), (e) => e.errno === 1142);
    await c.query(`UPDATE users SET theme = theme, password_hash = password_hash, token_version = token_version WHERE id = 0`);
  } finally { await c.end(); }
});

test('R10: a hidden track does not appear in a public lump for other viewers; the owner sees it as unavailable', async () => {
  const owner = await makeUser(); const viewer = await makeUser();
  const live = await insertTrack({ title: 'R10 Live' });
  const taken = await insertTrack({ title: 'R10 Takedown' });
  const { insertId: lumpId } = await q(`INSERT INTO user_lumps (user_id, name, is_public) VALUES (?, 'r10', 1)`, [owner.id]);
  await q(`INSERT INTO lump_tracks (lump_id, track_id, position) VALUES (?, ?, 1), (?, ?, 2)`, [lumpId, live, lumpId, taken]);
  await q(`UPDATE tracks SET hidden_at = NOW(), hidden_reason = 'takedown' WHERE id = ?`, [taken]);
  const pub = await req(app.base, `/api/lumps/${lumpId}`, { token: viewer.token });
  assert.deepEqual(pub.body.tracks.map((t) => t.id), [live]);
  const anon = await req(app.base, `/api/lumps/${lumpId}`);
  assert.deepEqual(anon.body.tracks.map((t) => t.id), [live]);
  const mine = await req(app.base, `/api/lumps/${lumpId}`, { token: owner.token });
  const hidden = mine.body.tracks.find((t) => t.id === taken);
  assert.ok(hidden && hidden.available === false);
  assert.equal(hidden.title, 'Unavailable track', 'owner sees a placeholder, not the taken-down metadata');
  assert.equal(hidden.attribution, null);
});

test('R14: admin unhide clears duplicate_of', async () => {
  const admin = await makeUser({ role: 'admin' });
  const keeper = await insertTrack(); const dup = await insertTrack();
  await q(`UPDATE tracks SET hidden_at = NOW(), hidden_reason = 'duplicate', duplicate_of = ? WHERE id = ?`, [keeper, dup]);
  await req(app.base, `/api/admin/tracks/${dup}/unhide`, { method: 'POST', token: admin.token, json: {} });
  const [r] = await q(`SELECT hidden_at, duplicate_of FROM tracks WHERE id = ?`, [dup]);
  assert.deepEqual([r.hidden_at, r.duplicate_of], [null, null]);
});

test('R16: a bare "CC" license links to the item page that states it', async () => {
  const { attributionFor } = await import('../lib/attribution.js');
  const a = attributionFor({ source: 'jamendo', external_id: '4242', license: 'CC', artist_name: 'X' });
  assert.equal(a.license_url, 'https://www.jamendo.com/track/4242');
});

test('R7: geocoding refuses quickly once the Nominatim queue is full (503 from discover)', async () => {
  // geocode() does a DB cache lookup before it joins the queue, so calls
  // started together can reach the queue in any order. Fill the queue with
  // one call and wait until the stub sees its request before testing refusal.
  const hold = [];
  const stub = http.createServer((rq, rs) => { hold.push(rs); });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const saved = { url: process.env.NOMINATIM_URL, max: process.env.NOMINATIM_MAX_QUEUE };
  process.env.NOMINATIM_URL = `http://127.0.0.1:${stub.address().port}/search`;
  process.env.NOMINATIM_MAX_QUEUE = '1';
  let pending;
  try {
    const { geocode, GeocodeBusyError } = await import('../lib/geocode.js');
    pending = geocode(`r7-a-${process.pid}`);
    for (let i = 0; i < 200 && hold.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(hold.length, 1, 'the first lookup reached Nominatim');
    const t0 = Date.now();
    const tooSlow = new Promise((_, rej) => setTimeout(() => rej(new Error('not refused within 1s')), 1000).unref());
    await assert.rejects(Promise.race([geocode(`r7-c-${process.pid}`), tooSlow]), GeocodeBusyError);
    assert.ok(Date.now() - t0 < 1000, 'refused without waiting');
    const r = await req(app.base, `/api/discover/cities?q=r7-d-${process.pid}`);
    assert.equal(r.status, 503);
    assert.ok(Number(r.headers.get('retry-after')) > 0);
  } finally {
    for (const rs of hold) { rs.setHeader('content-type', 'application/json'); rs.end('[]'); }
    await Promise.allSettled([pending]);
    stub.closeAllConnections();
    stub.close();
    for (const [k, v] of [['NOMINATIM_URL', saved.url], ['NOMINATIM_MAX_QUEUE', saved.max]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test('R20: a host that refuses HEAD with 403 but serves GET is alive', async () => {
  const srv = http.createServer((rq, rs) => { rs.writeHead(rq.method === 'HEAD' ? 403 : 206); rs.end(); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { checkUrl } = await import('../lib/linkCheck.js');
  const r = await checkUrl(`http://127.0.0.1:${srv.address().port}/x`, { timeoutMs: 500, retries: 1, retryDelayMs: 1 });
  srv.close();
  assert.equal(r.state, 'alive');
});

test('R4: indexer-side scripts read their own env file and refuse the API or admin DB user', async () => {
  const { envCandidates, assertIndexerUser } = await import('../lib/env.js');
  const prod = envCandidates({ nodeEnv: 'production', role: 'indexer' }).map((p) => p.split('/').pop());
  assert.deepEqual(prod, ['.env.indexer.production', '.env.indexer.production']);
  const api = envCandidates({ nodeEnv: 'production', role: 'api' }).map((p) => p.split('/').pop());
  assert.deepEqual(api, ['.env.production', '.env.production']);
  assert.throws(() => assertIndexerUser({ NODE_ENV: 'production', DB_USER: 'lumpylp_app' }), /lumpylp_indexer/);
  assert.throws(() => assertIndexerUser({ NODE_ENV: 'production', DB_USER: 'doadmin' }), /lumpylp_indexer/);
  assert.doesNotThrow(() => assertIndexerUser({ NODE_ENV: 'production', DB_USER: 'lumpylp_indexer' }));
  assert.doesNotThrow(() => assertIndexerUser({ NODE_ENV: 'test', DB_USER: 'root' }));
});

test('R12: production never loads the developer .env', async () => {
  const fs = await import('node:fs');
  for (const f of ['../index.js', '../middleware/auth.js']) {
    const src = fs.readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.match(src, /NODE_ENV !== 'production'/, f);
  }
});
