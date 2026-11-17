// The stream route only redirects to an http(s) URL on a host allowed for
// the track's source (lib/streamHosts.js); anything else is a 404.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, req } from './helpers/app.js';
import { insertTrack, closeAdmin } from './helpers/db.js';
import { SOURCE_MIX, makeTrack, rng } from './db/seed.js';
import { STREAM_HOSTS, NOT_REDIRECTED, streamRedirectTarget } from '../lib/streamHosts.js';
import { SOURCE_NAMES } from '../lib/sources.js';

let app;
before(async () => { app = await startApp(); });
after(async () => { await app.close(); await closeAdmin(); });

// One URL per redirected source, in the form its resolver stores.
const VALID = {
  archive_pd78s: 'https://archive.org/download/78_test-item/01%20-%20Side%20A.mp3',
  archive_livemusic: 'https://archive.org/download/gd1977-test/gd77-05-08d1t01.mp3',
  archive_netlabels: 'https://archive.org/download/netlabel-test/track%2001.mp3',
  archive_subjects: 'https://archive.org/download/subject-test/song.mp3',
  archive_cylinders: 'https://archive.org/download/cylinder-test/cyl.mp3',
  phlow: 'https://archive.org/download/phlow-test/a%20tune.mp3',
  ucsb_cylinders: 'https://cylinders.s3-us-west-2.amazonaws.com/0000/0006/cusb-cyl0006d.mp3',
  jamendo: 'https://prod-1.storage.jamendo.com/?trackid=100001&format=mp32',
  wikimedia: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/A_Tune.ogg',
  musopen: 'https://dl.musopen.org/recordings/1-test.mp3?filename=A%20Tune.mp3',
  loc_jukebox: 'https://tile.loc.gov/streaming-services/iiif/service:mbrsrs:mbrsjukebox:test_1/full/full/0/full/default.mp3',
  incompetech: 'https://incompetech.com/music/royalty-free/mp3-royaltyfree/A%20Tune.mp3',
  audionautix: 'https://audionautix.com/Music/ATune.mp3',
  soundcloud: 'https://api.soundcloud.com/tracks/123/stream',
  smithsonian: 'https://media.si.edu/audio/a-tune.mp3',
};

// [label, source, stored stream_url] that must never become a redirect.
const REFUSED = [
  ['javascript: scheme', 'jamendo', 'javascript:alert(1)'],
  ['data: scheme', 'wikimedia', 'data:text/html,<script>alert(1)</script>'],
  ['file: scheme', 'archive_netlabels', 'file:///etc/hostname'],
  ['ftp: scheme on an allowed host', 'archive_netlabels', 'ftp://archive.org/download/x/y.mp3'],
  ['not a URL', 'archive_netlabels', 'x'],
  ['path only', 'archive_netlabels', '/download/x/y.mp3'],
  ['scheme-relative', 'archive_netlabels', '//archive.org/download/x/y.mp3'],
  ['unexpected host', 'archive_netlabels', 'https://media.example.com/x.mp3'],
  ['look-alike host (suffix)', 'archive_netlabels', 'https://archive.org.example.com/download/x/y.mp3'],
  ['look-alike host (prefix)', 'archive_netlabels', 'https://notarchive.org/download/x/y.mp3'],
  ['look-alike host (exact entry)', 'wikimedia', 'https://upload.wikimedia.org.example.com/a.ogg'],
  ['subdomain of an exact entry', 'wikimedia', 'https://evil.upload.wikimedia.org/a.ogg'],
  ['empty label before a dot entry', 'archive_netlabels', 'https://.archive.org/download/x/y.mp3'],
  ['empty label before a dot entry (jamendo)', 'jamendo', 'https://.jamendo.com/?trackid=1'],
  ['allowed host as userinfo', 'archive_netlabels', 'https://archive.org@media.example.com/x.mp3'],
  ['credentials on an allowed host', 'archive_netlabels', 'https://user:pw@archive.org/download/x/y.mp3'],
  ['explicit port', 'archive_netlabels', 'https://archive.org:8443/download/x/y.mp3'],
  ['another source\'s host', 'jamendo', 'https://archive.org/download/x/y.mp3'],
  ['source with no entry', 'europeana', 'https://archive.example.org/sound/1.mp3'],
  ['unknown source', 'no_such_source', 'https://archive.org/download/x/y.mp3'],
  ['prototype key as source', 'constructor', 'https://archive.org/download/x/y.mp3'],
];

test('streamRedirectTarget: refuses bad schemes, hosts and look-alikes; accepts each source\'s own host', () => {
  for (const [label, source, url] of REFUSED) {
    assert.equal(streamRedirectTarget(source, url), null, label);
  }
  for (const [source, url] of Object.entries(VALID)) {
    assert.equal(streamRedirectTarget(source, url), url, source);
  }
  // http is allowed, and so are archive.org's numbered download hosts.
  assert.equal(streamRedirectTarget('audionautix', 'http://audionautix.com/Music/ATune.mp3'), 'http://audionautix.com/Music/ATune.mp3');
  assert.equal(streamRedirectTarget('archive_netlabels', 'https://ia800100.us.archive.org/1/items/x/y.mp3'), 'https://ia800100.us.archive.org/1/items/x/y.mp3');
  assert.equal(streamRedirectTarget('jamendo', null), null);
  assert.equal(streamRedirectTarget('jamendo', ''), null);
});

test('every source is either on the allowlist or deliberately not redirected', () => {
  assert.deepEqual(Object.keys(VALID).sort(), Object.keys(STREAM_HOSTS).sort());
  assert.deepEqual([...Object.keys(STREAM_HOSTS), ...Object.keys(NOT_REDIRECTED)].sort(), [...SOURCE_NAMES].sort());
  for (const entries of Object.values(STREAM_HOSTS)) {
    assert.ok(Array.isArray(entries) && entries.length > 0);
    for (const e of entries) assert.match(e, /^\.?[a-z0-9-]+(\.[a-z0-9-]+)+$/, e);
  }
});

test('every stream_url the seeded catalog generates passes for its source', () => {
  // The seed mirrors the production source mix and each source's URL format.
  const r = rng(3);
  const sources = SOURCE_MIX.map(([source]) => source).filter((source) => !(source in NOT_REDIRECTED));
  assert.equal(sources.length, 13);
  for (const source of sources) {
    for (let i = 0; i < 50; i++) {
      const t = makeTrack(r, source, i);
      assert.equal(streamRedirectTarget(source, t.stream_url), new URL(t.stream_url).href, `${source} ${t.stream_url}`);
    }
  }
});

test('GET /api/stream/:id answers 404, not a redirect, for a stream_url that is not allowed', async () => {
  for (const [label, source, url] of REFUSED) {
    const id = await insertTrack({ source, stream_url: url });
    const r = await req(app.base, `/api/stream/${id}`);
    assert.equal(r.status, 404, `${label}: ${r.status} -> ${r.headers.get('location')}`);
    assert.equal(r.headers.get('location'), null, label);
    assert.deepEqual(r.body, { error: 'no stream' }, label);
  }
});

test('GET /api/stream/:id still redirects to a valid URL for every allowed source', async () => {
  for (const [source, url] of Object.entries(VALID)) {
    const id = await insertTrack({ source, stream_url: url });
    const r = await req(app.base, `/api/stream/${id}`);
    assert.equal(r.status, 302, source);
    assert.equal(r.headers.get('location'), url, source);
  }
});
