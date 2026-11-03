// Wikimedia Commons audio source.
//
// Two query modes:
//   - { term: 'classical music' } → list=search filetype:audio
//   - { category: 'Audio files of jazz', recurse: 0|1 } → CategoryMembers
//
// The category mode (added in Phase 15B) is much higher recall than
// search; the existing search-based queries are kept for backwards
// compatibility but the categoryMembers sweep is what drives the bulk
// expansion past 2,591 rows.

import { lookupArtist } from '../lib/wikimediaLocation.js';

const API = 'https://commons.wikimedia.org/w/api.php';

// Wikimedia's User-Agent policy requires a contact for indexing tools.
const UA = `LumpyLP catalog indexer/1.0 (https://lumpylp.com; ${process.env.INDEXER_CONTACT_EMAIL || 'takedowns@lumpylp.com'})`;

// Wikimedia returns "application/ogg" for ogg audio (and "audio/*" for the rest).
function isAudioMime(mime) {
  if (!mime || typeof mime !== 'string') return false;
  return mime.startsWith('audio/') || mime === 'application/ogg';
}

const GENRE_ALLOWLIST = new Set([
  'ambient', 'bass', 'beat', 'blues', 'chiptune', 'classical', 'country', 'drone',
  'electronic', 'electro', 'experimental', 'folk', 'funk', 'game', 'gospel', 'guitar',
  'hip hop', 'hip-hop', 'hiphop', 'house', 'indie', 'instrumental', 'jazz', 'lofi',
  'lo-fi', 'metal', 'noise', 'opera', 'piano', 'pop', 'punk', 'r&b', 'rnb', 'rap',
  'reggae', 'rock', 'soul', 'soundtrack', 'spoken word', 'synthwave', 'techno',
  'trap', 'world', 'acoustic', 'choral', 'comedy', 'dance', 'disco', 'dub',
  'garage', 'grunge', 'hardrock', 'industrial', 'latin', 'minimalist', 'new age',
  'orchestral', 'post-rock', 'shoegaze', 'ska', 'swing',
]);

// Categories whose members are NOT music. Reject any file that lives in
// one of these (case-insensitive substring match against each category
// title in the file's extmetadata.Categories).
const REJECT_CATEGORY_PATTERNS = [
  /pronunciation/i,
  /\bspeech\b/i,
  /spoken[ -]word/i,
  /audiobook/i,
  /podcast/i,
  /\binterview\b/i,
  /\blecture\b/i,
  /sound\s+effect/i,
  /animal\s+sound/i,
  /bird\s+song/i,
  /\bsiren/i,
];

// ─── Search-mode queries (legacy; kept for backwards compatibility) ───
const SEARCH_QUERIES = [
  { name: 'classical',   term: 'classical music' },
  { name: 'folk',        term: 'folk music' },
  { name: 'jazz',        term: 'jazz' },
  { name: 'world',       term: 'world music' },
  { name: 'piano',       term: 'piano' },
  { name: 'orchestral',  term: 'orchestral' },
  { name: 'opera',       term: 'opera' },
  { name: 'traditional', term: 'traditional music' },
];

// Phase 17: non-English term queries. The Phase 15C Search-mode queries
// were all English, so non-English-language music titles + descriptions
// were under-represented. Wikimedia's filetype:audio search applies
// language-agnostic, so these surface tracks where English wouldn't.
const NON_ENGLISH_SEARCH_QUERIES = [
  { name: 'es:musica',   term: 'música' },     // Spanish/Portuguese
  { name: 'fr:musique',  term: 'musique' },    // French
  { name: 'de:musik',    term: 'musik' },      // German/Scandi
  { name: 'jp:ongaku',   term: '音楽' },        // Japanese
  { name: 'ar:musiqi',   term: 'موسيقى' },     // Arabic
  { name: 'ru:muzyka',   term: 'музыка' },     // Russian
  { name: 'zh:yinyue',   term: '音乐' },        // Chinese
  { name: 'hi:sangit',   term: 'संगीत' },      // Hindi
];

// ─── Category-mode queries (Phase 15B deeper pull) ──────────────────
//
// The original spec'd categories ("Audio files of jazz", etc.) don't exist
// on Commons — verified by direct probe. The real organizing nodes are
// recursing parents under "Audio files of music by …". Using the recurse=1
// path: each "page" of the indexer advances through one subcategory of
// the parent, taking up to perPage files from it.
//
// Phase 17 additions:
//   - cat:by-composer — "Audio files of music by composer" (verified)
//   - cat:year-1901..1925 — "Audio files of YYYY" — the actual existing
//     names (probed; "Audio files of music from YYYY" do NOT exist).
//     Years 1900 and 1899 don't have category pages so they're skipped;
//     1901-1925 all exist.
//
// "Music files" was spec'd as a top-level recurse parent but doesn't
// exist on Commons — recursing "Audio files" or "Music" themselves
// would pull in heavy non-music subtrees, so we don't.
const CATEGORY_QUERIES = [
  { name: 'cat:by-genre',      category: 'Audio files of music by genre',      recurse: 1, genre: null },
  { name: 'cat:by-country',    category: 'Audio files of music by country',    recurse: 1, genre: null },
  { name: 'cat:by-instrument', category: 'Audio files of music by instrument', recurse: 1, genre: null },
  { name: 'cat:by-composer',   category: 'Audio files of music by composer',   recurse: 1, genre: 'classical' },
];

const YEAR_CATEGORY_QUERIES = (() => {
  const out = [];
  for (let y = 1901; y <= 1925; y++) {
    out.push({ name: `cat:year-${y}`, category: `Audio files of ${y}`, recurse: 0, genre: null });
  }
  return out;
})();

export const WIKIMEDIA_QUERIES = [
  ...SEARCH_QUERIES,
  ...NON_ENGLISH_SEARCH_QUERIES,
  ...CATEGORY_QUERIES,
  ...YEAR_CATEGORY_QUERIES,
];

async function getJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Wikimedia ${res.status} on ${url}`);
  return res.json();
}

function stripHTML(s) {
  return String(s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function titleToReadable(pageTitle) {
  return pageTitle
    .replace(/^File:/, '')
    .replace(/\.(mp3|ogg|oga|flac|wav)$/i, '')
    .replace(/_/g, ' ')
    .trim();
}

// Pull a plausible artist name out of a Wikimedia file title when the
// extmetadata didn't carry one. Strips File: prefix, common track-number
// patterns ("01 - ", "Track 02_"), and the file extension; collapses
// underscores. Returns the cleaned candidate (possibly empty/garbage —
// plausibleArtistName() makes the final keep/skip call).
function artistFromFilename(pageTitle) {
  let s = String(pageTitle || '').replace(/^File:/, '');
  s = s.replace(/\.(mp3|ogg|oga|flac|wav)$/i, '');
  s = s.replace(/^(?:track[\s_-]+)?\d{1,3}(?:[\s_.\-]+)/i, '');
  s = s.replace(/_/g, ' ').trim();
  // Many wikimedia titles are "Composer - Work - Movement". The leading
  // segment is usually the artist/composer, so split on first " - ".
  const dash = s.indexOf(' - ');
  if (dash > 1) s = s.slice(0, dash).trim();
  return s;
}

// "Plausible" = has at least one letter, isn't absurdly long or short,
// isn't obviously not-a-name. Keeps the gate's "artist has no letters"
// rule from triggering on filename-derived garbage.
function plausibleArtistName(s) {
  if (typeof s !== 'string') return false;
  const t = s.trim();
  if (t.length < 3 || t.length > 80) return false;
  if (!/[a-z]/i.test(t)) return false;
  // Reject pure dates, URL-looking strings, and "Untitled" placeholders.
  if (/^\d+(\.\d+)?$/.test(t)) return false;
  if (/^https?:\/\//i.test(t)) return false;
  if (/^untitled$/i.test(t)) return false;
  return true;
}

function genreFromQuery(query) {
  if (query.genre) return query.genre;
  const candidates = [query.name, query.term, query.category];
  for (const c of candidates) {
    const lower = String(c || '').toLowerCase();
    if (GENRE_ALLOWLIST.has(lower)) return lower;
    const trimmed = lower.replace(/\s+music$/, '').trim();
    if (GENRE_ALLOWLIST.has(trimmed)) return trimmed;
  }
  return null;
}

// Read extmetadata.Categories — Wikimedia returns it as a pipe-delimited
// string. Returns true if any of the file's categories matches a reject
// pattern (spoken word, sound effects, etc.).
function isRejectByCategory(extmeta) {
  const cats = extmeta?.Categories?.value;
  if (!cats || typeof cats !== 'string') return false;
  return REJECT_CATEGORY_PATTERNS.some((re) => re.test(cats));
}

// Map Wikimedia's LicenseShortName / LicenseUrl onto our canonical buckets.
// The quality-gate's normalizeLicense will be the final arbiter, but we
// pre-normalize so the upsert stores something sensible even if a row
// lands without going through the gate.
export function wikimediaLicense(extmeta) {
  return (extmeta && readLicense(extmeta)) || null;
}

function readLicense(extmeta) {
  if (!extmeta) return null;
  const url = extmeta.LicenseUrl?.value;
  const short = extmeta.LicenseShortName?.value;
  return url || short || null;
}

function normalize(p, query) {
  if (!p || !p.title) return null;
  const info = Array.isArray(p.imageinfo) ? p.imageinfo[0] : null;
  if (!info || !info.url) return null;
  if (!isAudioMime(info.mime)) return null;

  const ext = info.extmetadata && typeof info.extmetadata === 'object' ? info.extmetadata : {};
  if (isRejectByCategory(ext)) return null;

  const metaArr = Array.isArray(info.metadata) ? info.metadata : [];
  const metaMap = new Map();
  for (const m of metaArr) if (m && typeof m.name === 'string') metaMap.set(m.name, m.value);

  const extVal = (k) => (ext[k] && typeof ext[k].value === 'string' ? ext[k].value : '');

  // Phase 15C: extended artist fallback. Wikimedia files frequently lack
  // Artist/Author but have a UploadedBy attribution or a filename that
  // reads naturally as an artist credit ("Beethoven_Op30_No1_1.ogg").
  // Try in order, keep the first non-empty plausible value; fall through
  // to "Unknown" so the quality gate makes the final reject call.
  const candidates = [
    extVal('Artist'),
    extVal('Author'),
    metaMap.get('Artist'),
    metaMap.get('Author'),
    extVal('UploadedBy'),
    extVal('ObjectName'),
    artistFromFilename(p.title),
  ];
  let artist = 'Unknown';
  for (const c of candidates) {
    const cleaned = stripHTML(c).trim();
    if (cleaned && plausibleArtistName(cleaned)) {
      artist = cleaned;
      break;
    }
  }

  const lengthRaw = metaMap.get('length') || metaMap.get('playtime_seconds');
  const length = lengthRaw != null ? parseFloat(lengthRaw) : NaN;
  const duration = isFinite(length) && length > 0 ? Math.round(length) : null;

  // Only a license Commons actually states. No license means the quality
  // gate rejects the file (the old fallback to 'public-domain' was removed:
  // owner decision 6, migration 020).
  const license = wikimediaLicense(ext);

  return {
    external_id: String(p.title).slice(0, 128),
    source: 'wikimedia',
    title: titleToReadable(p.title).slice(0, 510) || 'Untitled',
    artist_name: artist.slice(0, 250),
    genre: genreFromQuery(query),
    duration_seconds: duration,
    stream_url: info.url,
    download_url: info.url,
    license,
    artwork_url: null,
  };
}

// ─── Search-mode (legacy) ──────────────────────────────────────────
async function fetchByTerm(query, page, perPage) {
  const sroffset = (page - 1) * perPage;
  const searchUrl =
    `${API}?action=query&format=json` +
    `&list=search&srsearch=${encodeURIComponent(`filetype:audio ${query.term}`)}` +
    `&srnamespace=6&srlimit=${perPage}&sroffset=${sroffset}`;
  const searchData = await getJSON(searchUrl);
  const results = searchData?.query?.search || [];
  if (!results.length) return [];
  return enrichTitles(results.map((r) => r.title), query);
}

// ─── Category-mode (Phase 15B) ─────────────────────────────────────
//
// CategoryMembers is page-token-paginated, not offset-paginated. We
// thread tokens through the indexer's page=1..N driver via an in-memory
// cache keyed by (queryName, page). This lets the existing pageDelayMs
// + earlyExitOnShortPage flow drive the iteration without a custom loop.
const _categoryCursor = new Map();

async function fetchByCategory(query, page, perPage) {
  const cursorKey = query.name;
  // Page 1 always starts from no-cursor; subsequent pages use the saved
  // cmcontinue token from the previous page.
  let cmcontinue = null;
  if (page > 1) {
    const prev = _categoryCursor.get(cursorKey);
    if (!prev) return []; // we ran past the end already
    cmcontinue = prev;
  } else {
    _categoryCursor.delete(cursorKey);
  }

  // Recurse=1: first iteration of the parent category lists subcategories
  // (cmtype=subcat). For each subcat, we recurse one level into its files.
  // Implement recursion as a synchronous pre-walk: page 1 of the parent
  // returns the union of file-members from a *batch* of subcategories.
  if (query.recurse) {
    return fetchByRecursingCategory(query, page, perPage);
  }

  const titles = await listCategoryFiles(query.category, perPage, cmcontinue, cursorKey);
  if (!titles.length) return [];
  return enrichTitles(titles, query);
}

async function listCategoryFiles(category, limit, cmcontinue, cursorKey) {
  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    list: 'categorymembers',
    cmtitle: `Category:${category}`,
    cmtype: 'file',
    cmlimit: String(limit),
  });
  if (cmcontinue) params.set('cmcontinue', cmcontinue);
  const data = await getJSON(`${API}?${params.toString()}`);
  const members = data?.query?.categorymembers || [];

  if (cursorKey) {
    const next = data?.continue?.cmcontinue;
    if (next) _categoryCursor.set(cursorKey, next);
    else _categoryCursor.delete(cursorKey);
  }
  return members.map((m) => m.title);
}

// Cache subcategory list for a recursing parent so each "page" advances
// through one subcategory at a time.
const _subcatCache = new Map();
const _subcatIndex = new Map();

async function fetchByRecursingCategory(query, page, perPage) {
  let subcats = _subcatCache.get(query.name);
  if (!subcats) {
    subcats = await listSubcategories(query.category);
    _subcatCache.set(query.name, subcats);
    _subcatIndex.set(query.name, 0);
  }
  const idx = _subcatIndex.get(query.name) || 0;
  if (idx >= subcats.length) return [];

  const subcat = subcats[idx];
  _subcatIndex.set(query.name, idx + 1);

  // For each subcategory, take up to `perPage` files. Don't paginate
  // the subcategory itself — keep the page-vs-subcategory mapping 1:1.
  const titles = await listCategoryFiles(subcat, perPage, null, null);
  if (!titles.length) return [];
  return enrichTitles(titles, { ...query, category: subcat });
}

async function listSubcategories(category) {
  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    list: 'categorymembers',
    cmtitle: `Category:${category}`,
    cmtype: 'subcat',
    cmlimit: '500',
  });
  const data = await getJSON(`${API}?${params.toString()}`);
  const members = data?.query?.categorymembers || [];
  return members
    .map((m) => m.title)
    .filter((t) => t.startsWith('Category:'))
    .map((t) => t.slice('Category:'.length));
}

// ─── Shared title-batch enrichment ─────────────────────────────────
//
// Wikimedia caps GET URLs around 8KB and our title batches blow past
// that with longer file names — switch to POST with form-encoded body
// (the API explicitly supports it) so titles= can carry kilobytes.
async function enrichTitles(titles, query) {
  if (!titles.length) return [];
  const body = new URLSearchParams({
    action: 'query',
    format: 'json',
    titles: titles.join('|'),
    prop: 'imageinfo',
    iiprop: 'url|size|mime|metadata|extmetadata',
  });
  const res = await fetch(API, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`Wikimedia POST imageinfo ${res.status}`);
  const infoData = await res.json();
  const pages = infoData?.query?.pages || {};
  return Object.values(pages).map((p) => normalize(p, query)).filter(Boolean);
}

// Phase 17.8: per-artist Wikidata lookup. Wikimedia Commons doesn't carry
// artist origin/citizenship in file metadata, so we hit Wikidata's Action
// API (wbsearchentities + wbgetentities) once per unique artist name.
// Process-wide cache (positive + negative) makes repeat artists across
// pages free. Lossy by design — when search misses or the candidate label
// doesn't match the artist name closely, we skip rather than guess.
async function attachArtistLocations(tracks) {
  const uniq = [...new Set(
    tracks
      .map((t) => t.artist_name)
      .filter((n) => n && n !== 'Unknown')
  )];
  for (const name of uniq) {
    const loc = await lookupArtist(name);
    if (!loc) continue;
    for (const t of tracks) {
      if (t.artist_name === name) {
        t._artist_location_raw = loc.raw;
        t._artist_country = loc.country;
        t._artist_city = loc.city;
        t._artist_location_source = 'wikidata';
      }
    }
  }
}

// ─── Entry point ─────────────────────────────────────────────────
export async function fetchTracksPage(query, page = 1, perPage = 50) {
  if (!query) return [];
  let tracks;
  if (query.category) tracks = await fetchByCategory(query, page, perPage);
  else if (query.term) tracks = await fetchByTerm(query, page, perPage);
  else return [];
  await attachArtistLocations(tracks);
  return tracks;
}
