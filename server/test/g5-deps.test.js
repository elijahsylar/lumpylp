// Item 10: Node 24, request-path dependencies on fixed versions, unneeded
// packages removed. (npm audit itself needs the network; its output is
// recorded in the log for each run.)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const pkg = (p) => JSON.parse(fs.readFileSync(new URL(p, import.meta.url), 'utf8'));
const server = pkg('../package.json');
const client = pkg('../../client/package.json');
const lockVersion = (lock, name) => lock.packages[`node_modules/${name}`]?.version;
const atLeast = (v, min) => {
  const a = v.split('.').map(Number), b = min.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  return true;
};

test('Node 24 everywhere', () => {
  assert.equal(server.engines.node, '>=24 <25');
  assert.equal(client.engines.node, '>=24 <25');
  assert.equal(fs.readFileSync(new URL('../../.nvmrc', import.meta.url), 'utf8').trim(), '24');
  assert.equal(process.versions.node.split('.')[0], '24');
});

test('removed packages stay removed', () => {
  for (const name of ['node-cron', 'stripe']) {
    assert.equal(name in (server.dependencies || {}), false, name);
  }
  const indexer = fs.readFileSync(new URL('../indexer/index.js', import.meta.url), 'utf8');
  assert.doesNotMatch(indexer, /node-cron|--cron|cron\.schedule/);
  assert.equal('index:cron' in server.scripts, false);
});

test('request-path dependencies are on versions with the known fixes', () => {
  const lock = pkg('../package-lock.json');
  const mins = { express: '4.22.3', 'body-parser': '1.20.6', qs: '6.15.3', mysql2: '3.24.6', zod: '4.6.7', 'proxy-addr': '2.0.7' };
  for (const [name, min] of Object.entries(mins)) {
    const v = lockVersion(lock, name);
    assert.ok(v && atLeast(v, min), `${name} ${v} < ${min}`);
  }
  const clock = pkg('../../client/package-lock.json');
  for (const [name, min] of Object.entries({ 'react-router-dom': '6.30.6', vite: '6.4.5' })) {
    const v = lockVersion(clock, name);
    assert.ok(v && atLeast(v, min), `client ${name} ${v} < ${min}`);
  }
});
