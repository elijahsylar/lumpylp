import dotenv from 'dotenv';
dotenv.config();

const SEARCH_URL = 'https://archive.org/advancedsearch.php';
const META_URL = 'https://archive.org/metadata';

// Indexer iterates each collection independently with its own page count
// (no more global-page → collection mapping in this file).
export const ARCHIVE_COLLECTIONS = [
  { name: 'opensource_audio',   q: 'collection:opensource_audio AND mediatype:audio AND format:mp3' },
  { name: 'netlabels',          q: 'collection:netlabels AND mediatype:audio AND format:mp3' },
  { name: 'audio_music',        q: 'collection:audio_music AND mediatype:audio AND format:mp3' },
  { name: '78rpm',              q: 'collection:78rpm AND mediatype:audio AND format:mp3' },
  { name: 'librivox-music',     q: 'collection:librivoxaudio AND subject:music AND mediatype:audio AND format:mp3' },
  { name: 'oldtimeradio_music', q: 'collection:oldtimeradio AND subject:music AND mediatype:audio AND format:mp3' },
  { name: 'jazz',               q: 'subject:jazz AND mediatype:audio AND format:mp3' },
  { name: 'folkways',           q: 'collection:folkways AND mediatype:audio AND format:mp3' },
  { name: 'electronicmusic',    q: 'collection:electronicmusic AND mediatype:audio AND format:mp3' },
  { name: 'communityaudio',     q: 'collection:opensource_movies AND mediatype:audio AND format:mp3' },
];

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

// In-memory cache of identifier → resolved mp3 URL (or null).
// Persists for the whole indexer run; cuts duplicate metadata fetches.
const mp3UrlCache = new Map();

async function getJSON(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'LumpyLP/0.1 (+https://lumpylp.com)' },
  });
  if (!res.ok) throw new Error(`Archive.org ${res.status} on ${url}`);
  return res.json();
}

async function resolveMp3Url(identifier) {
  if (mp3UrlCache.has(identifier)) return mp3UrlCache.get(identifier);

  let url = null;
  try {
    const meta = await getJSON(`${META_URL}/${encodeURIComponent(identifier)}`);
    const files = Array.isArray(meta?.files) ? meta.files : [];
    const mp3 = files.find(
      (f) => typeof f?.name === 'string' && f.name.toLowerCase().endsWith('.mp3')
    );
    if (mp3) {
      url = `https://archive.org/download/${encodeURIComponent(identifier)}/${encodeURIComponent(mp3.name)}`;
    }
  } catch (err) {
    console.warn(`[archive] metadata lookup failed for ${identifier}: ${err.message}`);
  }

  mp3UrlCache.set(identifier, url);
  return url;
}

export async function fetchTracksPage(collection, page = 1, perPage = 50) {
  if (!collection || !collection.q) return [];
  const q = collection.q.replace(/ /g, '+');
  const url =
    `${SEARCH_URL}` +
    `?q=${q}` +
    `&fl[]=identifier,title,creator,subject` +
    `&rows=${perPage}` +
    `&page=${page}` +
    `&output=json` +
    `&sort[]=downloads+desc`;

  const data = await getJSON(url);
  const docs = data?.response?.docs || [];

  const tracks = [];
  for (const d of docs) {
    const t = await normalizeArchiveTrack(d);
    if (t) tracks.push(t);
  }
  return tracks;
}

async function normalizeArchiveTrack(d) {
  if (!d || !d.identifier) return null;
  const id = String(d.identifier);

  const streamUrl = await resolveMp3Url(id);
  if (!streamUrl) return null;

  const subjects = Array.isArray(d.subject)
    ? d.subject
    : d.subject ? [d.subject] : [];
  const genre = subjects
    .map((s) => (typeof s === 'string' ? s.trim().toLowerCase() : ''))
    .find((s) => GENRE_ALLOWLIST.has(s)) || null;

  const title = (d.title || 'Untitled').toString().slice(0, 510);
  const creator = Array.isArray(d.creator) ? d.creator[0] : d.creator;
  const artist = (creator || 'Unknown').toString().slice(0, 250);

  return {
    external_id: id,
    source: 'archive',
    title,
    artist_name: artist,
    genre: genre ? genre.slice(0, 120) : null,
    duration_seconds: null,
    stream_url: streamUrl,
    download_url: streamUrl,
    license: 'public-domain',
    artwork_url: `https://archive.org/services/img/${id}`,
  };
}
