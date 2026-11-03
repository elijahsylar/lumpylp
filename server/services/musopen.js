// Musopen — public-domain & CC classical recordings via api.musopen.org/v2.
//
// The /recordings endpoint works WITHOUT an API key. Unauthenticated access
// is hard-capped at page_size=10; if MUSOPEN_API_KEY is set we still send
// it (graceful upgrade path for higher rate limits) but the indexer no
// longer requires it.
//
// We hit three license slices — CC-BY, CC-BY-SA, CC-PD — and hard-skip
// CC-BY-NC at the API level. Musopen stays strict by project policy;
// ccMixter is the project's CC-BY-NC source by design.
//
// DRF cursor pagination, not offset: the service ignores the indexer's
// `page` argument and tracks cursor state per query in a module-local
// Map. Page=1 always restarts the walk from the base URL so re-runs
// don't continue from a stale cursor.
//
// musopen.org/* is Cloudflare-walled (403 + JS challenge) so the public
// `?format=json` listing some docs reference is unreachable. The v2 API
// is the only viable no-auth path.

const BASE = 'https://api.musopen.org/v2/recordings/';
const UA = 'LumpyLP catalog indexer (https://lumpylp.com)';
const PAGE_SIZE = 10; // unauth hard cap

// "European Archive" was a 2000s project that published 1950s-60s LP
// transfers as public domain under the EU's then 50-year rule. They are not
// public domain in the US, so new rows from it are ingested hidden
// (relaunch item 6; migration 018 hid the existing 2,179).
export function musopenHiddenReason({ artist_name, license }) {
  return /public.?domain/i.test(String(license)) && /European Archive/i.test(String(artist_name))
    ? 'rights_musopen_european_archive'
    : null;
}

export const MUSOPEN_QUERIES = [
  { name: 'cc-by',    license: 'CC-BY' },
  { name: 'cc-by-sa', license: 'CC-BY-SA' },
  { name: 'cc-pd',    license: 'CC-PD' },
];

// Map<query.name, { nextUrl: string|null, exhausted: boolean }>.
// Reset when the indexer calls with page=1.
const cursorState = new Map();

function startUrl(license) {
  return `${BASE}?license=${encodeURIComponent(license)}&page_size=${PAGE_SIZE}`;
}

async function fetchJson(url) {
  const headers = { 'User-Agent': UA, 'Accept': 'application/json' };
  const key = process.env.MUSOPEN_API_KEY;
  if (key) headers['Authorization'] = `Token ${key}`;

  const res = await fetch(url, { headers });
  if (res.status === 429) {
    const retry = Number(res.headers.get('retry-after') || 5);
    await new Promise((r) => setTimeout(r, retry * 1000));
    return fetchJson(url);
  }
  if (!res.ok) throw new Error(`musopen ${res.status} on ${url}`);
  return res.json();
}

export async function fetchTracksPage(query, page = 1) {
  if (!query || !query.license) return [];

  if (page === 1) {
    cursorState.set(query.name, { nextUrl: startUrl(query.license), exhausted: false });
  }

  const state = cursorState.get(query.name);
  if (!state || state.exhausted || !state.nextUrl) return [];

  const data = await fetchJson(state.nextUrl);
  const items = Array.isArray(data?.results) ? data.results : [];

  state.nextUrl = data?.next || null;
  state.exhausted = !state.nextUrl;
  cursorState.set(query.name, state);

  return items
    .map((r) => normalizeMusopenRecording(r, query.license))
    .filter(Boolean);
}

// Defensive allowlist — the slice-level API filter should already prevent
// strays, but we double-check in case the upstream ever returns mixed
// licenses. The quality-gate's normalizeLicense() handles `CC-PD` →
// `public-domain` and the CC-BY{,-SA} forms natively, so we pass through
// the raw string and let the gate canonicalize.
const ACCEPTED = new Set(['CC-BY', 'CC-BY-SA', 'CC-PD']);

function normalizeMusopenRecording(r, sliceLicense) {
  if (!r || (r.id == null && !r.slug)) return null;

  const rawLicense = String(r.license || sliceLicense || '').toUpperCase();
  if (!ACCEPTED.has(rawLicense)) return null;

  const stream = r.fileurl || r.hq_fileurl || null;
  if (!stream) return null;

  const performer = pickName(r.performer, r.performers, r.artist, r.artist_name);
  const composer = pickName(
    r.piece?.composer,
    r.composer, r.composers, r.composer_name
  );

  let title = String(r.title || r.piece?.title || r.name || '').trim();
  if (composer && !new RegExp(`^${escapeRegExp(composer)}\\b`, 'i').test(title)) {
    title = `${composer}: ${title}`;
  }

  // v2 returns `length` in seconds (float). Older shapes used duration /
  // "M:SS"; keep the fallbacks for resilience.
  let duration = null;
  const d = r.length ?? r.duration ?? r.duration_seconds;
  if (typeof d === 'number') duration = Math.round(d);
  else if (typeof d === 'string' && d.includes(':')) {
    const parts = d.split(':').map(Number);
    if (parts.every((n) => !Number.isNaN(n))) {
      duration = parts.length === 3
        ? parts[0] * 3600 + parts[1] * 60 + parts[2]
        : parts[0] * 60 + parts[1];
    }
  }

  return {
    external_id: String(r.id ?? r.slug),
    source: 'musopen',
    title: (title || 'Untitled').slice(0, 510),
    artist_name: (performer || composer || 'Unknown').slice(0, 250),
    genre: 'classical',
    duration_seconds: duration,
    stream_url: stream,
    download_url: stream,
    license: rawLicense,
    artwork_url: null,
    hidden_reason: musopenHiddenReason({ artist_name: performer || composer || '', license: rawLicense }),
  };
}

function pickName(...candidates) {
  for (const c of candidates) {
    if (!c) continue;
    if (typeof c === 'string') return c.trim() || null;
    if (Array.isArray(c) && c.length) {
      const first = c[0];
      if (typeof first === 'string') return first.trim() || null;
      if (first && typeof first === 'object') {
        const n = composedName(first);
        if (n) return n;
      }
    }
    if (typeof c === 'object') {
      const n = composedName(c);
      if (n) return n;
    }
  }
  return null;
}

// v2 composer/performer objects expose first_name + last_name; older
// shapes had a single name/full_name field. Try the modern fields first.
function composedName(o) {
  if (!o) return null;
  if (o.first_name || o.last_name) {
    const full = [o.first_name, o.last_name].filter(Boolean).join(' ').trim();
    if (full) return full;
  }
  const n = o.name || o.full_name || o.display_name;
  if (typeof n === 'string') return n.trim() || null;
  return null;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
