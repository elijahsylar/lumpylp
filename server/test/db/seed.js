// Synthetic catalog generator for the local test database. Nothing here comes
// from production: titles and artists are generated words, ids and URLs
// follow each source's real *format* so resolvers, attribution and
// predicates see realistic shapes. Deterministic (seeded PRNG).

// Source mix and license mix modelled on the 2026-10-25 production counts
// (recon work/license.txt), rounded.
export const SOURCE_MIX = [
  ['audius', 166918], ['archive_netlabels', 139318], ['archive_livemusic', 124723],
  ['jamendo', 71014], ['archive_pd78s', 54370], ['ccmixter', 33686],
  ['archive_subjects', 16210], ['wikimedia', 13295], ['loc_jukebox', 10346],
  ['musopen', 6415], ['phlow', 4205], ['ucsb_cylinders', 2708],
  ['incompetech', 1277], ['audionautix', 369], ['archive_cylinders', 307],
];

const LICENSES = {
  audius: [['all-rights-reserved', 9], ['audius-platform', 1]],
  archive_netlabels: [['cc-by-nc-nd', 54], ['cc-by-nc-sa', 24], ['cc-by-nc', 6], ['cc-by-nd', 6], ['cc-by-sa', 4], ['cc-by', 3], ['public-domain', 3]],
  archive_livemusic: [['taper-policy', 99], ['cc-by-nc-nd', 1]],
  jamendo: [['cc-by-nc-nd', 49], ['cc-by-nc-sa', 15], ['by-nc-nd', 7], ['CC', 6], ['by-nc-sa', 6], ['cc-by-sa', 5], ['cc-by', 3], ['by', 1]],
  archive_pd78s: [['public-domain', 99], ['cc-by-nc-nd', 1]],
  ccmixter: [['cc-by-nc', 73], ['cc-by', 20], ['nc-sampling-plus', 3], ['cc-by-nc-sa', 2], ['sampling-plus', 1], ['cc0', 1]],
  archive_subjects: [['cc-by-nc-nd', 38], ['public-domain', 21], ['cc-by-nc', 15], ['cc-by-nc-sa', 9], ['cc-by', 7], ['cc-by-sa', 6], ['cc-by-nd', 4]],
  wikimedia: [['public-domain', 48], ['cc-by', 26], ['cc-by-sa', 26]],
  loc_jukebox: [['public-domain', 1]],
  musopen: [['public-domain', 71], ['cc-by', 24], ['cc-by-sa', 5]],
  phlow: [['cc-by-nc-nd', 79], ['cc-by-nc-sa', 16], ['cc-by-nd', 3], ['cc-by-sa', 2]],
  ucsb_cylinders: [['public-domain', 1]],
  incompetech: [['cc-by', 1]],
  audionautix: [['cc-by', 1]],
  archive_cylinders: [['cc-by-nc-sa', 90], ['cc-by-nc-nd', 6], ['public-domain', 4]],
};

const GENRES = ['ambient', 'electronic', 'rock', 'jazz', 'classical', 'folk', 'hip-hop', 'pop', 'experimental', 'blues', 'pre-1929', null];
// Title/artist vocabulary shaped like a real catalog: a few thousand
// distinct words plus a small set of common ones that each turn up in roughly
// 1-2% of titles (in prod, "love" matches ~11k of 645k tracks). A tiny
// vocabulary would make every search word match a tenth of the catalog.
const COMMON = ('river stone lantern velvet orbit ember harbor cedar meadow signal hollow '
  + 'copper dusk prairie static violet love night blue song dream rain fire light moon '
  + 'dance heart road home city').split(' ');
const SYLLABLES = 'ka lo mi ra te su no vi da ze po li ma ne tu ri sa fo be gu ha ki mo pe'.split(' ');
function makeVocab(r, n) {
  const out = new Set();
  while (out.size < n) {
    const len = 2 + Math.floor(r() * 3);
    out.add(Array.from({ length: len }, () => SYLLABLES[Math.floor(r() * SYLLABLES.length)]).join(''));
  }
  return [...out];
}
const VOCAB = makeVocab(rng(7), 4000);
// ~300 cities spread over the world with a long-tail of sizes; Portland is
// the first and biggest so tests have a known populated place.
const CITIES = (() => {
  const r = rng(11);
  const list = [['Portland', 'United States', 45.5152, -122.6784]];
  for (let i = 1; i < 300; i++) {
    list.push([`City ${i}`, `Country ${i % 60}`, Number((r() * 120 - 55).toFixed(4)), Number((r() * 340 - 170).toFixed(4))]);
  }
  return list;
})();

export function rng(seed = 42) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickWeighted(r, pairs) {
  const total = pairs.reduce((s, [, w]) => s + w, 0);
  let x = r() * total;
  for (const [v, w] of pairs) { x -= w; if (x <= 0) return v; }
  return pairs[pairs.length - 1][0];
}
const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
const word = (r) => (r() < 0.25 ? pick(r, COMMON) : pick(r, VOCAB));
const words = (r, n) => Array.from({ length: n }, () => word(r)).join(' ');
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const cap = (s) => s.replace(/\b\w/g, (c) => c.toUpperCase());

// Build one track row (plain object, column -> value) for `source`, index i.
export function makeTrack(r, source, i) {
  const title = cap(words(r, 1 + Math.floor(r() * 3)));
  const artist = cap(words(r, 1 + Math.floor(r() * 2))) + ` ${i % 997}`;
  const license = pickWeighted(r, LICENSES[source]);
  const ident = `${slug(artist)}-${slug(title)}-${i}`;
  const file = `${String(1 + (i % 12)).padStart(2, '0')} ${title.toLowerCase()}`;
  const base = {
    source, title, artist_name: artist, license,
    genre: pick(r, GENRES),
    duration_seconds: 60 + Math.floor(r() * 600),
    artwork_url: null,
  };
  switch (source) {
    case 'audius': {
      const id = `A${i.toString(36)}x`;
      return { ...base, external_id: id,
        stream_url: `https://discoveryprovider.audius.co/v1/tracks/${id}/stream?app_name=LumpyLP`,
        download_url: `https://discoveryprovider.audius.co/v1/tracks/${id}/stream?app_name=LumpyLP`,
        is_downloadable: 0, artwork_url: `https://example-audius-node.test/content/${id}/480x480.jpg` };
    }
    case 'jamendo':
      return { ...base, external_id: String(100000 + i),
        stream_url: `https://prod-1.storage.jamendo.com/?trackid=${100000 + i}&format=mp32`,
        download_url: `https://prod-1.storage.jamendo.com/download/track/${100000 + i}/mp32/`,
        artwork_url: `https://usercontent.jamendo.com?type=album&id=${i}&width=300` };
    case 'ccmixter':
      return { ...base, external_id: String(70000 + i),
        stream_url: `https://ccmixter.org/content/${slug(artist)}/${slug(artist)}_-_${slug(title)}.mp3`,
        download_url: `https://ccmixter.org/content/${slug(artist)}/${slug(artist)}_-_${slug(title)}.mp3` };
    case 'wikimedia': {
      const f = `${cap(title)} ${i}.ogg`;
      return { ...base, external_id: `File:${f}`,
        stream_url: `https://upload.wikimedia.org/wikipedia/commons/a/ab/${encodeURIComponent(f.replace(/ /g, '_'))}`,
        download_url: `https://upload.wikimedia.org/wikipedia/commons/a/ab/${encodeURIComponent(f.replace(/ /g, '_'))}` };
    }
    case 'loc_jukebox': {
      // ~89% National Jukebox ("jukebox-NNNNNN"), ~11% American Folklife Center (numeric).
      const jukebox = r() < 0.89;
      const id = jukebox ? `jukebox-${200000 + i}` : String(2017600000 + i);
      return { ...base, external_id: id, license: 'public-domain', duration_seconds: null,
        stream_url: `https://tile.loc.gov/streaming-services/iiif/service:mbrsrs:mbrsjukebox:test_${i}/full/full/0/full/default.mp3`,
        download_url: `https://tile.loc.gov/streaming-services/iiif/service:mbrsrs:mbrsjukebox:test_${i}/full/full/0/full/default.mp3` };
    }
    case 'musopen':
      return { ...base, external_id: String(900 + i), genre: 'classical',
        stream_url: `https://dl.musopen.org/recordings/${i}-test.mp3?filename=${encodeURIComponent(title)}.mp3`,
        download_url: `https://dl.musopen.org/recordings/${i}-test.mp3` };
    case 'ucsb_cylinders': {
      const n = String(i).padStart(4, '0');
      return { ...base, external_id: `ucsb_cylinders:${n}`, license: 'public-domain', duration_seconds: null,
        stream_url: `https://cylinders.s3-us-west-2.amazonaws.com/0000/${n}/cusb-cyl${n}d.mp3`,
        download_url: `https://cylinders.s3-us-west-2.amazonaws.com/0000/${n}/cusb-cyl${n}d.mp3` };
    }
    case 'incompetech':
      return { ...base, external_id: `USUAN25${String(i).padStart(5, '0')}`,
        stream_url: `https://incompetech.com/music/royalty-free/mp3-royaltyfree/${encodeURIComponent(title)}.mp3`,
        download_url: `https://incompetech.com/music/royalty-free/mp3-royaltyfree/${encodeURIComponent(title)}.mp3` };
    case 'audionautix':
      return { ...base, external_id: `music-${slug(title)}-${i}`,
        stream_url: `https://audionautix.com/Music/${encodeURIComponent(title)}.mp3`,
        download_url: `https://audionautix.com/Music/${encodeURIComponent(title)}.mp3` };
    case 'archive_pd78s': {
      const year = 1900 + Math.floor(r() * 26);
      const id = `${year}-USA-Archives-${slug(artist)}-${slug(title)}-${i}`;
      return { ...base, external_id: `${id}:${file}`, genre: 'pre-1929',
        stream_url: `https://archive.org/download/${id}/${encodeURIComponent(file)}.mp3`,
        download_url: `https://archive.org/download/${id}/${encodeURIComponent(file)}.mp3`,
        artwork_url: `https://archive.org/services/img/${id}` };
    }
    default: // archive_netlabels, archive_livemusic, archive_subjects, archive_cylinders, phlow
      return { ...base, external_id: `${ident}:${file}`,
        stream_url: `https://archive.org/download/${ident}/${encodeURIComponent(file)}.mp3`,
        download_url: `https://archive.org/download/${ident}/${encodeURIComponent(file)}.mp3`,
        artwork_url: `https://archive.org/services/img/${ident}` };
  }
}

const TRACK_COLS = ['external_id', 'source', 'title', 'artist_name', 'genre', 'duration_seconds',
  'stream_url', 'download_url', 'license', 'artwork_url', 'is_downloadable', 'indexed_at', 'upvotes', 'downvotes'];

// Insert `total` tracks with the production source mix (each source gets at
// least `minPerSource`). `conn` is a mysql2/promise connection.
export async function seedTracks(conn, { total = 2000, minPerSource = 20, seed = 42, batch = 1000, log = () => {} } = {}) {
  const r = rng(seed);
  const sum = SOURCE_MIX.reduce((s, [, n]) => s + n, 0);
  const plan = SOURCE_MIX.map(([s, n]) => [s, Math.max(minPerSource, Math.round((n / sum) * total))]);
  let i = 0;
  let rows = [];
  const t0 = Date.parse('2026-01-01T00:00:00Z');
  const flush = async () => {
    if (!rows.length) return;
    await conn.query(`INSERT INTO tracks (${TRACK_COLS.join(',')}) VALUES ?`, [rows]);
    rows = [];
  };
  for (const [source, n] of plan) {
    for (let k = 0; k < n; k++) {
      i += 1;
      const t = makeTrack(r, source, i);
      const up = r() < 0.02 ? Math.floor(r() * 8) : 0;
      const down = r() < 0.01 ? Math.floor(r() * 3) : 0;
      const indexed = new Date(t0 + Math.floor(r() * 290 * 86400000));
      rows.push(TRACK_COLS.map((c) => (c === 'is_downloadable' ? (t.is_downloadable ?? 1)
        : c === 'indexed_at' ? indexed : c === 'upvotes' ? up : c === 'downvotes' ? down : t[c] ?? null)));
      if (rows.length >= batch) { await flush(); if (i % 50000 < batch) log(`  ${i} tracks`); }
    }
  }
  await flush();
  // One artists row per (artist_name, source) for a sample; about 1 in 7 of
  // those gets a city, picked with a long tail (city i has weight 1/(i+1)).
  await conn.query(`INSERT IGNORE INTO artists (name, source)
    SELECT DISTINCT artist_name, source FROM tracks WHERE id % 7 = 0`);
  const [arts] = await conn.query(`SELECT id FROM artists WHERE id % 7 = 0`);
  const weights = CITIES.map((_, i) => [i, 1 / (i + 1)]);
  for (let k = 0; k < arts.length; k += 1000) {
    const chunk = arts.slice(k, k + 1000).map(({ id }) => {
      const [city, country, lat, lng] = CITIES[pickWeighted(r, weights)];
      return [id, city, country, lat + (r() - 0.5) * 0.05, lng + (r() - 0.5) * 0.05];
    });
    await conn.query(`INSERT INTO artists (id, name, source, city, country, lat, lng)
      SELECT x.id, a.name, a.source, x.city, x.country, x.lat, x.lng
      FROM JSON_TABLE(?, '$[*]' COLUMNS (id INT PATH '$[0]', city VARCHAR(128) PATH '$[1]',
        country VARCHAR(64) PATH '$[2]', lat DOUBLE PATH '$[3]', lng DOUBLE PATH '$[4]')) x
      JOIN artists a ON a.id = x.id
      ON DUPLICATE KEY UPDATE city = VALUES(city), country = VALUES(country), lat = VALUES(lat), lng = VALUES(lng)`,
      [JSON.stringify(chunk)]);
  }
  await conn.query(`INSERT IGNORE INTO genres (name, track_count)
    SELECT genre, COUNT(*) FROM tracks WHERE genre IS NOT NULL GROUP BY genre`);
  return i;
}

// Two ordinary users, a lump each, and a few votes. Passwords are random and
// never needed: tests mint JWTs directly.
export async function seedCommunity(conn) {
  const hash = '$2b$10$abcdefghijklmnopqrstuuR8l0pZ1xqkJ0Y5mFv0dO7s8WcN9QeG.'; // not a real password
  await conn.query(
    `INSERT INTO users (email, username, password_hash, paid_at) VALUES
       ('alice@example.test', 'alice', ?, NOW()), ('bob@example.test', 'bob', ?, NOW())`,
    [hash, hash]
  );
  const [[alice]] = await conn.query(`SELECT id FROM users WHERE username='alice'`);
  const [[bob]] = await conn.query(`SELECT id FROM users WHERE username='bob'`);
  const [lump] = await conn.query(
    `INSERT INTO user_lumps (user_id, name, is_public) VALUES (?, 'Alice public lump', 1)`, [alice.id]);
  await conn.query(`INSERT INTO lump_tracks (lump_id, track_id, position)
    SELECT ?, id, ROW_NUMBER() OVER (ORDER BY id) FROM tracks ORDER BY id LIMIT 5`, [lump.insertId]);
  await conn.query(`INSERT INTO votes (user_id, track_id, direction)
    SELECT ?, id, 1 FROM tracks ORDER BY id LIMIT 10`, [bob.id]);
}
