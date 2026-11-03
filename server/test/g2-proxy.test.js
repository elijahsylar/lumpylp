// S8 (item 15): the ccMixter proxy verifies TLS, has timeouts, and only ever
// fetches from ccmixter.org. S10: geocoding is globally paced.
import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../routes/tracks.js', import.meta.url), 'utf8');

test('no TLS verification is disabled anywhere in the server', async () => {
  const { execFileSync } = await import('node:child_process');
  let out = '';
  try {
    out = execFileSync('git', ['grep', '--untracked', '-n', 'rejectUnauthorized: false', '--', 'server/*.js', 'server/routes', 'server/lib', 'server/services', ':!server/test'],
      { cwd: new URL('../..', import.meta.url).pathname, encoding: 'utf8' });
  } catch (e) { if (e.status !== 1) throw e; }
  assert.equal(out, '');
});

test('the proxy only accepts ccmixter.org https URLs', async () => {
  const { ccmixterProxyTarget } = await import('../routes/tracks.js');
  assert.equal(ccmixterProxyTarget('https://ccmixter.org/content/u/u_-_x.mp3')?.hostname, 'ccmixter.org');
  assert.equal(ccmixterProxyTarget('http://ccmixter.org/content/u/u_-_x.mp3')?.protocol, 'https:'); // upgraded
  assert.equal(ccmixterProxyTarget('https://evil.example/content/x.mp3'), null);
  assert.equal(ccmixterProxyTarget('https://ccmixter.org.evil.example/x.mp3'), null);
  assert.equal(ccmixterProxyTarget('file:///etc/passwd'), null);
  assert.equal(ccmixterProxyTarget('not a url'), null);
  assert.match(src, /timeout/i);
});

test('Nominatim calls are spaced at least 1 s apart even when requested in parallel', async () => {
  await import('./helpers/env.js');
  const http = await import('node:http');
  const hits = [];
  const stub = http.createServer((rq, rs) => { hits.push(Date.now()); rs.setHeader('content-type', 'application/json'); rs.end('[]'); });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  process.env.NOMINATIM_URL = `http://127.0.0.1:${stub.address().port}/search`;
  const { geocode } = await import('../lib/geocode.js');
  await Promise.all(['parallel-a', 'parallel-b', 'parallel-c'].map((x) => geocode(`${x}-${process.pid}`)));
  stub.close();
  const { pool } = await import('../db.js');
  await pool.end();
  assert.equal(hits.length, 3);
  for (let i = 1; i < hits.length; i++) assert.ok(hits[i] - hits[i - 1] >= 1000, `gap ${hits[i] - hits[i - 1]} ms`);
});
