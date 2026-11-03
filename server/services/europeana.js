// Europeana Sound — European cultural-heritage aggregator with mixed
// licensing across many national archives. Filters aggressively in the
// search query (TYPE:SOUND + permissive RIGHTS) and again post-fetch
// (real audio extension, no spoken-word subjects, only.
//
// Requires EUROPEANA_API_KEY in env. Free tier; registration is fast.
// If unset, the indexer driver skips this source cleanly via
// EuropeanaNotConfigured.

const BASE = 'https://api.europeana.eu/record/v2/search.json';
const UA = 'LumpyLP catalog indexer (https://lumpylp.com)';

// Single query over the whole TYPE:SOUND + permissive-licenses corpus.
// One indexer "page" maps to one Europeana 100-row page.
export const EUROPEANA_QUERIES = [{ name: 'sound-permissive' }];

export class EuropeanaNotConfigured extends Error {
  constructor() { super('EUROPEANA_API_KEY not set'); this.code = 'EUROPEANA_NOT_CONFIGURED'; }
}

const POLITE_DELAY_MS = 800;
let lastFetchAt = 0;

const AUDIO_EXT = /\.(mp3|ogg|oga|flac|wav|m4a)(\?|$)/i;

const SPOKEN_SUBJECT_TERMS = [
  'spoken word', 'lecture', 'interview', 'speech',
  'oral history', 'language learning', 'audiobook', 'podcast',
];

const RIGHTS_FILTERS = [
  'http://creativecommons.org/licenses/by/*',
  'http://creativecommons.org/licenses/by-sa/*',
  'http://creativecommons.org/publicdomain/*',
  'http://creativecommons.org/licenses/by-nc/*',
  'http://creativecommons.org/licenses/by-nc-sa/*',
  'http://creativecommons.org/licenses/by-nc-nd/*',
  'http://creativecommons.org/licenses/by-nd/*',
  'http://creativecommons.org/publicdomain/zero/*',
];

async function politeFetch(url) {
  const wait = POLITE_DELAY_MS - (Date.now() - lastFetchAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastFetchAt = Date.now();
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json' },
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error(`europeana auth ${res.status} — check EUROPEANA_API_KEY`);
  }
  if (res.status === 429) {
    const retry = Number(res.headers.get('retry-after') || 5);
    await new Promise((r) => setTimeout(r, retry * 1000));
    return politeFetch(url);
  }
  if (!res.ok) throw new Error(`europeana ${res.status} on ${url}`);
  return res.json();
}

// Europeana fields can be plain strings, plain arrays, or
// language-keyed maps ({def: [...], en: [...]}). pickFirst flattens all
// shapes to the first non-empty trimmed string we find.
function pickFirst(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (Array.isArray(v)) {
    for (const x of v) {
      const got = pickFirst(x);
      if (got) return got;
    }
    return null;
  }
  if (typeof v === 'object') {
    // Try common preferred-language keys first, then anything else.
    const langs = ['en', 'eng', 'def', ...Object.keys(v)];
    const seen = new Set();
    for (const k of langs) {
      if (seen.has(k) || !(k in v)) continue;
      seen.add(k);
      const got = pickFirst(v[k]);
      if (got) return got;
    }
  }
  return null;
}

function flatStrings(v) {
  if (v == null) return [];
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) {
    const out = [];
    for (const x of v) for (const s of flatStrings(x)) out.push(s);
    return out;
  }
  if (typeof v === 'object') {
    const out = [];
    for (const k of Object.keys(v)) for (const s of flatStrings(v[k])) out.push(s);
    return out;
  }
  return [];
}

// ISO-8601 duration ("PT4M3S") or ms-string ("243000") or seconds-string.
function parseDuration(v) {
  if (v == null) return null;
  const s = String(Array.isArray(v) ? v[0] : v).trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) {
    const n = parseInt(s, 10);
    // Europeana sometimes stores millis in this field.
    return n > 100000 ? Math.round(n / 1000) : n;
  }
  const m = s.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/i);
  if (m) {
    const h = parseInt(m[1] || '0', 10);
    const min = parseInt(m[2] || '0', 10);
    const sec = parseFloat(m[3] || '0');
    return Math.round(h * 3600 + min * 60 + sec);
  }
  return null;
}

function isSpokenWordItem(item) {
  const haystack = [
    ...flatStrings(item.dcSubject),
    ...flatStrings(item.dcType),
    ...flatStrings(item.dcDescription),
  ].join(' ').toLowerCase();
  return SPOKEN_SUBJECT_TERMS.some((term) => haystack.includes(term));
}

function chooseStreamUrl(item) {
  // edmIsShownBy is the canonical streamable URL. webResource is the
  // fallback array of all attached resources. Prefer the first audio-ext
  // entry; reject if none qualifies.
  const candidates = [
    ...flatStrings(item.edmIsShownBy),
    ...flatStrings(item.webResource),
  ];
  for (const u of candidates) {
    if (typeof u === 'string' && AUDIO_EXT.test(u)) return u;
  }
  return null;
}

function normalize(item) {
  if (!item || !item.id) return null;
  if (isSpokenWordItem(item)) return null;

  const stream = chooseStreamUrl(item);
  if (!stream) return null;

  const title = pickFirst(item.title) || pickFirst(item.dcTitle);
  if (!title) return null;

  const artist = pickFirst(item.dcCreator)
    || pickFirst(item.edmAgentLabel)
    || pickFirst(item.dcContributor)
    || 'Unknown';

  // Subject array becomes the genre hint — let genre-mapper coerce it.
  const subjectHint = pickFirst(item.dcSubject);

  // Europeana's RIGHTS field is one or more CC URLs. quality-gate's
  // normalizeLicense handles the URL form natively.
  const license = pickFirst(item.rights) || pickFirst(item.edmRights) || null;

  const duration = parseDuration(item.edmEbucoreDuration);
  const artwork = pickFirst(item.edmPreview) || null;

  return {
    external_id: String(item.id).slice(0, 128),
    source: 'europeana',
    title: title.slice(0, 510),
    artist_name: artist.slice(0, 250),
    genre: null,
    _genre_hint: subjectHint,
    duration_seconds: duration,
    stream_url: stream,
    download_url: stream,
    license,
    artwork_url: artwork,
  };
}

export async function fetchTracksPage(_query, page = 1, perPage = 100) {
  const key = process.env.EUROPEANA_API_KEY;
  if (!key) throw new EuropeanaNotConfigured();

  // Europeana paginates with `start` (1-indexed) + `rows`.
  const start = (page - 1) * perPage + 1;
  const params = new URLSearchParams({
    wskey: key,
    query: '*:*',
    rows: String(perPage),
    start: String(start),
    profile: 'standard',
  });
  params.append('qf', 'TYPE:SOUND');
  params.append('qf', `RIGHTS:(${RIGHTS_FILTERS.map((r) => `"${r}"`).join(' OR ')})`);

  const url = `${BASE}?${params.toString()}`;
  const data = await politeFetch(url);
  const items = Array.isArray(data?.items) ? data.items : [];
  return items.map(normalize).filter(Boolean);
}
