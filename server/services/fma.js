import dotenv from 'dotenv';
dotenv.config();

const FMA_BASE = process.env.FMA_API_BASE || 'https://freemusicarchive.org/api';

async function getJSON(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'LumpyLP/0.1 (+https://lumpylp.com)' },
  });
  if (!res.ok) throw new Error(`FMA ${res.status} on ${url}`);
  return res.json();
}

export async function fetchTracksPage(page = 1, perPage = 50) {
  const url = `${FMA_BASE}/trending/track?page=${page}&limit=${perPage}`;
  const data = await getJSON(url);
  const items = data.dataset || data.tracks || data.data || [];
  return items.map(normalizeFMATrack).filter(Boolean);
}

function normalizeFMATrack(t) {
  if (!t) return null;
  const externalId = String(t.track_id || t.id || t.trackId || '');
  if (!externalId) return null;

  return {
    external_id: externalId,
    source: 'fma',
    title: (t.track_title || t.title || '').slice(0, 510) || 'Untitled',
    artist_name: (t.artist_name || t.artist || 'Unknown').slice(0, 250),
    genre: (t.track_genres?.[0]?.genre_title || t.genre_title || t.genre || null)?.slice(0, 120) || null,
    duration_seconds: parseDuration(t.track_duration || t.duration),
    stream_url: t.track_listen_url || t.stream_url || t.audio_url || null,
    download_url: t.track_url || t.download_url || null,
    license: t.license_title || t.license || 'CC',
    artwork_url: t.track_image_file || t.image || t.artwork_url || null,
  };
}

function parseDuration(d) {
  if (typeof d === 'number') return Math.round(d);
  if (!d) return null;
  const parts = String(d).split(':').map(Number);
  if (parts.some(isNaN)) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] || null;
}
