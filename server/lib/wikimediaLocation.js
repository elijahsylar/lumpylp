// Wikidata lookup for artist origin/citizenship/place-of-birth. Used by
// both services/wikimedia.js (capture at ingest) and
// scripts/backfill-wikimedia-locations.js (backfill the 4k+ wikimedia
// artists that pre-date Phase 17.8).
//
// Approach (3 Action API calls per cache miss):
//   1. wbsearchentities — find candidate entity by artist name. Take top
//      result. Conservative match: case-insensitive substring either way
//      (label⊂name OR name⊂label). No disambiguation by description —
//      the user accepted lossy precision over manual heuristics.
//   2. wbgetentities props=claims — extract P19 (place of birth),
//      P27 (country of citizenship), P495 (country of origin) entity IDs.
//   3. wbgetentities props=labels — resolve those linked entity IDs into
//      English labels.
//
// Mapping to our schema:
//   city    ← P19 label (place of birth — usually a city/town)
//   country ← P27 label (citizenship), falling back to P495 (origin)
//
// 150ms paced (~6.5 req/s) per Wikidata's "be reasonable" guidance.
// In-process cache (positive + negative) so repeat artists are free
// across pages, queries, and entire indexer runs.

const API = 'https://www.wikidata.org/w/api.php';
const UA = `LumpyLP catalog indexer/1.0 (https://lumpylp.com; ${process.env.INDEXER_CONTACT_EMAIL || 'takedowns@lumpylp.com'})`;
const RATE_MS = 150;
const TIMEOUT_MS = 12000;

const _cache = new Map();
let _lastCallAt = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pacedFetch(url) {
  const elapsed = Date.now() - _lastCallAt;
  if (elapsed < RATE_MS) await sleep(RATE_MS - elapsed);
  _lastCallAt = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, 'Accept': 'application/json' },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function searchEntity(name) {
  const params = new URLSearchParams({
    action: 'wbsearchentities',
    search: name,
    type: 'item',
    language: 'en',
    format: 'json',
    limit: '1',
  });
  const data = await pacedFetch(`${API}?${params.toString()}`);
  const hit = data?.search?.[0];
  if (!hit || !hit.id) return null;
  const lower = name.trim().toLowerCase();
  const labelLower = (hit.label || '').trim().toLowerCase();
  if (!labelLower) return null;
  // Conservative: either string must contain the other.
  if (!lower.includes(labelLower) && !labelLower.includes(lower)) return null;
  return hit.id;
}

async function getClaims(entityId) {
  const params = new URLSearchParams({
    action: 'wbgetentities',
    ids: entityId,
    props: 'claims',
    format: 'json',
  });
  const data = await pacedFetch(`${API}?${params.toString()}`);
  const claims = data?.entities?.[entityId]?.claims;
  if (!claims || typeof claims !== 'object') return null;
  const extract = (prop) => {
    const arr = claims[prop];
    if (!Array.isArray(arr) || !arr.length) return null;
    return arr[0]?.mainsnak?.datavalue?.value?.id || null;
  };
  return {
    P19:  extract('P19'),
    P27:  extract('P27'),
    P495: extract('P495'),
  };
}

async function getLabels(ids) {
  const uniq = [...new Set(ids.filter(Boolean))];
  if (!uniq.length) return new Map();
  const params = new URLSearchParams({
    action: 'wbgetentities',
    ids: uniq.join('|'),
    props: 'labels',
    languages: 'en',
    format: 'json',
  });
  const data = await pacedFetch(`${API}?${params.toString()}`);
  const out = new Map();
  for (const id of uniq) {
    const label = data?.entities?.[id]?.labels?.en?.value;
    if (label) out.set(id, label);
  }
  return out;
}

export async function lookupArtist(name) {
  const key = (name || '').trim().toLowerCase();
  if (!key) return null;
  if (_cache.has(key)) return _cache.get(key);

  const entityId = await searchEntity(name);
  if (!entityId) { _cache.set(key, null); return null; }

  const claims = await getClaims(entityId);
  if (!claims) { _cache.set(key, null); return null; }

  const labels = await getLabels([claims.P19, claims.P27, claims.P495]);
  const cityLabel = claims.P19 ? labels.get(claims.P19) : null;
  const countryLabel = (claims.P27 ? labels.get(claims.P27) : null)
                    || (claims.P495 ? labels.get(claims.P495) : null);

  if (!cityLabel && !countryLabel) {
    _cache.set(key, null);
    return null;
  }

  const city = cityLabel ? cityLabel.slice(0, 128) : null;
  const country = countryLabel ? countryLabel.slice(0, 64) : null;
  const raw = [city, country].filter(Boolean).join(', ').slice(0, 255) || null;
  const result = { city, country, raw };
  _cache.set(key, result);
  return result;
}

// Test-only / diagnostic — not used in production paths.
export function _cacheSize() {
  return _cache.size;
}
