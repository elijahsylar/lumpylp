// The one public shape of a track in API responses (relaunch items 2 and 11).
// Streaming only: no download URL, no direct file URL (the player always
// goes through /api/stream/:id), no internal health columns. Every track
// carries attribution data.
import { attributionFor } from './attribution.js';

// SELECT list for a track aliased `t`. stream_url is read for attribution and
// the `playable` flag but never sent to clients.
export const TRACK_COLUMNS_SQL = `t.id, t.external_id, t.source, t.title, t.artist_name, t.genre,
       t.duration_seconds, t.license, t.artwork_url, t.stream_url,
       t.upvotes, t.downvotes, (t.upvotes - t.downvotes) AS net_lumps`;

// Extra columns some endpoints add, passed through when present.
const PASSTHROUGH = ['user_vote', 'window_net', 'position', 'available',
  'artist_city', 'artist_country', 'artist_location_source', 'artist_distance_miles'];

export function serializeTrack(row) {
  const out = {
    id: row.id,
    external_id: row.external_id,
    source: row.source,
    title: row.title,
    artist_name: row.artist_name,
    genre: row.genre ?? null,
    duration_seconds: row.duration_seconds ?? null,
    license: row.license ?? null,
    artwork_url: row.artwork_url ?? null,
    upvotes: Number(row.upvotes) || 0,
    downvotes: Number(row.downvotes) || 0,
    net_lumps: Number(row.net_lumps ?? (row.upvotes - row.downvotes)) || 0,
    playable: !!row.stream_url,
    attribution: attributionFor(row),
  };
  for (const k of PASSTHROUGH) if (row[k] !== undefined) out[k] = row[k];
  return out;
}

export const serializeTracks = (rows) => rows.map(serializeTrack);
