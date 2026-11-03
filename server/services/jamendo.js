import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { iso3ToIso2 } from '../lib/countries.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const JAMENDO_BASE = 'https://api.jamendo.com/v3.0';
const JAMENDO_LOCATIONS = `${JAMENDO_BASE}/artists/locations/`;
// Jamendo's artists/locations endpoint is rate-limit-friendly; 110ms (~9 req/s)
// is the same cadence the backfill uses and keeps headroom under their limits.
const LOCATION_RATE_MS = 110;

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

// Multiple query strategies — DB unique key dedupes overlap across queries.
//
// Phase 17: deepened from 12 -> ~60 slices by adding two more orderings
// per genre (`releasedate_desc` for the long tail, `buzzrate` for the
// trending head) plus a wider tag list. After the top thousand pages
// of each ordering, results diverge significantly — same genre but
// different tracks surface depending on the sort.
//
// All queries hit the default Jamendo CC-licensed track corpus (no
// `ccsharetype` / `ccnc` flags set), so all CC variants are returned;
// the per-track license URL flows through quality-gate.normalizeLicense.

const JAMENDO_GENRE_TAGS = [
  'rock', 'electronic', 'jazz', 'hiphop', 'classical', 'folk',
  'ambient', 'metal', 'world', 'reggae', 'pop', 'indie',
  'blues', 'country', 'soul', 'funk', 'lounge', 'dance',
  'soundtrack', 'lofi', 'chillout', 'experimental', 'acoustic',
  'instrumental', 'latin', 'dubstep', 'house', 'techno',
];

const JAMENDO_ORDERINGS = ['popularity_total', 'releasedate_desc', 'buzzrate'];

function buildJamendoQueries() {
  const out = [];
  // Three base sweeps without a tag — pull the cross-genre top of each
  // ordering. Useful for sources that have weak tag metadata.
  for (const order of JAMENDO_ORDERINGS) {
    out.push({ name: `all-${order}`, params: `order=${order}` });
  }
  for (const tag of JAMENDO_GENRE_TAGS) {
    for (const order of JAMENDO_ORDERINGS) {
      out.push({ name: `${tag}-${order}`, params: `tags=${tag}&order=${order}` });
    }
  }
  return out;
}

export const JAMENDO_QUERIES = buildJamendoQueries();

let warned = false;

async function getJSON(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'LumpyLP/0.1 (+https://lumpylp.com)' },
  });
  if (!res.ok) throw new Error(`Jamendo ${res.status} on ${url}`);
  return res.json();
}

function parseLicense(url) {
  if (!url || typeof url !== 'string') return 'CC';
  const m = url.match(/by(?:-(?:nc|sa|nd))*/i);
  return m ? m[0].toLowerCase() : 'CC';
}

// Phase 17.8: per-artist location resolution at ingest. Jamendo doesn't
// return location on the track endpoint, so we hit /artists/locations
// once per unique artist name. Cache lives for the process lifetime —
// in cron mode that means each cron tick re-resolves cold artists, but
// most names hit the cache after the first pass through a long-running
// indexer process.
//
// Cache value shape: { country, city, raw } on hit, null on miss/junk.
const _locationCache = new Map();
let _lastLocationCallAt = 0;

async function pacedLocationFetch(url) {
  const elapsed = Date.now() - _lastLocationCallAt;
  if (elapsed < LOCATION_RATE_MS) {
    await new Promise((r) => setTimeout(r, LOCATION_RATE_MS - elapsed));
  }
  _lastLocationCallAt = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'LumpyLP/0.1 (+https://lumpylp.com)' },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveArtistLocation(name, clientId) {
  const key = (name || '').trim().toLowerCase();
  if (!key) return null;
  if (_locationCache.has(key)) return _locationCache.get(key);

  const url = `${JAMENDO_LOCATIONS}?client_id=${encodeURIComponent(clientId)}` +
    `&format=json&namesearch=${encodeURIComponent(name)}&limit=1`;
  const data = await pacedLocationFetch(url);
  const hit = (data && Array.isArray(data.results)) ? data.results[0] : null;

  // Strict name match — Jamendo's namesearch is fuzzy and will return a
  // different artist if ours doesn't exist. Mirrors the backfill's check.
  if (!hit || (hit.name || '').trim().toLowerCase() !== key) {
    _locationCache.set(key, null);
    return null;
  }
  const loc = (hit.locations || [])[0];
  if (!loc) {
    _locationCache.set(key, null);
    return null;
  }

  const iso3 = (loc.country || '').trim() || null;
  const country = iso3 ? (iso3ToIso2(iso3) || iso3) : null;
  const city = (loc.city || '').trim() || null;
  if (!country && !city) {
    _locationCache.set(key, null);
    return null;
  }
  // Build a raw representation for parity with other sources that carry
  // a free-text string. Format: "city, country" / "city" / "country".
  const raw = [city, country].filter(Boolean).join(', ').slice(0, 255) || null;
  const result = { country, city, raw };
  _locationCache.set(key, result);
  return result;
}

function normalize(t) {
  if (!t || !t.id) return null;
  if (!t.audio) return null;

  const tagsArr = (t.musicinfo && t.musicinfo.tags && t.musicinfo.tags.genres) || [];
  const genre = (Array.isArray(tagsArr) ? tagsArr : [])
    .map((s) => (typeof s === 'string' ? s.trim().toLowerCase() : ''))
    .find((s) => GENRE_ALLOWLIST.has(s)) || null;

  const dur = typeof t.duration === 'number'
    ? t.duration
    : (parseInt(t.duration) || null);

  return {
    external_id: String(t.id),
    source: 'jamendo',
    title: (t.name || 'Untitled').toString().slice(0, 510),
    artist_name: (t.artist_name || 'Unknown').toString().slice(0, 250),
    genre: genre ? genre.slice(0, 120) : null,
    duration_seconds: dur,
    stream_url: t.audio,
    download_url: t.audiodownload || t.audio,
    license: parseLicense(t.license_ccurl),
    artwork_url: t.image || null,
  };
}

export async function fetchTracksPage(query, page = 1, perPage = 200) {
  const clientId = process.env.JAMENDO_CLIENT_ID;
  if (!clientId) {
    if (!warned) {
      console.warn('[jamendo] JAMENDO_CLIENT_ID missing from env — Jamendo source disabled');
      warned = true;
    }
    return [];
  }

  const offset = (page - 1) * perPage;
  const params = (query && query.params) ? query.params : 'order=popularity_total';
  const url =
    `${JAMENDO_BASE}/tracks/?client_id=${encodeURIComponent(clientId)}` +
    `&format=json&limit=${perPage}&offset=${offset}` +
    `&include=musicinfo&audioformat=mp32&${params}`;

  const data = await getJSON(url);
  const items = (data && Array.isArray(data.results)) ? data.results : [];
  const tracks = items.map(normalize).filter(Boolean);

  // Phase 17.8: resolve artist locations once per unique name in this
  // page, then attach to every track. The cache makes repeat artists
  // (very common across pages/queries) free; first encounter costs
  // ~110ms per artist.
  const uniqNames = [...new Set(tracks.map((t) => t.artist_name))];
  const locByName = new Map();
  for (const name of uniqNames) {
    const loc = await resolveArtistLocation(name, clientId);
    locByName.set(name, loc);
  }
  for (const t of tracks) {
    const loc = locByName.get(t.artist_name);
    if (loc) {
      t._artist_location_raw = loc.raw;
      t._artist_country = loc.country;
      t._artist_city = loc.city;
      t._artist_location_source = 'jamendo';
    }
  }
  return tracks;
}
