// Item 5: the sweep is the only judge, so its classifier must be right.
import './helpers/as-indexer.js';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { insertTrack, q, closeAdmin } from './helpers/db.js';

let srv, base;
before(async () => {
  srv = http.createServer((rq, rs) => {
    const u = new URL(rq.url, 'http://x');
    const p = u.pathname;
    if (p === '/ok') { rs.writeHead(200); return rs.end(); }
    if (p === '/moved') { rs.writeHead(301, { location: '/ok' }); return rs.end(); }
    if (p === '/moved-gone') { rs.writeHead(302, { location: '/gone' }); return rs.end(); }
    if (p === '/gone') { rs.writeHead(404); return rs.end(); }
    if (p === '/gone410') { rs.writeHead(410); return rs.end(); }
    if (p === '/busy') { rs.writeHead(429); return rs.end(); }
    if (p === '/broken') { rs.writeHead(500); return rs.end(); }
    if (p === '/slow') { setTimeout(() => { rs.writeHead(200); rs.end(); }, 3000); return; }
    if (p === '/referer') { rs.writeHead(rq.headers.referer === 'https://ccmixter.org/' ? 200 : 403); return rs.end(); }
    rs.writeHead(404); rs.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(async () => {
  srv.close();
  await closeAdmin();
  const { pool } = await import('../db.js');
  await pool.end();
});

test('classifier: alive, dead and unknown outcomes', async () => {
  const { checkUrl } = await import('../lib/linkCheck.js');
  const opts = { timeoutMs: 500, retries: 2, retryDelayMs: 1 };
  const cases = [
    ['/ok', 'alive'], ['/moved', 'alive'], ['/moved-gone', 'dead'], ['/gone', 'dead'], ['/gone410', 'dead'],
    ['/busy', 'unknown'], ['/broken', 'unknown'], ['/slow', 'unknown'],
  ];
  for (const [path, want] of cases) {
    const r = await checkUrl(base + path, opts);
    assert.equal(r.state, want, `${path}: ${JSON.stringify(r)}`);
  }
  // A port that was just freed: connection refused. (Port 9 can't be used:
  // fetch blocks it as a "bad port" before connecting.)
  const tmp = http.createServer();
  await new Promise((r) => tmp.listen(0, '127.0.0.1', r));
  const closedPort = tmp.address().port;
  await new Promise((r) => tmp.close(r));
  const refused = await checkUrl(`http://127.0.0.1:${closedPort}/nothing-listens-here`, opts);
  assert.equal(refused.state, 'dead');
});

test('ccMixter URLs are checked with the Referer the proxy sends', async () => {
  const { checkUrl } = await import('../lib/linkCheck.js');
  const opts = { timeoutMs: 500, retries: 1, retryDelayMs: 1 };
  assert.equal((await checkUrl(base + '/referer', opts)).state, 'dead');
  assert.equal((await checkUrl(base + '/referer', { ...opts, source: 'ccmixter' })).state, 'alive');
});

test('recordCheck writes is_dead, dead_marked_at and dead_reason together, and revives', async () => {
  const { recordCheck } = await import('../lib/linkCheck.js');
  const { query } = await import('../db.js');
  const id = await insertTrack();
  await recordCheck(query, id, { state: 'dead', code: 404 });
  let [r] = await q(`SELECT is_dead, dead_marked_at, dead_reason, dead_status_code, is_live FROM tracks WHERE id = ?`, [id]);
  assert.deepEqual([r.is_dead, !!r.dead_marked_at, r.dead_reason, r.dead_status_code, r.is_live], [1, true, 'sweep_404', 404, 0]);
  await recordCheck(query, id, { state: 'unknown', code: 429 });
  [r] = await q(`SELECT is_dead, dead_status_code FROM tracks WHERE id = ?`, [id]);
  assert.deepEqual([r.is_dead, r.dead_status_code], [1, -99], 'unknown never changes the verdict');
  await recordCheck(query, id, { state: 'alive', code: 200 });
  [r] = await q(`SELECT is_dead, dead_marked_at, dead_reason, is_live FROM tracks WHERE id = ?`, [id]);
  assert.deepEqual([r.is_dead, r.dead_marked_at, r.dead_reason, r.is_live], [0, null, null, 1]);
});

test('nothing but the sweep library writes is_dead or dead_marked_at', async () => {
  const { execFileSync } = await import('node:child_process');
  let out = '';
  try {
    // Assignments only (SET x = / , x =), not reads like WHERE is_dead = 1.
    out = execFileSync('git', ['grep', '--untracked', '-n', '-E', '(^|SET|,)\\s*(is_dead|dead_marked_at)\\s*=', '--',
      'server/*.js', 'server/routes', 'server/lib', 'server/scripts', 'server/indexer', ':!server/lib/linkCheck.js', ':!server/test'],
      { cwd: new URL('../..', import.meta.url).pathname, encoding: 'utf8' });
  } catch (e) { if (e.status !== 1) throw e; }
  assert.equal(out, '');
});
