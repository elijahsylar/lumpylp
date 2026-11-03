// Owner follow-ups after Phase 1 (2026-10-25): unverified licenses hidden,
// the Wikimedia public-domain fallback removed, archive_pd78s out of the
// first dedupe run, and a read-only Commons license check.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { q, insertTrack, closeAdmin } from './helpers/db.js';
import { PLANTED } from './db/fixtures.js';

let srv, base;
before(async () => {
  // Stand-in for the Commons imageinfo API: one file CC0-marked, one with no license.
  srv = http.createServer((rq, rs) => {
    const titles = new URL(rq.url, 'http://x').searchParams.get('titles').split('|');
    const pages = titles.map((t, i) => ({
      pageid: i + 1, title: t,
      imageinfo: [{ extmetadata: t.includes('Default PD')
        ? {}
        : { LicenseShortName: { value: 'Public domain' }, License: { value: 'pd' } } }],
    }));
    rs.setHeader('content-type', 'application/json');
    rs.end(JSON.stringify({ query: { pages } }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}/w/api.php`;
});
after(async () => {
  srv.close();
  await closeAdmin();
  const { pool } = await import('../db.js');
  await pool.end();
});
const byExt = async (ids) => q(`SELECT external_id, hidden_reason, is_live, license FROM tracks WHERE external_id IN (?)`, [ids]);

test('Wikimedia public-domain and Jamendo bare-CC rows are hidden as license_unverified; near-misses stay', async () => {
  for (const r of await byExt([...PLANTED.wikiPD, ...PLANTED.jamendoCC])) {
    assert.equal(r.hidden_reason, 'license_unverified', r.external_id);
    assert.equal(r.is_live, 0);
  }
  for (const r of await byExt([...PLANTED.wikiCC, ...PLANTED.jamendoOK])) {
    assert.equal(r.hidden_reason, null, r.external_id);
    assert.equal(r.is_live, 1);
  }
});

test('the Wikimedia resolver no longer defaults a missing license to public domain', async () => {
  const { wikimediaLicense } = await import('../services/wikimedia.js');
  assert.equal(wikimediaLicense({}), null);
  assert.equal(wikimediaLicense(null), null);
  assert.equal(wikimediaLicense({ LicenseShortName: { value: 'CC BY-SA 4.0' } }) !== null, true);
});

test('the first dedupe run leaves archive_pd78s out unless asked', async () => {
  const D = { source: 'archive_pd78s', artist_name: 'Pd Dupe', title: 'Same Side', duration_seconds: 171 };
  const a = await insertTrack({ ...D, external_id: 'pdd-1:01' });
  await insertTrack({ ...D, external_id: 'pdd-2:01' });
  const { planDedupe } = await import('../scripts/dedupe-within-source.js');
  const { query } = await import('../db.js');
  const def = await planDedupe({ query, sources: ['archive_pd78s'] });
  assert.equal(def.groups.length, 0);
  assert.equal(def.sources.includes('archive_pd78s'), false);
  const all = await planDedupe({ query });
  assert.equal(all.sources.includes('archive_pd78s'), false);
  assert.equal(all.sources.includes('archive_livemusic'), false);
  const opt = await planDedupe({ query, sources: ['archive_pd78s'], includePd78s: true });
  assert.ok(opt.groups.some((g) => g.keeper === a));
});

test('check-wikimedia-licenses lists what Commons confirms and changes nothing', async () => {
  const { checkWikimediaLicenses } = await import('../scripts/check-wikimedia-licenses.js');
  const { query } = await import('../db.js');
  const before = await q(`SELECT id, hidden_reason FROM tracks WHERE hidden_reason = 'license_unverified' ORDER BY id`);
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wm-')), 'wm.csv');
  const r = await checkWikimediaLicenses({ query, apiUrl: base, out, delayMs: 0 });
  assert.ok(r.checked >= 1);
  const csv = fs.readFileSync(out, 'utf8');
  assert.match(csv, /Fx Wiki Default PD\.ogg.*,no_license,/);
  assert.equal(fs.statSync(out).mode & 0o777, 0o600);
  assert.deepEqual(await q(`SELECT id, hidden_reason FROM tracks WHERE hidden_reason = 'license_unverified' ORDER BY id`), before);
});
