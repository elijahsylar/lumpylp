// Library of Congress audio collections.
//
// Phase 15B started here with just the National Jukebox; Phase 17
// expands to the broader American Folklife Center plus its named
// sub-collections (California Gold / Sidney Robertson Cowell, the
// Lomax 1939 Southern States trip, and the Alan Lomax Michigan and
// Wisconsin recordings).
//
// The source name in the DB stays 'loc_jukebox' for backward compat
// with the 9,200 rows already ingested in Phase 15B. The file name is
// kept too — renaming would only churn imports.
//
// Two flavors of LoC search results:
//   - "jukebox-style" — search response includes a direct streamable
//     media URL in resources[0].media (one fetch per page).
//   - "AFC-style" — search response gives a /resource/<id>/ catalog
//     URL but no media URL; we have to fetch that page (?fo=json) to
//     get the mp3 download. One extra HTTP per item, gated at the
//     same 1s politeness as the search calls.
//
// Same license rule for both: only ingest items whose rights field
// contains "public domain" or "no known copyright". The jukebox set
// is curated PD so this is a no-op there; for AFC sub-collections it
// rejects the occasional restricted item.

const BASE = 'https://www.loc.gov/audio/';
const UA = 'LumpyLP/0.1 (+https://lumpylp.com)';

// National Jukebox lives in the catalog already; do NOT re-run it in
// Phase 17 (spec). Phase 17 query list focuses on the new AFC slices.
//
// Each query: { name, partof, requireMusicSubject? }
//   partof — string used in the LoC fa=partof:<v> filter, with spaces
//            joined as '+' (LoC's URL convention).
//   requireMusicSubject — when true, the per-item filter requires at
//            least one music-positive subject and no music-negative
//            subject. Curated sub-collections (California Gold, the
//            Lomax recordings) are uniformly music so don't need it;
//            broad-AFC needs it because the umbrella partof includes
//            interviews and oral histories alongside music.
export const LOC_JUKEBOX_QUERIES = [
  {
    name: 'california-gold',
    partof: 'california+gold:+northern+california+folk+music+from+the+thirties+collected+by+sidney+robertson+cowell',
  },
  {
    name: 'lomax-1939-southern',
    partof: 'southern+mosaic:+the+john+and+ruby+lomax+1939+southern+states+recording+trip',
  },
  {
    name: 'lomax-mi-wi',
    partof: 'alan+lomax+collection+of+michigan+and+wisconsin+recordings',
  },
  {
    name: 'american-folklife-center',
    partof: 'american+folklife+center',
    requireMusicSubject: true,
  },
];

// Phase 17: bumped from 1000ms after empirical 429 storms during the
// first live ingestion. LoC's docs claim a soft cap of ~5/s, but
// per-item /resource/ enrichment hits a stricter limit; 3s between
// calls keeps the window comfortably under whatever cap they're
// applying. Combined with the longer per-call retry budget below
// this lets a full LoC sweep run end-to-end (2-4h expected) without
// individual queries giving up after the first throttle event.
const PAGE_DELAY_MS = 3000;
let lastFetchAt = 0;

const MUSIC_SUBJECT_POSITIVE = [
  'song', 'ballad', 'spiritual', 'music', 'fiddle', 'banjo',
  'singing', 'tune', 'folk', 'gospel', 'hymn', 'chant',
  'jig', 'reel', 'lullab', 'work song', 'sea song', 'shanty',
  'dance music', 'instrument', 'guitar', 'piano', 'mandolin',
  'harmonica', 'drum', 'choir',
];

const MUSIC_SUBJECT_NEGATIVE = [
  'interview', 'oral history', 'lecture', 'speech', 'sermon',
  'reading', 'storytelling', 'narration', 'recitation',
  'language learning',
];

// Phrases LoC uses to express "this is essentially PD / no known
// copyright restrictions". The American Folklife Center's standard
// advisory ("the Library of Congress is not aware of any U.S.
// copyright protection") is functionally the same as the explicit
// "no known copyright restrictions" wording; both are accepted.
const PD_RIGHTS_TERMS = [
  'public domain',
  'no known copyright',
  'free to use and reuse',
  'no copyright restrictions',
  'not aware of any u.s. copyright',
  'not aware of any copyright',
];

// Backoff schedule (in ms) on 429 / 5xx — total ~7.5min retry budget
// per call before we give up. LoC's throttle cooldowns can sit in the
// 30-120s range, so anything shorter just burns retries and gives up
// before LoC re-opens the window.
const RETRY_BACKOFFS_MS = [30_000, 60_000, 120_000, 240_000];

async function politeFetch(url, attempt = 0) {
  const wait = PAGE_DELAY_MS - (Date.now() - lastFetchAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastFetchAt = Date.now();
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json' },
  });
  if ((res.status === 429 || res.status >= 500) && attempt < RETRY_BACKOFFS_MS.length) {
    const retryAfter = Number(res.headers.get('retry-after') || 0);
    const scheduled = RETRY_BACKOFFS_MS[attempt];
    // Honor Retry-After when LoC sets one, but never wait LESS than the
    // scheduled backoff — they sometimes set Retry-After:5 even when
    // the real cooldown is much longer.
    const backoff = Math.max(scheduled, retryAfter * 1000);
    await new Promise((r) => setTimeout(r, backoff));
    return politeFetch(url, attempt + 1);
  }
  if (!res.ok) throw new Error(`loc ${res.status} on ${url}`);
  return res.json();
}

function hasMusicSubject(subjects) {
  if (!Array.isArray(subjects) || subjects.length === 0) return false;
  const lc = subjects.map((s) => String(s || '').toLowerCase());
  if (lc.some((s) => MUSIC_SUBJECT_NEGATIVE.some((t) => s.includes(t)))) return false;
  return lc.some((s) => MUSIC_SUBJECT_POSITIVE.some((t) => s.includes(t)));
}

function rightsIsPermissive(raw) {
  if (raw == null) return false;
  // rights can be string or array of strings; flatten and lowercase.
  const arr = Array.isArray(raw) ? raw : [raw];
  const joined = arr.map((s) => String(s || '').toLowerCase()).join(' ');
  return PD_RIGHTS_TERMS.some((term) => joined.includes(term));
}

// Fetch a /resource/<id>/ JSON page and return { stream, rights }
// for the embedded mp3, or null if no streamable mp3 is found.
async function fetchResourceEnrichment(resourceUrl) {
  const url = resourceUrl.endsWith('/') ? `${resourceUrl}?fo=json` : `${resourceUrl}/?fo=json`;
  let data;
  try {
    data = await politeFetch(url);
  } catch (e) {
    return null;
  }
  // The mp3 download URL lives at resource.files[*][*].download. The
  // double-array is LoC's "asset groups -> renditions" shape.
  const groups = data?.resource?.files;
  if (!Array.isArray(groups)) return null;
  let stream = null;
  for (const group of groups) {
    if (!Array.isArray(group)) continue;
    for (const file of group) {
      const dl = file && (file.download || file.derivativeUrl);
      if (typeof dl === 'string' && /\.mp3(\?|$)/i.test(dl)) {
        stream = dl;
        break;
      }
    }
    if (stream) break;
  }
  if (!stream) return null;
  return { stream, rights: data?.item?.rights || null };
}

// License label and hide reason for a new LoC row (relaunch item 6).
// National Jukebox items (jukebox-NNN) are streamed by LoC under a license
// from Sony: not public domain, streaming on loc.gov only. American Folklife
// Center items keep LoC's own permissive label but stay hidden until
// scripts/check-loc-rights.js has checked each rights statement.
export function locLicenseFor(externalId) {
  return /^jukebox-/.test(String(externalId))
    ? { license: 'loc-jukebox-stream-only', hidden_reason: 'rights_loc_jukebox' }
    : { license: 'public-domain', hidden_reason: 'rights_check_pending' };
}

async function normalizeLocItem(r, query) {
  if (!r || !r.id) return null;

  // Subject filter (only when query requires it — sub-collections like
  // California Gold are music-only by construction).
  if (query.requireMusicSubject && !hasMusicSubject(r.subject)) return null;

  // Stable external_id from the LoC item URL.
  const extId = extractItemId(r.id);
  if (!extId) return null;

  // Try direct media first (jukebox-style). If absent, enrich via the
  // /resource/<id>/ JSON page (AFC-style).
  const resources = Array.isArray(r.resources) ? r.resources : [];
  let stream = null;
  let rights = r.rights;
  const audioRes = resources.find(
    (res) => res && typeof res.media === 'string' && /\.mp3/i.test(res.media)
  );
  if (audioRes) {
    stream = audioRes.media;
  } else {
    const firstRes = resources[0];
    if (firstRes && typeof firstRes.url === 'string') {
      const enriched = await fetchResourceEnrichment(firstRes.url);
      if (!enriched) return null;
      stream = enriched.stream;
      if (enriched.rights) rights = enriched.rights;
    }
  }
  if (!stream) return null;

  // License gate: rights field must contain a permissive marker. If we
  // got rights from the resource enrichment (HTML <p> wrapper) the
  // rightsIsPermissive lowercase-substring check still works.
  if (!rightsIsPermissive(rights)) return null;

  // Artist resolution. contributor_primary is the most reliable but
  // not always present; fall back to the first contributor. Names come
  // back lowercased — title-case them so the catalog stays consistent.
  const artistRaw = pickFirst(r.contributor_primary, r.contributor);
  const artist = titleCaseArtist(artistRaw);

  const genreHint = Array.isArray(r.subject) && r.subject.length
    ? r.subject.find((s) => typeof s === 'string' && s.length > 0) || null
    : null;

  const artwork = Array.isArray(r.image_url) && r.image_url.length
    ? String(r.image_url[0]).split('#')[0]
    : null;

  return {
    external_id: extId,
    source: 'loc_jukebox',
    title: String(r.title || 'Untitled').slice(0, 510),
    artist_name: (artist || 'Unknown').slice(0, 250),
    genre: null,
    _genre_hint: genreHint,
    duration_seconds: null,
    stream_url: stream,
    download_url: stream,
    ...locLicenseFor(extId),
    artwork_url: artwork,
  };
}

export async function fetchTracksPage(query, page = 1, perPage = 100) {
  if (!query || !query.partof) return [];
  const url = `${BASE}?fa=partof:${query.partof}&fo=json&c=${perPage}&sp=${page}`;
  const data = await politeFetch(url);
  const results = Array.isArray(data?.results) ? data.results : [];
  // Sequential per-item enrichment so we keep the politeness window.
  const out = [];
  for (const r of results) {
    const t = await normalizeLocItem(r, query);
    if (t) out.push(t);
  }
  return out;
}

function extractItemId(idUrl) {
  // "http://www.loc.gov/item/jukebox-254546/" -> "jukebox-254546"
  // "http://lccn.loc.gov/2008700302" -> "2008700302"
  const item = String(idUrl).match(/\/item\/([^\/]+)/);
  if (item) return item[1];
  const lccn = String(idUrl).match(/lccn\.loc\.gov\/(\S+?)\/?$/);
  if (lccn) return `lccn-${lccn[1]}`;
  return null;
}

function pickFirst(...vals) {
  for (const v of vals) {
    if (v == null) continue;
    if (Array.isArray(v) && v.length) {
      const first = v.find((x) => typeof x === 'string' && x.trim());
      if (first) return first.trim();
    }
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

function titleCaseArtist(raw) {
  if (!raw) return null;
  // LoC contributors come back as "lastname, firstname" lowercased.
  // Title-case each word; preserve the comma so the original ordering reads.
  return raw
    .split(/(\s+|,)/)
    .map((tok) => {
      if (/^\s+$/.test(tok) || tok === ',') return tok;
      if (!tok) return tok;
      return tok.charAt(0).toUpperCase() + tok.slice(1).toLowerCase();
    })
    .join('');
}
