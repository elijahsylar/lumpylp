// Incompetech (Kevin MacLeod) — single artist, ~1.4k tracks, all CC-BY
// 4.0. The site (as of Apr 2026) ships its catalog as one static JSON
// blob at /music/royalty-free/pieces.json that the player UI reads at
// load time. We pull that once per indexer invocation and paginate
// in-memory; no per-track scraping needed.
//
// Politeness: pieces.json is a single ~960KB GET; we fetch with the
// LumpyLP UA and then sleep 2s before any *other* incompetech request
// (currently none — pagination is in-memory).
//
// One-time scrape per indexer run (Kevin updates rarely); the indexer
// driver re-running it on cron is fine, INSERT IGNORE dedupes.

const PIECES_URL = 'https://incompetech.com/music/royalty-free/pieces.json';
const MP3_BASE   = 'https://incompetech.com/music/royalty-free/mp3-royaltyfree/';
const UA = 'LumpyLP catalog indexer (https://lumpylp.com)';

export const INCOMPETECH_QUERIES = [{ name: 'all-pieces' }];

// Collection-id -> our canonical genre. The collection table is on the
// music.html page (`const collections = [...]`); the IDs are stable
// integers. Maps each ID directly to a normalized genre string the
// genre-mapper recognizes — values here are passed straight back as
// _genre_hint so applyGenreNormalization picks them up.
const COLLECTION_TO_GENRE = {
  '1':  'electronic',  // Hard Electronic
  '2':  'electronic',  // Medium Electronic
  '3':  'classical',   // Video Classica
  '4':  'disco',       // Disco and Lounge
  '5':  'rock',        // Rock Classic
  '6':  'rock',        // Rock Medium
  '7':  'rock',        // Rock Harder
  '8':  'funk',        // Funk and Blues
  '9':  'world',       // African
  '10': 'world',       // Middle East Inspired
  '11': 'reggae',      // Reggae and Ska
  '12': 'world',       // Polka
  '13': 'folk',        // Celtic and Folk
  '14': 'world',       // Native American
  '15': 'latin',       // Latin Sounds
  '16': 'jazz',        // Jazz
  '17': 'world',       // Far East Inspired
  '18': 'soundtrack',  // Silent Film - Bright
  '19': 'soundtrack',  // Silent Film - Dark
  '20': 'soundtrack',  // Action
  '21': 'soundtrack',  // Comedic
  '22': 'soundtrack',  // Darkness and Unease
  '23': 'soundtrack',  // Gloom and Sadness
  '24': 'soundtrack',  // Horror Soundscapes
  '25': 'soundtrack',  // Horror Themes
  '26': 'soundtrack',  // Misc
  '27': 'soundtrack',  // Mystery
  '28': 'soundtrack',  // Noire
  '29': 'soundtrack',  // Transitions
  '30': 'soundtrack',  // Aspiring
  '31': 'soundtrack',  // Tension
  '32': 'soundtrack',  // Wonder
  '33': 'piano',       // Bright Piano
  '37': 'instrumental',// Light
  '38': 'piano',       // Elegant Piano
  '39': 'instrumental',// Heartfelt Melodies
  '40': 'instrumental',// Thoughtful
  '41': 'ambient',     // Serenity
  '42': 'instrumental',// Touching Moments
  '43': 'instrumental',// Christmas
  '44': 'classical',   // Danse Macabre
  '45': 'experimental',// Dark World
  '46': 'classical',   // Famous Classics
  '47': 'piano',       // Mad Pianist
  '48': 'experimental',// Oddities
  '49': 'experimental',// Wonders of Other Worlds
  '52': 'world',       // Western European
  '54': 'world',       // Polynesian
  '56': 'latin',       // Brazilian
  '999': null,         // not in a collection
};

let _allPieces = null;

async function loadPieces() {
  if (_allPieces) return _allPieces;
  const res = await fetch(PIECES_URL, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`incompetech ${res.status} on ${PIECES_URL}`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error('incompetech pieces.json: unexpected shape');
  _allPieces = data;
  return _allPieces;
}

function cleanString(s) {
  if (s == null) return '';
  return String(s).replace(/[\r\n]+/g, ' ').trim();
}

function parseHmsLength(s) {
  if (!s || typeof s !== 'string') return null;
  const parts = s.trim().split(':').map((n) => parseInt(n, 10));
  if (parts.some((n) => Number.isNaN(n))) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] || null;
}

function normalizePiece(p) {
  if (!p || (!p.uuid && !p.isrc) || !p.filename) return null;
  const title = cleanString(p.title);
  if (!title) return null;
  const externalId = String(p.uuid || p.isrc).slice(0, 128);
  const fileEnc = encodeURIComponent(p.filename);
  const stream = `${MP3_BASE}${fileEnc}`;
  const genre = COLLECTION_TO_GENRE[String(p.genre)] ?? null;
  return {
    external_id: externalId,
    source: 'incompetech',
    title: title.slice(0, 510),
    artist_name: 'Kevin MacLeod',
    genre: null,
    _genre_hint: genre,
    duration_seconds: parseHmsLength(p.length),
    stream_url: stream,
    download_url: stream,
    license: 'cc-by',
    artwork_url: null,
  };
}

export async function fetchTracksPage(_query, page = 1, perPage = 200) {
  const pieces = await loadPieces();
  const start = (page - 1) * perPage;
  if (start >= pieces.length) return [];
  const slice = pieces.slice(start, start + perPage);
  return slice.map(normalizePiece).filter(Boolean);
}
