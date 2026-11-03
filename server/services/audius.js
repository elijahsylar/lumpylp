// Audius track source.
// Anonymous mode (default) appends ?app_name=...; authenticated mode uses
// api.audius.co with a Bearer header. The route handler 302-redirects in
// anon mode (Audius's stream endpoint signs a CDN URL) and proxies bytes
// in authed mode (since the browser doesn't have the bearer token).

import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchWithFailover, getDiscoveryNode, markNodeFailed } from './audius-nodes.js';
import { isPlausibleLocation } from '../lib/locationFilter.js';
import { parseAudiusLocation } from '../lib/audiusLocation.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const APP_NAME = process.env.AUDIUS_APP_NAME || 'LumpyLP';
const BEARER = (process.env.AUDIUS_BEARER_TOKEN || '').trim();

export const AUDIUS_AUTHED = !!BEARER;
// Kept for legacy reference; runtime calls go through getDiscoveryNode().
export const AUDIUS_BASE = AUDIUS_AUTHED
  ? 'https://api.audius.co/v1'
  : 'https://discoveryprovider.audius.co/v1';

// Allowlist used to map Audius genres to ours. Phase 4 additions:
// 'hyperpop', 'trance', 'dnb', 'footwork', 'downtempo'.
const GENRE_ALLOWLIST = new Set([
  'ambient', 'bass', 'beat', 'blues', 'chiptune', 'classical', 'country', 'drone',
  'electronic', 'electro', 'experimental', 'folk', 'funk', 'game', 'gospel', 'guitar',
  'hip hop', 'hip-hop', 'hiphop', 'house', 'indie', 'instrumental', 'jazz', 'lofi',
  'lo-fi', 'metal', 'noise', 'opera', 'piano', 'pop', 'punk', 'r&b', 'rnb', 'rap',
  'reggae', 'rock', 'soul', 'soundtrack', 'spoken word', 'synthwave', 'techno',
  'trap', 'world', 'acoustic', 'choral', 'comedy', 'dance', 'disco', 'dub',
  'garage', 'grunge', 'hardrock', 'industrial', 'latin', 'minimalist', 'new age',
  'orchestral', 'post-rock', 'shoegaze', 'ska', 'swing',
  // Phase 4 additions for Audius
  'hyperpop', 'trance', 'dnb', 'footwork', 'downtempo',
]);

// Audius categories that aren't really music — drop these at ingest.
const NON_MUSIC = new Set(['podcasts', 'audiobooks']);

// Per-Audius-genre canonical mapping per the spec.
const GENRE_MAP = {
  'hip-hop/rap':   'hip-hop',
  'r&b/soul':      'r&b',
  'drum & bass':   'dnb',
  'lo-fi':         'lofi',
  'future bass':   'electronic',
  'future house':  'house',
  'tropical house':'house',
  'glitch hop':    'electronic',
  'trailer':       'soundtrack',
  'alternative':   'indie',
  'devotional':    'gospel',
  'dancehall':     'reggae',
};

function mapGenre(g) {
  if (!g) return null;
  const lower = String(g).toLowerCase().trim();
  if (NON_MUSIC.has(lower)) return null; // signal: skip the track
  if (GENRE_MAP[lower]) return GENRE_MAP[lower];
  if (GENRE_ALLOWLIST.has(lower)) return lower;
  return 'electronic'; // last-resort fallback per spec
}

function isNonMusic(g) {
  return NON_MUSIC.has(String(g || '').toLowerCase().trim());
}

// Spec query list. Each entry maps to a single API call. With pagesPerQuery=1
// the indexer fires each exactly once.
//
// `time=year` is included even though the discovery provider currently
// rejects it (400 "time is invalid"). Per Phase 4B spec we try it on every
// genre — if Audius re-enables the window, we'll start getting tracks back
// for free; in the meantime each year-query just logs a 400 and moves on.
function buildQueries() {
  const trendingTimes = ['allTime', 'year', 'month', 'week'];
  const perGenreTimes = ['allTime', 'year', 'month', 'week'];
  const perGenres = [
    'Electronic', 'Hip-Hop/Rap', 'Rock', 'Ambient', 'Lo-Fi',
    'House', 'Techno', 'Jazz', 'Classical', 'Metal',
    'Punk', 'Folk', 'Experimental', 'R&B/Soul',
    'World', 'Downtempo', 'Drum & Bass', 'Trap', 'Trance',
    'Hyperpop', 'Disco', 'Pop', 'Country', 'Reggae',
  ];
  // Phase 4B expanded list — ~150 tags. Heavy dedup expected; that's fine.
  const tags = [
    // Phase 4 originals
    'vaporwave', 'witch house', 'bedroom pop', 'shoegaze',
    'post-punk', 'drone', 'noise', 'glitch', 'breakcore', 'idm',
    'hardcore', 'dubstep', 'indie', 'garage rock', 'psychedelic',
    'math rock', 'emo', 'screamo', 'trip-hop', 'chiptune',
    'synthwave', 'darkwave', 'post-rock', 'ambient drone', 'jungle',
    'juke', 'footwork', 'hyperpop', 'digicore', 'plugg',
    'drill', 'phonk',
    // Phase 17 additions — slices the original Phase 4B list missed.
    // Many overlap existing slices on Audius but search ranks
    // differently for each phrasing, so dedup is expected and fine.
    'lo-fi', 'drum and bass', 'darksynth', 'neoclassical',
    'plunderphonics', 'mallsoft',
    // Phase 4B additions
    'chillwave', 'mallsoft', 'slushwave', 'future funk', 'nightcore',
    'speedcore', 'gabber', 'hardstyle', 'dubcore', 'gqom', 'kuduro',
    'baile funk', 'reggaeton', 'k-pop', 'j-pop', 'mandopop',
    'afrobeat', 'afrobeats', 'amapiano', 'highlife',
    'bossa nova', 'cumbia', 'salsa', 'son', 'trova', 'fado',
    'flamenco', 'gypsy jazz', 'klezmer', 'qawwali', 'raga',
    'gamelan', 'throat singing', 'field recording', 'modular synth',
    'eurorack', 'generative', 'algorithmic',
    'ambient techno', 'dub techno', 'microhouse', 'deep house',
    'acid house', 'chicago house', 'detroit techno', 'berlin techno',
    'minimal techno', 'industrial techno', 'hard techno',
    'psytrance', 'goa', 'happy hardcore', 'donk',
    'grime', 'uk drill', 'ny drill', 'jersey club',
    'philly club', 'baltimore club', 'mc battle', 'freestyle',
    'boom bap', 'jazz rap', 'conscious hip hop', 'lo-fi hip hop',
    'cloud rap', 'mumble rap', 'emo rap', 'hyperplugg', 'rage',
    'jerk', 'sigilkore', 'scenecore', 'hexd', 'dariacore',
    'frutiger aero', 'dreampunk', 'hauntology', 'hypnagogic',
    'plunderphonics', 'musique concrete', 'tape music', 'fourth world',
    'kosmische', 'krautrock', 'no wave', 'deathrock', 'coldwave',
    'minimal wave', 'italo disco', 'hi-nrg', 'electroclash',
    'bloghouse', 'fidget', 'complextro', 'brostep', 'riddim',
    'color bass', 'melodic dubstep', 'future garage', '2-step',
    'speed garage', 'bassline', 'uk funky', 'broken beat',
    'future jazz', 'nu jazz', 'acid jazz', 'jazz fusion',
    // Mood / vibe
    'dark ambient', 'warm pads', 'field recordings', 'lo-fi beats',
    'chillhop', 'study beats', 'night drive', 'outrun',
    'cyberpunk', 'vapor',
  ];

  const out = [];
  for (const time of trendingTimes) {
    out.push({ name: `trending-${time}`,        kind: 'trending', time });
  }
  for (const g of perGenres) {
    for (const time of perGenreTimes) {
      out.push({ name: `${g}-${time}`,          kind: 'trending', time, genre: g });
    }
  }
  for (const tag of tags) {
    out.push({ name: `search-${tag}`,           kind: 'search', query: tag });
  }
  // Phase 17: playlist-walk — fetch trending playlists once and walk
  // their tracks (via internal cursor on subsequent fetchTracksPage
  // calls). One entry per time window. Each "page" advances the
  // playlist cursor by one, so pagesPerQuery=100 here covers a long
  // trending-playlist list (Audius typically returns 100 trending
  // playlists per time window).
  for (const time of ['week', 'month', 'allTime']) {
    out.push({ name: `playlist-walk-${time}`, kind: 'playlist-walk', time, pagesPerQuery: 100 });
  }
  // Phase 17: user-walk — derives top-user IDs from trending-playlist
  // creators (Audius has no /users/trending) and walks each user's
  // discography one user per page. Seed list capped at 200 users so
  // pagesPerQuery=200 covers the worst case.
  out.push({ name: 'user-walk', kind: 'user-walk', pagesPerQuery: 200 });
  return out;
}

export const AUDIUS_QUERIES = buildQueries();

// Internal pacing — minimum 110ms between calls (~9/sec) so we stay under
// the 10/sec spec limit even with clock skew + retry tail.
let lastCallAt = 0;
const MIN_GAP_MS = 110;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function paced() {
  const elapsed = Date.now() - lastCallAt;
  if (elapsed < MIN_GAP_MS) await sleep(MIN_GAP_MS - elapsed);
  lastCallAt = Date.now();
}

// Route every JSON read through the multi-node failover helper. Each call
// picks a healthy node, retries on 5xx, and surfaces the answering node URL
// for telemetry.
async function getJSON(pathAndQuery, attempt = 0) {
  await paced();
  const headers = {
    'User-Agent': 'LumpyLP/0.1 (+https://lumpylp.com)',
    'Accept': 'application/json',
  };
  if (AUDIUS_AUTHED) headers.Authorization = `Bearer ${BEARER}`;

  const sep = pathAndQuery.includes('?') ? '&' : '?';
  const suffix = AUDIUS_AUTHED ? '' : `${sep}app_name=${encodeURIComponent(APP_NAME)}`;
  const fullPath = `/v1${pathAndQuery}${suffix}`;

  let res, node;
  try {
    ({ res, node } = await fetchWithFailover(fullPath, { headers }));
  } catch (err) {
    throw new Error(`Audius all-nodes-failed: ${err.message}`);
  }

  if (res.status === 429 && attempt < 3) {
    const wait = 500 * Math.pow(2, attempt);
    await sleep(wait);
    return getJSON(pathAndQuery, attempt + 1);
  }
  if (!res.ok) {
    throw new Error(`Audius ${res.status} via ${node} on ${fullPath}`);
  }
  return res.json();
}

// What we *store* on the row — keep using a default base so existing rows
// keep an identifiable URL. Runtime streaming ignores this and rebuilds
// fresh from getDiscoveryNode() per request.
export function streamUrlFor(externalId) {
  const sep = '?';
  const suffix = AUDIUS_AUTHED ? '' : `${sep}app_name=${encodeURIComponent(APP_NAME)}`;
  return `${AUDIUS_BASE}/tracks/${encodeURIComponent(externalId)}/stream${suffix}`;
}

// Build the live stream URL against a specific discovery node. Used by the
// audio proxy at request time so each play picks a fresh node.
export function streamUrlFromNode(node, externalId) {
  const sep = '?';
  const suffix = AUDIUS_AUTHED ? '' : `${sep}app_name=${encodeURIComponent(APP_NAME)}`;
  return `${node}/v1/tracks/${encodeURIComponent(externalId)}/stream${suffix}`;
}

// Used by the audio proxy: server-side fetches the discovery node's stream
// endpoint to capture the signed CDN URL it 302s to, then returns that URL
// so the route handler can redirect the browser straight to the CDN.
//
// Phase 6: a single 404 from one node is NOT enough to declare the track
// dead — Audius replicates content across a subset of nodes and a 404 from
// node X can mean "I don't have this" rather than "it's gone". We require
// at least 2 nodes to confirm 404 before reporting notFound.
export async function resolveStreamCdnUrl(externalId, maxAttempts = 3) {
  const headers = {
    'User-Agent': 'LumpyLP/0.1 (+https://lumpylp.com)',
  };
  if (AUDIUS_AUTHED) headers.Authorization = `Bearer ${BEARER}`;
  const tried = new Set();
  let lastStatus = 0;
  let notFoundCount = 0;
  for (let i = 0; i < maxAttempts; i++) {
    const node = getDiscoveryNode();
    if (tried.has(node)) break;
    tried.add(node);
    const url = streamUrlFromNode(node, externalId);
    try {
      const res = await fetch(url, { headers, redirect: 'manual' });
      lastStatus = res.status;
      if (res.status === 302 || res.status === 301) {
        const cdn = res.headers.get('location');
        if (cdn) return { cdnUrl: cdn, node };
        markNodeFailed(node);
      } else if (res.status === 404) {
        notFoundCount++;
        // Don't blame the node for a 404 — it's healthy, the track just
        // isn't there. Keep trying others to confirm.
      } else {
        markNodeFailed(node);
      }
    } catch {
      markNodeFailed(node);
    }
  }
  if (notFoundCount >= 2) return { notFound: true, confirmedBy: notFoundCount };
  return {
    error: `no node yielded a CDN URL (last status ${lastStatus})`,
    lastStatus,
    notFoundCount,
  };
}

function normalize(t) {
  if (!t || !t.id) return null;
  if (t.is_streamable === false) return null;
  if (t.is_unlisted === true)    return null;
  if (t.is_available === false)  return null;
  if (isNonMusic(t.genre))       return null;

  const dur = typeof t.duration === 'number' ? t.duration : null;
  if (dur !== null && dur < 10) return null;

  const user = t.user || {};
  const title = (t.title || '').toString().trim();
  const artist = (user.name || user.handle || '').toString().trim();
  if (!title || !artist) return null;

  const artwork = t.artwork || {};
  const artwork_url = artwork['480x480'] || artwork['150x150'] || artwork['1000x1000'] || null;

  // Phase 17.8: capture user.location at ingest. The track payload already
  // carries it — no extra API call. Preserve raw verbatim; only parse
  // city/country when the string passes the junk filter (mirrors what
  // backfill-audius-locations.js does for legacy rows).
  const rawLoc = (user.location || '').toString().trim();
  let _artist_location_raw = null;
  let _artist_country = null;
  let _artist_city = null;
  let _artist_location_source = null;
  if (rawLoc) {
    _artist_location_raw = rawLoc.slice(0, 255);
    _artist_location_source = 'audius';
    if (isPlausibleLocation(rawLoc)) {
      const { city, country } = parseAudiusLocation(rawLoc);
      _artist_city = city;
      _artist_country = country;
    }
  }

  return {
    external_id: String(t.id),
    source: 'audius',
    title: title.slice(0, 510),
    artist_name: artist.slice(0, 250),
    genre: mapGenre(t.genre),
    duration_seconds: dur ? Math.round(dur) : null,
    stream_url: streamUrlFor(t.id),
    download_url: streamUrlFor(t.id),
    // Audius's platform terms grant streaming/redistribution rights to
    // apps that use the discovery API; the underlying recordings remain
    // owned by their artists. Phase 17 routes audius through the same
    // quality-gate as every other source, so we surface the platform-
    // license bucket here instead of the pre-Phase-17 'all-rights-reserved'
    // value (which the gate would reject).
    license: 'audius-platform',
    artwork_url,
    is_downloadable: t.is_downloadable === true,
    audius_user_id: user.id ? String(user.id) : null,
    audius_track_cid: t.track_cid ? String(t.track_cid).slice(0, 100) : null,
    _artist_location_raw,
    _artist_country,
    _artist_city,
    _artist_location_source,
  };
}

// Phase 4B: artist deep-dive + playlist unpack endpoints.
// Each one returns up to `limit` normalized track rows. Pagination via offset.

export async function fetchUserTracks(userId, limit = 100, offset = 0) {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  const data = await getJSON(`/users/${encodeURIComponent(userId)}/tracks?${params.toString()}`);
  const items = Array.isArray(data?.data) ? data.data : [];
  return items.map(normalize).filter(Boolean);
}

export async function fetchTrendingPlaylists(time = 'month') {
  const params = new URLSearchParams({ time });
  const data = await getJSON(`/playlists/trending?${params.toString()}`);
  const items = Array.isArray(data?.data) ? data.data : [];
  // Return only the id+name (caller doesn't need full playlist).
  return items.map((p) => ({ id: p.id, name: p.playlist_name || p.name || '' }));
}

export async function fetchPlaylistTracks(playlistId) {
  const data = await getJSON(`/playlists/${encodeURIComponent(playlistId)}/tracks`);
  const items = Array.isArray(data?.data) ? data.data : [];
  return items.map(normalize).filter(Boolean);
}

// Used by the CID backfill to fetch a single track by external_id.
export async function fetchTrackById(externalId) {
  const data = await getJSON(`/tracks/${encodeURIComponent(externalId)}`);
  return data?.data || null;
}

// ── Phase 17 walks: cursor state ──────────────────────────────────
//
// playlist-walk: for each time window we cache the trending-playlist
// list once (per indexer process). Each fetchTracksPage call advances
// `_playlistIndex.get(time)` by one and returns that playlist's tracks.
// Returns [] when we run off the end so the indexer's empty-page break
// fires.
const _playlistCache = new Map();   // time -> [{id, name}, ...]
const _playlistIndex = new Map();   // time -> next-index int

// user-walk: seed a unique user list from the most popular trending
// playlists' track creators, then walk one user's full track list per
// page (with internal pagination if a user has >100 tracks). The seed
// list is computed once.
let _userSeed = null;               // [userId, ...]
let _userIndex = 0;                 // next-user-to-walk index

async function ensurePlaylistList(time) {
  if (_playlistCache.has(time)) return _playlistCache.get(time);
  const list = await fetchTrendingPlaylists(time);
  _playlistCache.set(time, list);
  if (!_playlistIndex.has(time)) _playlistIndex.set(time, 0);
  return list;
}

async function ensureUserSeed() {
  if (_userSeed) return _userSeed;
  // Pull trending tracks across two windows + trending playlists across
  // three windows. Take the union of unique user IDs we've seen, capped
  // at 200. This is a "popular users" heuristic since Audius has no
  // dedicated /users/trending endpoint.
  const seen = new Set();
  for (const time of ['allTime', 'month']) {
    try {
      const params = new URLSearchParams({ time, limit: '100' });
      const data = await getJSON(`/tracks/trending?${params.toString()}`);
      const items = Array.isArray(data?.data) ? data.data : [];
      for (const t of items) {
        const uid = t?.user?.id;
        if (uid) seen.add(String(uid));
      }
    } catch (e) { /* swallow — seeding is best-effort */ }
  }
  for (const time of ['allTime', 'month', 'week']) {
    try {
      const playlists = await fetchTrendingPlaylists(time);
      for (const pl of playlists) {
        try {
          const tracks = await fetchPlaylistTracks(pl.id);
          for (const t of tracks) if (t.audius_user_id) seen.add(String(t.audius_user_id));
        } catch { /* swallow */ }
        if (seen.size >= 200) break;
      }
    } catch { /* swallow */ }
    if (seen.size >= 200) break;
  }
  _userSeed = [...seen].slice(0, 200);
  return _userSeed;
}

async function fetchPlaylistWalkPage(query) {
  const time = query.time || 'month';
  const list = await ensurePlaylistList(time);
  if (!list.length) return [];
  const idx = _playlistIndex.get(time) || 0;
  if (idx >= list.length) return [];
  _playlistIndex.set(time, idx + 1);
  const pl = list[idx];
  try {
    return await fetchPlaylistTracks(pl.id);
  } catch (e) {
    return []; // single-playlist failure shouldn't kill the walk; next call advances
  }
}

async function fetchUserWalkPage(_query) {
  const users = await ensureUserSeed();
  if (!users.length) return [];
  // Skip past users whose discography fetch fails; advance until we
  // find one that yields tracks (or exhaust the list). Returning 0
  // here would terminate the indexer's per-query page loop.
  while (_userIndex < users.length) {
    const uid = users[_userIndex++];
    try {
      const tracks = await fetchUserTracks(uid, 100, 0);
      if (tracks.length) return tracks;
    } catch { /* try next */ }
  }
  return [];
}

export async function fetchTracksPage(query, _page = 1) {
  if (!query || !query.kind) {
    // Default for ad-hoc invocation: trending allTime.
    query = { name: 'trending-allTime', kind: 'trending', time: 'allTime' };
  }

  if (query.kind === 'playlist-walk') return fetchPlaylistWalkPage(query);
  if (query.kind === 'user-walk') return fetchUserWalkPage(query);

  let path;
  if (query.kind === 'trending') {
    const params = new URLSearchParams({ time: query.time || 'allTime', limit: '100' });
    if (query.genre) params.set('genre', query.genre);
    path = `/tracks/trending?${params.toString()}`;
  } else if (query.kind === 'search') {
    const params = new URLSearchParams({ query: query.query, limit: '50' });
    path = `/tracks/search?${params.toString()}`;
  } else {
    return [];
  }

  const data = await getJSON(path);
  const items = Array.isArray(data?.data) ? data.data : [];
  return items.map(normalize).filter(Boolean);
}
