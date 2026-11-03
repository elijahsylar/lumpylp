import dotenv from 'dotenv';
import http from 'node:http';
dotenv.config();

const CCMIXTER_BASE = 'http://ccmixter.org/api/query';

// Same allowlist as archive.js — ccMixter user tags are similarly free-form,
// so only accept matches against this curated set of real music genres.
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

// Native fetch (undici) caps response headers at 16KB and ccMixter exceeds
// that with its Set-Cookie payload — use http directly with a bigger buffer.
function getJSON(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      url,
      {
        headers: { 'User-Agent': 'LumpyLP/0.1 (+https://lumpylp.com)' },
        maxHeaderSize: 1 << 20,
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`ccMixter ${res.statusCode} on ${url}`));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (e) {
            reject(e);
          }
        });
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error(`ccMixter timeout on ${url}`)));
  });
}

// Phase 15: tag-sliced backfill. ccMixter's catalog skews to remixes,
// instrumentals, and stylistic tags; iterating distinct slices lets us
// reach much deeper than the original single 'music' query did. Each entry
// is a distinct tags= filter; the indexer pages each slice independently.
//
// Phase 17.5: two-pronged expansion past the ~1000-offset cap each
// individual slice hits.
//   (a) ~17 additional tag slices for tags not previously walked.
//   (b) license-sliced fallback for the original big tags (tag × license
//       sub-slices, each well under the cap). License slugs per the
//       ccMixter Query API: by, sa, nc, ncsa, pd.
//
// Skipped license slugs:
//   - `nd` — tiny slice; the existing tag-only walks already cover it.
//   - `splus` (Sampling Plus) — quality-gate's normalizer doesn't map it
//     onto an accepted license, so every fetched track would be rejected.
//
// Phase 17.5 chunk 2.1: dropped the `sort=date` "recent" slices. Smoke
// test confirmed ccMixter's default ordering is already date-descending,
// so adding sort=date walks the exact same data — pure duplicate work.
//
// `name` is what the indexer logs / dedupes by — it's not sent to the API.
// `tags` and `lic` are appended to the query string.
const ORIGINAL_TAGS = [
  'remix', 'acappella', 'instrumental', 'electronic', 'ambient',
  'hip_hop', 'rock', 'jazz', 'experimental',
];

const NEW_TAGS = [
  'dub', 'funk', 'acoustic', 'dance', 'world', 'reggae', 'pop',
  'country', 'blues', 'chiptune', 'lo-fi', 'trap', 'synthwave',
  'drone', 'noise', 'vocal', 'samples', 'loops',
];

const LICENSE_SLUGS = ['by', 'sa', 'nc', 'ncsa', 'pd'];

function buildLicenseSlices(tags) {
  const out = [];
  for (const t of tags) {
    for (const l of LICENSE_SLUGS) {
      out.push({ name: `${t}_${l}`, tags: t, lic: l });
    }
  }
  return out;
}

export const CCMIXTER_QUERIES = [
  ...ORIGINAL_TAGS.map((t) => ({ name: t, tags: t })),
  ...NEW_TAGS.map((t) => ({ name: t, tags: t })),
  ...buildLicenseSlices(ORIGINAL_TAGS),
];

export async function fetchTracksPage(query, page = 1, perPage = 100) {
  const offset = (page - 1) * perPage;
  const params = new URLSearchParams({
    f: 'json',
    limit: String(perPage),
    offset: String(offset),
    tags: (query && query.tags) || 'music',
  });
  if (query?.lic) params.set('lic', query.lic);

  const url = `${CCMIXTER_BASE}?${params.toString()}`;
  const data = await getJSON(url);
  const items = Array.isArray(data) ? data : [];
  return items.map(normalizeCCMixterTrack).filter(Boolean);
}

function normalizeCCMixterTrack(t) {
  if (!t || !t.upload_id) return null;

  const files = Array.isArray(t.files) ? t.files : [];
  const mp3 = files.find(
    (f) => f?.file_format_info?.mime_type === 'audio/mpeg'
  );
  if (!mp3 || !mp3.download_url) return null;

  // Force https — browsers block http audio from https pages (mixed content).
  // ccMixter content URLs serve cleanly over https.
  const httpsUrl = mp3.download_url.replace(/^http:\/\//i, 'https://');

  const tagsRaw = t.upload_extra?.usertags || '';
  const genre = String(tagsRaw)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .find((s) => GENRE_ALLOWLIST.has(s)) || null;

  return {
    external_id: String(t.upload_id),
    source: 'ccmixter',
    title: (t.upload_name || 'Untitled').toString().slice(0, 510),
    artist_name: (t.user_real_name || t.user_name || 'Unknown').toString().slice(0, 250),
    genre: genre ? genre.slice(0, 120) : null,
    duration_seconds: parseDuration(mp3.file_format_info?.ps),
    stream_url: httpsUrl,
    download_url: httpsUrl,
    license: t.license_name || 'CC',
    artwork_url: null,
  };
}

function parseDuration(d) {
  if (d == null) return null;
  if (typeof d === 'number') return Math.round(d);
  const parts = String(d).split(':').map(Number);
  if (parts.some(Number.isNaN)) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] || null;
}
