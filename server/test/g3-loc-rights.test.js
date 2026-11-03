// Owner decision 3: a script lists which hidden AFC items LoC's own rights
// statements would let us unhide. It never unhides anything.
import './helpers/as-indexer.js';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { q, closeAdmin } from './helpers/db.js';
import { PLANTED } from './db/fixtures.js';

let srv, base, hits = [];
before(async () => {
  srv = http.createServer((rq, rs) => {
    hits.push(rq.url);
    const id = rq.url.match(/item\/([^/]+)\//)?.[1];
    rs.setHeader('content-type', 'application/json');
    const rights = id === PLANTED.afc[0]
      ? 'The Library of Congress is not aware of any U.S. copyright or other restrictions in the vast majority of these recordings.'
      : 'Rights assessment is your responsibility. Permission from the rights holder may be required.';
    rs.end(JSON.stringify({ item: { rights: [rights] } }));
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

test('rights classifier', async () => {
  const { classifyRights } = await import('../scripts/check-loc-rights.js');
  assert.equal(classifyRights('No known restrictions on publication.'), 'candidate');
  assert.equal(classifyRights('This recording is in the public domain.'), 'candidate');
  assert.equal(classifyRights('not aware of any U.S. copyright or other restrictions'), 'candidate');
  assert.equal(classifyRights('Permission may be required from the rights holder.'), 'restricted');
  assert.equal(classifyRights(''), 'unknown');
});

test('lists candidates in a CSV and changes nothing', async () => {
  const { checkLocRights } = await import('../scripts/check-loc-rights.js');
  const { query } = await import('../db.js');
  const before = await q(`SELECT id, hidden_at, hidden_reason FROM tracks WHERE hidden_reason = 'rights_check_pending' ORDER BY id`);
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'loc-')), 'rights.csv');
  const r = await checkLocRights({ query, baseUrl: base, out, delayMs: 0 });
  assert.ok(r.checked >= 2);
  const csv = fs.readFileSync(out, 'utf8');
  assert.match(csv, new RegExp(`${PLANTED.afc[0]},.*,candidate,`));
  assert.match(csv, new RegExp(`${PLANTED.afc[1]},.*,restricted,`));
  const afterRows = await q(`SELECT id, hidden_at, hidden_reason FROM tracks WHERE hidden_reason = 'rights_check_pending' ORDER BY id`);
  assert.deepEqual(afterRows, before);
  assert.ok(hits.every((u) => u.startsWith('/item/')));
});
