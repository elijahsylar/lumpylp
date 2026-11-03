import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { forbiddenTrackedPaths, secretHits, nonPlaceholderKeys } from './helpers/hygiene.js';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);

test('rules catch planted bad paths (the check can fail)', () => {
  const bad = forbiddenTrackedPaths(['.env', 'server/.env.production', '.env.production.backup',
    'dump.sql', 'lumpylp-20261025.sql.gz', 'certs/origin-key.pem', 'server/migrations/015_x.sql', '.env.example']);
  assert.deepEqual(bad.map(([p]) => p).sort(), ['.env', '.env.production.backup', 'certs/origin-key.pem',
    'dump.sql', 'lumpylp-20261025.sql.gz', 'server/.env.production'].sort());
});

test('no env files, keys or dumps are tracked', () => {
  assert.deepEqual(forbiddenTrackedPaths(tracked), []);
});

test('secret patterns catch planted strings (the check can fail)', () => {
  assert.deepEqual(secretHits('STRIPE_SECRET_KEY=sk_live_' + 'a'.repeat(24)), ['Stripe live secret key']);
  assert.deepEqual(secretHits('nothing to see'), []);
});

test('no live secret-shaped strings in tracked text files', () => {
  const hits = [];
  for (const rel of tracked) {
    if (/\.(png|jpg|ico|woff2?|pdf|gz|lock)$/i.test(rel)) continue;
    const p = path.join(root, rel);
    let text;
    try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }
    if (text.length > 2_000_000) continue;
    for (const why of secretHits(text)) hits.push(`${rel}: ${why}`);
  }
  assert.deepEqual(hits, []);
});

test('.env.example holds placeholders only', () => {
  assert.deepEqual(nonPlaceholderKeys('JWT_SECRET=abc123def\nPORT=3001\nX=<value>'), ['JWT_SECRET']);
  const text = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
  assert.deepEqual(nonPlaceholderKeys(text), []);
});

test('every repo file the docs and migrations point to is tracked in git', () => {
  // A doc can name a file that .gitignore silently keeps out of git
  // (review R3: grant-admin.sql was ignored as *.sql).
  const sources = tracked.filter((p) => /\.(md|sql)$/.test(p) && !/pd78s-1926|018_relaunch/.test(p));
  const missing = [];
  for (const src of sources) {
    const text = fs.readFileSync(path.join(root, src), 'utf8');
    for (const m of text.matchAll(/`?((?:server\/)?(?:db|scripts|lib|routes|migrations|test)\/[A-Za-z0-9_./-]+\.(?:js|sql|sh))`?/g)) {
      const rel = m[1].startsWith('server/') ? m[1] : `server/${m[1]}`;
      if (!fs.existsSync(path.join(root, rel))) continue; // removed files may be mentioned historically
      if (!tracked.includes(rel)) missing.push(`${src} -> ${rel}`);
    }
  }
  assert.deepEqual([...new Set(missing)], []);
});
