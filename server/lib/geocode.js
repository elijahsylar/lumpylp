// Nominatim geocoder with persistent cache.
//
// Nominatim is OSM's free geocoding service. ToS requires:
//   - User-Agent identifying the app
//   - <= 1 request/second
//   - Cache results
// We satisfy all three: User-Agent set, 1.1s sleep between calls,
// every successful resolution stored in geocode_cache.
//
// Cache key is the lowercased+trimmed query string; cache hits
// bypass the rate limit entirely.

import { query } from '../db.js';

const nominatimBase = () => process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org/search';
const USER_AGENT = 'LumpyLP/0.1 (lumpylp.com)';
const RATE_LIMIT_MS = 1100; // 1.1s — comfortably under Nominatim's 1 req/sec cap

function normalizeKey(s) {
  return String(s || '').trim().toLowerCase();
}

async function lookupCache(key) {
  const rows = await query(
    'SELECT lat, lng, display_name FROM geocode_cache WHERE `query` = ? LIMIT 1',
    [key]
  );
  if (!rows.length) return null;
  return {
    lat: Number(rows[0].lat),
    lng: Number(rows[0].lng),
    display_name: rows[0].display_name,
  };
}

async function writeCache(key, result) {
  // ON DUPLICATE refresh keeps the cache hot if we ever re-resolve.
  await query(
    `INSERT INTO geocode_cache (\`query\`, display_name, lat, lng)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       display_name = VALUES(display_name),
       lat = VALUES(lat),
       lng = VALUES(lng),
       cached_at = CURRENT_TIMESTAMP`,
    [key, result.display_name, result.lat, result.lng]
  );
}

// One global queue for every Nominatim call in this process, so parallel
// requests can't break the 1 request/second policy (02 S10). Each call waits
// for the previous one plus RATE_LIMIT_MS. The queue has a maximum depth
// (NOMINATIM_MAX_QUEUE, default 10): past it, geocode() refuses at once with
// GeocodeBusyError instead of making every caller wait minutes (review R7).
export class GeocodeBusyError extends Error {
  constructor() { super('geocoder busy'); this.name = 'GeocodeBusyError'; }
}
let nominatimQueue = Promise.resolve();
let queued = 0;
function nominatimFetch(rawQuery) {
  const max = Number(process.env.NOMINATIM_MAX_QUEUE) || 10;
  if (queued >= max) return Promise.reject(new GeocodeBusyError());
  queued += 1;
  const run = nominatimQueue.then(() => nominatimFetchNow(rawQuery));
  const done = () => { queued -= 1; return sleep(RATE_LIMIT_MS); };
  nominatimQueue = run.then(done, done);
  return run;
}

async function nominatimFetchNow(rawQuery) {
  const url = `${nominatimBase()}?q=${encodeURIComponent(rawQuery)}&format=json&limit=1`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': USER_AGENT },
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) return null;
    const top = data[0];
    const lat = parseFloat(top.lat);
    const lng = parseFloat(top.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return {
      lat,
      lng,
      display_name: String(top.display_name || rawQuery).slice(0, 255),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Resolve a single location string to lat/lng.
 * Cache-first; on miss, calls Nominatim then caches the result.
 * Returns null on no-result (and does NOT cache the negative — we may
 * want to retry with reformatted input later).
 */
export async function geocode(rawQuery) {
  const key = normalizeKey(rawQuery);
  if (!key) return null;
  const cached = await lookupCache(key);
  if (cached) return cached;
  // Paced by the global queue in nominatimFetch.
  const result = await nominatimFetch(rawQuery);
  if (!result) return null;
  await writeCache(key, result);
  return result;
}

/**
 * Geocode an array of queries with cache-first lookup, then a sequential
 * rate-limited pass for cache misses. Caller can hook a progress callback.
 *
 * Returns: Map<originalQuery, { lat, lng, display_name } | null>
 */
export async function batchGeocode(queries, onProgress) {
  const out = new Map();
  const misses = [];

  // Pass 1: cache-only, no rate limit cost
  for (const q of queries) {
    const key = normalizeKey(q);
    if (!key) { out.set(q, null); continue; }
    const hit = await lookupCache(key);
    if (hit) out.set(q, hit);
    else misses.push(q);
  }

  // Pass 2: live calls, paced
  const total = queries.length;
  let done = total - misses.length;
  for (const q of misses) {
    if (onProgress) onProgress(done, total, q);
    const result = await nominatimFetch(q);
    if (result) {
      const key = normalizeKey(q);
      await writeCache(key, result);
      out.set(q, result);
    } else {
      out.set(q, null);
    }
    done++;
  }
  if (onProgress) onProgress(done, total, '(complete)');
  return out;
}
