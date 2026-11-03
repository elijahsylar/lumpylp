// Smithsonian Folkways (CC subset) — small educational corpus inside
// the otherwise commercial Folkways catalog. Smithsonian's "Open Access"
// program (api.si.edu) exposes the CC0 portion of holdings across all
// units; we filter to unit_code CFCH-FRC (Folkways collection) and to
// audio-typed records.
//
// Most of Folkways is for sale; this source surfaces only the slice
// that Smithsonian itself has marked Open Access. If the corpus turns
// out to be empty or unstreamable, the dry-run report flags it and we
// drop the source from later phases.
//
// Skips cleanly via SmithsonianNotConfigured if SMITHSONIAN_API_KEY is
// absent. Per spec, we do NOT scrape folkways.si.edu — their TOS
// likely prohibits it.

const BASE = 'https://api.si.edu/openaccess/api/v1.0/search';
const UA = 'LumpyLP catalog indexer (https://lumpylp.com)';

export const SMITHSONIAN_QUERIES = [{ name: 'folkways-openaccess' }];

export class SmithsonianNotConfigured extends Error {
  constructor() { super('SMITHSONIAN_API_KEY not set'); this.code = 'SMITHSONIAN_NOT_CONFIGURED'; }
}

const POLITE_DELAY_MS = 1000;
let lastFetchAt = 0;

const AUDIO_EXT = /\.(mp3|ogg|flac|wav|m4a)(\?|$)/i;

async function politeFetch(url) {
  const wait = POLITE_DELAY_MS - (Date.now() - lastFetchAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastFetchAt = Date.now();
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
  if (res.status === 401 || res.status === 403) {
    throw new Error(`smithsonian auth ${res.status} — check SMITHSONIAN_API_KEY`);
  }
  if (res.status === 429) {
    const retry = Number(res.headers.get('retry-after') || 5);
    await new Promise((r) => setTimeout(r, retry * 1000));
    return politeFetch(url);
  }
  if (!res.ok) throw new Error(`smithsonian ${res.status} on ${url}`);
  return res.json();
}

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
    for (const k of Object.keys(v)) {
      const got = pickFirst(v[k]);
      if (got) return got;
    }
  }
  return null;
}

// Walk a typical SI Open Access record's content.descriptiveNonRepeating
// + content.indexedStructured + content.freetext to extract the fields
// we care about. The schema is verbose; this resolver is defensive.
function normalize(rec) {
  if (!rec || (!rec.id && !rec.content)) return null;
  const content = rec.content || {};
  const dnr = content.descriptiveNonRepeating || {};
  const indexed = content.indexedStructured || {};
  const freetext = content.freetext || {};

  // Reject anything not an audio item (the broader OA index includes
  // images, books, manuscripts under the same unit codes).
  const types = []
    .concat(indexed.object_type || [])
    .concat(freetext.objectType || []);
  const typeStr = types.map((t) => (typeof t === 'string' ? t : (t.content || ''))).join(' ').toLowerCase();
  if (!/sound|audio|recording|music/.test(typeStr)) return null;

  // Find a streamable resource. SI Open Access records expose
  // online_media[].content (URL) + online_media[].type ("Sounds", etc.).
  const media = (dnr.online_media && Array.isArray(dnr.online_media.media))
    ? dnr.online_media.media
    : [];
  let stream = null;
  for (const m of media) {
    const url = m && (m.content || m.resource || m.url);
    if (typeof url === 'string' && AUDIO_EXT.test(url)) { stream = url; break; }
  }
  if (!stream) return null;

  const title = pickFirst(dnr.title) || pickFirst(rec.title);
  if (!title) return null;

  const creator = pickFirst(freetext.name)
    || pickFirst(indexed.name)
    || pickFirst(dnr.creator)
    || 'Unknown';

  // Open Access is CC0 by program definition. Some records also expose
  // a per-record license field; prefer that when present.
  const license = pickFirst(freetext.usage)
    || pickFirst(indexed.usage_flag)
    || 'cc0';

  const subjectHint = pickFirst(indexed.topic) || pickFirst(freetext.topic) || null;

  return {
    external_id: String(rec.id).slice(0, 128),
    source: 'smithsonian',
    title: String(title).slice(0, 510),
    artist_name: String(creator).slice(0, 250),
    genre: null,
    _genre_hint: subjectHint,
    duration_seconds: null, // OA index doesn't expose duration uniformly
    stream_url: stream,
    download_url: stream,
    license,
    artwork_url: null,
  };
}

export async function fetchTracksPage(_query, page = 1, perPage = 100) {
  const key = process.env.SMITHSONIAN_API_KEY;
  if (!key) throw new SmithsonianNotConfigured();

  // CFCH-FRC = Center for Folklife and Cultural Heritage / Folkways.
  // online_media_type:Sound narrows to audio resources.
  const params = new URLSearchParams({
    api_key: key,
    q: 'unit_code:CFCH-FRC AND online_media_type:Sound',
    rows: String(perPage),
    start: String((page - 1) * perPage),
  });
  const url = `${BASE}?${params.toString()}`;
  const data = await politeFetch(url);
  const rows = data?.response?.rows;
  const items = Array.isArray(rows) ? rows : [];
  return items.map(normalize).filter(Boolean);
}
