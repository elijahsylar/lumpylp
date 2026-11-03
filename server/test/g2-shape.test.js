// Items 2 and 11: streaming only (no download or direct file URLs anywhere in
// API responses) and attribution data on every track.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, req } from './helpers/app.js';
import { q, insertTrack, makeUser, closeAdmin } from './helpers/db.js';

let app, user, lumpId, trackIds = [];
const FORBIDDEN = ['download_url', 'is_downloadable', 'stream_url', 'dead_marked_at', 'dead_reason',
  'dead_status_code', 'consecutive_failures', 'last_play_status', 'ai_curated', 'ai_confidence', 'hidden_note'];

before(async () => {
  process.env.RATE_LIMITS = JSON.stringify({ api: 100000, search: 100000, discover: 100000 });
  app = await startApp();
  user = await makeUser();
  for (const source of ['archive_netlabels', 'jamendo', 'ccmixter', 'audius']) {
    trackIds.push(await insertTrack({ source, title: `Shapecheck ${source}`, artist_name: 'Shape Artist',
      external_id: source === 'jamendo' ? '777001' : source === 'ccmixter' ? '777002' : source === 'audius' ? 'Zz9Shape' : 'shape-item:01 shape',
      stream_url: source === 'ccmixter' ? 'https://ccmixter.org/content/shapeuser/shapeuser_-_x.mp3' : 'https://archive.org/download/shape-item/01.mp3',
      upvotes: 3 }));
  }
  const [{ insertId }] = [await q(`INSERT INTO user_lumps (user_id, name, is_public) VALUES (?, 'shape lump', 1)`, [user.id])];
  lumpId = insertId;
  await q(`INSERT INTO lump_tracks (lump_id, track_id, position) VALUES (?, ?, 1), (?, ?, 2)`, [lumpId, trackIds[0], lumpId, trackIds[1]]);
  await q(`INSERT INTO votes (user_id, track_id, direction) VALUES (?, ?, 1)`, [user.id, trackIds[2]]);
  await q(`INSERT INTO artists (name, source, country, city, lat, lng) VALUES ('Shape Artist', 'archive_netlabels', 'Iceland', 'Reykjavik', 64.146600, -21.942600)`);
  await q(`INSERT INTO geocode_cache (\`query\`, display_name, lat, lng) VALUES ('reykjavik', 'Reykjavik, Iceland', 64.146600, -21.942600)`);
});
after(async () => { await app.close(); await closeAdmin(); });

// Walk any JSON value and collect every object that looks like a track.
function tracksIn(v, out = []) {
  if (Array.isArray(v)) v.forEach((x) => tracksIn(x, out));
  else if (v && typeof v === 'object') {
    if ('title' in v && 'source' in v && 'id' in v) out.push(v);
    Object.values(v).forEach((x) => tracksIn(x, out));
  }
  return out;
}
function keysDeep(v, out = new Set()) {
  if (Array.isArray(v)) v.forEach((x) => keysDeep(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.add(k); keysDeep(x, out); }
  return out;
}

const ENDPOINTS = () => [
  '/api/tracks', '/api/tracks?sort=heap', '/api/tracks?genre=ambient', '/api/tracks/top',
  '/api/tracks/top?window=week', '/api/tracks/shuffle?n=10', '/api/tracks/random',
  `/api/tracks/${trackIds[0]}`, '/api/search?q=Shapecheck', `/api/lumps/${lumpId}`,
  '/api/discover/cities?q=Reykjavik&radius=250',
];

test('no endpoint returns a download URL, direct file URL or internal column', async () => {
  for (const path of ENDPOINTS()) {
    const r = await req(app.base, path, { token: user.token });
    assert.equal(r.status, 200, `${path}: ${JSON.stringify(r.body).slice(0, 200)}`);
    const leaked = [...keysDeep(r.body)].filter((k) => FORBIDDEN.includes(k));
    assert.deepEqual(leaked, [], path);
    assert.ok(tracksIn(r.body).length > 0, `${path} returned no tracks`);
  }
});

test('every track in every response carries complete attribution', async () => {
  for (const path of ENDPOINTS()) {
    const r = await req(app.base, path, { token: user.token });
    for (const t of tracksIn(r.body)) {
      const a = t.attribution;
      assert.ok(a, `${path}: track ${t.id} has no attribution`);
      for (const k of ['artist', 'source_name', 'license_name']) assert.ok(a[k], `${path}: ${k}`);
      assert.match(a.source_url, /^https:\/\//, `${path}: source_url`);
      if (a.license_url !== null) assert.match(a.license_url, /^https:\/\//, `${path}: license_url`);
      assert.equal(typeof t.playable, 'boolean');
    }
  }
});

test('the stream endpoint still plays a track (redirect, not a URL in JSON)', async () => {
  const r = await req(app.base, `/api/stream/${trackIds[0]}`);
  assert.equal(r.status, 302);
  assert.match(r.headers.get('location'), /^https:\/\/archive\.org\//);
});
