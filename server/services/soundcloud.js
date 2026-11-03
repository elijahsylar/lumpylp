// SoundCloud — modern CC-licensed catalog via the public Tracks API.
// Requires SOUNDCLOUD_CLIENT_ID env var. If missing, the indexer driver
// catches the tagged error and skips (same pattern as Musopen).
//
// Filter strategy: rotate through genre keywords with the license=
// constraint set to all CC variants (drops "all-rights-reserved" at the
// API level). Quality gate then catches "type beat" / "prod by" spam
// that's still rampant on SoundCloud despite the CC tag.

const BASE = 'https://api.soundcloud.com/tracks';
const UA = 'LumpyLP catalog indexer (https://lumpylp.com)';

// SoundCloud's CC licenses, joined for the &license= filter.
const CC_LICENSES = [
  'cc-by', 'cc-by-sa', 'cc-by-nc', 'cc-by-nc-sa', 'cc-by-nd', 'cc-by-nc-nd',
  'no-rights-reserved',
].join(',');

export const SOUNDCLOUD_QUERIES = [
  { name: 'electronic',   q: 'electronic' },
  { name: 'folk',         q: 'folk' },
  { name: 'jazz',         q: 'jazz' },
  { name: 'classical',    q: 'classical' },
  { name: 'hip-hop',      q: 'hip hop' },
  { name: 'ambient',      q: 'ambient' },
  { name: 'rock',         q: 'rock' },
  { name: 'experimental', q: 'experimental' },
  { name: 'world',        q: 'world' },
  { name: 'soundtrack',   q: 'soundtrack' },
];

export class SoundCloudNotConfigured extends Error {
  constructor() {
    super('SOUNDCLOUD_CLIENT_ID not set');
    this.code = 'SOUNDCLOUD_NOT_CONFIGURED';
  }
}

export async function fetchTracksPage(query, page = 1, perPage = 200) {
  const clientId = process.env.SOUNDCLOUD_CLIENT_ID;
  if (!clientId) throw new SoundCloudNotConfigured();

  const offset = (page - 1) * perPage;
  const params = new URLSearchParams({
    client_id: clientId,
    license: CC_LICENSES,
    q: query.q || '',
    limit: String(perPage),
    offset: String(offset),
    linked_partitioning: '1',
  });
  const res = await fetch(`${BASE}?${params.toString()}`, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json' },
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error(`soundcloud auth ${res.status} — check SOUNDCLOUD_CLIENT_ID`);
  }
  if (res.status === 429) {
    const retry = Number(res.headers.get('retry-after') || 5);
    await new Promise((r) => setTimeout(r, retry * 1000));
    return fetchTracksPage(query, page, perPage);
  }
  if (!res.ok) throw new Error(`soundcloud ${res.status}`);
  const data = await res.json();
  // V2 of the API returns { collection, next_href }; V1 returns a bare array.
  const items = Array.isArray(data?.collection) ? data.collection
    : Array.isArray(data) ? data
    : [];
  return items.map((t) => normalize(t, query, clientId)).filter(Boolean);
}

function normalize(t, query, clientId) {
  if (!t || t.id == null || !t.title) return null;
  // Defensive: SoundCloud's `license` filter sometimes leaks
  // "all-rights-reserved" — quality gate rejects, but skip earlier to
  // save downstream work.
  if (!t.license || t.license === 'all-rights-reserved') return null;
  if (!t.streamable) return null;

  // Stream URL needs the client_id appended (SC's playback constraint).
  const stream = t.stream_url ? `${t.stream_url}?client_id=${clientId}` : null;
  if (!stream) return null;

  return {
    external_id: String(t.id),
    source: 'soundcloud',
    title: String(t.title || 'Untitled').slice(0, 510),
    artist_name: String(
      (t.user && (t.user.username || t.user.full_name)) || 'Unknown'
    ).slice(0, 250),
    genre: null,
    _genre_hint: t.genre || query.q || null,
    duration_seconds: typeof t.duration === 'number' ? Math.round(t.duration / 1000) : null,
    stream_url: stream,
    download_url: t.downloadable && t.download_url
      ? `${t.download_url}?client_id=${clientId}`
      : stream,
    license: t.license,
    artwork_url: t.artwork_url || (t.user && t.user.avatar_url) || null,
  };
}
