// Phlow.net — curated CC netlabel release catalog. Phlow itself doesn't
// host audio; each release page links out to archive.org. The 1,018
// individual /netlabels/release/<netlabel>/<slug>/ entries are a
// hand-vetted subset of IA's `collection:netlabels` (and adjacent CC-only
// netlabel collections), with richer per-release metadata than IA exposes
// (curated music-style tags, release dates, netlabel attribution).
//
// Integration shape:
//   1. Walk phlow.net/netlabels/sitemap.xml once per indexer run.
//      Filter to /netlabels/release/<netlabel>/<slug>/ URLs.
//   2. For each release URL, fetch the page, parse phlow's metadata
//      (title, artist, netlabel, cover, music-style, IA identifier).
//   3. Dereference https://archive.org/metadata/<id> for the audio file
//      list. Same endpoint archive-base.js uses.
//   4. Emit one track per audio file in the IA item, tagged source='phlow'
//      with the curated metadata.
//
// We intentionally tag rows source='phlow' (not 'archive_netlabels') even
// when the IA identifier overlaps with an existing archive_netlabels row.
// Phlow's `Music Style` field is a stronger genre signal than IA's
// free-form `subject`, and we want that distinction preserved. Some
// dedup-by-stream_url across sources may be desirable later but is out of
// scope here.
//
// Politeness: 1.5s between phlow page fetches, 500ms between IA metadata
// fetches (matches archive-base.js convention). The sitemap walk is one
// fetch per indexer run, cached in module state.
//
// Day-1 reference: internal research notes (not in this repo)

import crypto from 'node:crypto';

const SITEMAP_URL = 'https://phlow.net/netlabels/sitemap.xml';
const IA_METADATA = 'https://archive.org/metadata';
const IA_DOWNLOAD = 'https://archive.org/download';
const IA_ARTWORK  = 'https://archive.org/services/img';
const UA = 'LumpyLP catalog indexer (https://lumpylp.com)';

const PHLOW_DELAY_MS = 1500;
const IA_DELAY_MS = 500;

const RELEASE_PATH_RE = /^\/netlabels\/release\/[^/]+\/[^/]+\/?$/;
const AUDIO_EXT = /\.(mp3|flac|ogg)$/i;

// Format priority for per-track dedup, matching archive-base.js conventions.
const FORMAT_PRIORITY = [
  /_vbr\.mp3$/i,    // VBR mp3 — best of mp3 family
  /\.mp3$/i,        // plain mp3
  /\.flac$/i,       // lossless
  /_64kb\.mp3$/i,   // low-bitrate mp3
  /\.ogg$/i,
];

const EXTERNAL_ID_MAX = 128;

// Indexer-shape uniformity — phlow has only one query slice (the full
// sitemap). The indexer's per-query log/dedup keys off the name.
export const PHLOW_QUERIES = [{ name: 'all-releases' }];

let _phlowFetchAt = 0;
let _iaFetchAt = 0;
let _releaseUrls = null;  // module-level sitemap cache; first page primes it
let _cursor = 0;          // index into _releaseUrls for the next slice to consume

async function politeFetchPhlow(url) {
  const wait = PHLOW_DELAY_MS - (Date.now() - _phlowFetchAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  _phlowFetchAt = Date.now();
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`phlow ${res.status} on ${url}`);
  return res.text();
}

async function politeFetchIA(url) {
  const wait = IA_DELAY_MS - (Date.now() - _iaFetchAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  _iaFetchAt = Date.now();
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`archive ${res.status} on ${url}`);
  return res.json();
}

async function loadSitemap() {
  if (_releaseUrls) return _releaseUrls;
  const xml = await politeFetchPhlow(SITEMAP_URL);
  const urls = [];
  const re = /<loc>([^<]+)<\/loc>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const u = m[1].trim();
    let path;
    try { path = new URL(u).pathname; } catch { continue; }
    if (RELEASE_PATH_RE.test(path)) urls.push(u);
  }
  _releaseUrls = urls;
  return _releaseUrls;
}

function formatRank(filename) {
  for (let i = 0; i < FORMAT_PRIORITY.length; i++) {
    if (FORMAT_PRIORITY[i].test(filename)) return i;
  }
  return FORMAT_PRIORITY.length;
}

// Reduce "Track_01_Foo_vbr.mp3" + "Track_01_Foo.mp3" + "Track_01_Foo.flac" to
// a single shared key so dedup picks the best format. Same shape archive-base
// uses; duplicated here rather than imported because archive-base doesn't
// export it.
function logicalKey(filename) {
  const base = filename.split('/').pop() || filename;
  return base
    .toLowerCase()
    .replace(/_(vbr|64kb|128kb|192kb|256kb|320kb|hifi|hires|sample)$/i, '')
    .replace(/\.(mp3|flac|ogg)$/i, '');
}

function capExternalId(id) {
  if (id.length <= EXTERNAL_ID_MAX) return id;
  const hash = crypto.createHash('sha1').update(id).digest('hex').slice(0, 12);
  const head = id.slice(0, EXTERNAL_ID_MAX - 1 - hash.length);
  return `${head}:${hash}`;
}

function dedupeByFormat(files) {
  const byKey = new Map();
  for (const f of files) {
    if (!f || typeof f.name !== 'string' || !AUDIO_EXT.test(f.name)) continue;
    const key = logicalKey(f.name);
    const existing = byKey.get(key);
    if (!existing || formatRank(f.name) < formatRank(existing.name)) {
      byKey.set(key, f);
    }
  }
  return [...byKey.values()];
}

function parseDuration(d) {
  if (d == null) return null;
  if (typeof d === 'number') return Math.round(d);
  const s = String(d);
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s));
  const parts = s.split(':').map(Number);
  if (parts.some(Number.isNaN)) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] || null;
}

function cleanFilenameToTitle(name) {
  let s = name.replace(/\.(mp3|flac|ogg)$/i, '');
  s = s.replace(/^[0-9]{1,3}[\s._\-]+/, '');     // leading "01 - "
  s = s.replace(/[_-]+/g, ' ').trim();
  return s;
}

function htmlEntityDecode(s) {
  if (!s) return s;
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

// Parse one phlow release page with regex (no cheerio — keeps the resolver
// dependency-free and matches incompetech.js's lightweight pattern).
// Returns { title, artist, netlabel, music_style, release_date, ia_id,
// cover_url, source_url } or null if the page didn't yield enough.
function parseReleasePage(html, sourceUrl) {
  // Title + artist — phlow's pattern is `<h1>»TITLE« by ARTIST</h1>` inside
  // <article>. Site nav also has an <h1> ("Netlabel ORG"), so we match the
  // h1 that directly contains the release-title pattern, not just the first.
  const tm = html.match(/<h1[^>]*>\s*»([^«]+)«\s*by\s+([^<]+?)\s*<\/h1>/i);
  if (!tm) return null;
  const title = htmlEntityDecode(tm[1]).trim();
  const artist = htmlEntityDecode(tm[2]).trim();

  // Netlabel: from URL path /netlabels/release/<netlabel>/<slug>/
  const pathParts = new URL(sourceUrl).pathname.split('/').filter(Boolean);
  const netlabel = pathParts[2] || null;

  // Cover image — phlow uses class="t15 b15" on the cover img
  const coverMatch = html.match(/<img[^>]+class=["'][^"']*\bt15\b[^"']*\bb15\b[^"']*["'][^>]*src=["']([^"']+)["']/i)
    || html.match(/<img[^>]+src=["']([^"']+)["'][^>]+class=["'][^"']*\bt15\b[^"']*\bb15\b/i);
  let coverUrl = coverMatch ? coverMatch[1] : null;
  if (coverUrl && !coverUrl.startsWith('http')) {
    coverUrl = new URL(coverUrl, sourceUrl).toString();
  }

  // Page-meta block: scope text within id="page-meta", strip tags, then
  // grep for the labeled fields.
  const metaBlockMatch = html.match(/<div[^>]+id=["']page-meta["'][^>]*>([\s\S]*?)<\/div>/i);
  const metaText = metaBlockMatch ? metaBlockMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ') : '';
  const dateMatch = metaText.match(/Release Date:\s*(\d{4}-\d{2}-\d{2})/i);
  const styleMatch = metaText.match(/Music Style:\s*([^\n\r<]+?)(?:\s*Release-ID:|$)/i);

  // IA identifier from the first anchor pointing at archive.org/details/<id>
  const iaMatch = html.match(/href=["']https?:\/\/(?:www\.)?archive\.org\/details\/([^"'/?#]+)/i);
  if (!iaMatch) return null;  // phlow doesn't host audio
  const iaId = decodeURIComponent(iaMatch[1]);

  return {
    title,
    artist,
    netlabel,
    music_style: styleMatch
      ? styleMatch[1].trim().replace(/[–—]/g, '-').replace(/\s+/g, ' ')
      : null,
    release_date: dateMatch ? dateMatch[1] : null,
    ia_id: iaId,
    cover_url: coverUrl,
    source_url: sourceUrl,
  };
}

// First non-empty string from a list of candidates.
function pickFirst(...vals) {
  for (const v of vals) {
    if (v == null) continue;
    if (Array.isArray(v) && v.length) {
      const first = v.find((x) => typeof x === 'string' && x.trim());
      if (first) return first.trim();
    }
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

// Map an IA item's metadata + phlow's curated metadata into per-track rows.
// Mirrors archive-base.js's expandRelease but tags everything with phlow
// attribution. Returns [] if the IA item has no usable license or audio.
function expandIntoTracks(meta, phlow) {
  if (!meta || !Array.isArray(meta.files)) return [];
  const license = meta.metadata?.licenseurl || meta.metadata?.license || null;
  if (!license) return [];

  const audioFiles = dedupeByFormat(meta.files);
  if (audioFiles.length === 0) return [];

  // Skip multi-hour single-file releases (matches archive_livemusic guardrail).
  for (const f of audioFiles) {
    const sec = parseDuration(f.length);
    if (typeof sec === 'number' && sec > 5400) return [];
  }

  const releaseArtist = pickFirst(
    phlow.artist,
    meta.metadata?.creator,
    meta.metadata?.artist,
  );

  const tracks = [];
  for (const f of audioFiles) {
    const fileTitle = (f.title && String(f.title).trim()) || cleanFilenameToTitle(f.name);
    if (!fileTitle) continue;
    const fileArtist = pickFirst(f.creator, f.artist) || releaseArtist || 'Unknown';
    const externalId = capExternalId(`${phlow.ia_id}:${logicalKey(f.name)}`);

    tracks.push({
      external_id: externalId,
      source: 'phlow',
      title: fileTitle.slice(0, 510),
      artist_name: fileArtist.slice(0, 250),
      genre: null,
      // Music styles arrive multi-genre, e.g. "IDM - EXPERIMENTAL - BREAKBEATS".
      // Take the first segment (split on ` - ` or `,`) so the genre-mapper
      // gets a clean single token. Single-genre strings without separators
      // pass through whole.
      _genre_hint: phlow.music_style
        ? phlow.music_style.split(/\s+-\s+|,/)[0].trim().toLowerCase() || null
        : null,
      duration_seconds: parseDuration(f.length),
      stream_url: `${IA_DOWNLOAD}/${encodeURIComponent(phlow.ia_id)}/${encodeURI(f.name)}`,
      download_url: `${IA_DOWNLOAD}/${encodeURIComponent(phlow.ia_id)}/${encodeURI(f.name)}`,
      license,
      artwork_url: phlow.cover_url || `${IA_ARTWORK}/${encodeURIComponent(phlow.ia_id)}`,
    });
  }
  return tracks;
}

export async function fetchTracksPage(_query, page = 1, perPage = 10) {
  const urls = await loadSitemap();

  // Page=1 resets the cursor so re-runs start from the top of the sitemap.
  // Subsequent calls advance the cursor regardless of which `page` value the
  // indexer passes — phlow's URL list contains long stretches of non-IA-hosted
  // releases (some netlabels mirror to bandcamp/scene.org instead of IA), and
  // a naive (page-1)*perPage slice can land entirely in such a stretch and
  // return []. The indexer's break-on-empty-page would then terminate the
  // crawl prematurely. By auto-skipping empty slices here, the contract holds:
  // empty-array return from this function = the sitemap is genuinely
  // exhausted, not just "this slice was unproductive."
  if (page === 1) _cursor = 0;

  while (_cursor < urls.length) {
    const slice = urls.slice(_cursor, _cursor + perPage);
    _cursor += perPage;

    const tracks = [];
    for (const url of slice) {
      let phlow;
      try {
        const html = await politeFetchPhlow(url);
        phlow = parseReleasePage(html, url);
      } catch (err) {
        console.error(`[phlow] page failed: ${url}: ${err.message}`);
        continue;
      }
      if (!phlow) continue;

      let meta;
      try {
        meta = await politeFetchIA(`${IA_METADATA}/${encodeURIComponent(phlow.ia_id)}`);
      } catch (err) {
        console.error(`[phlow] IA metadata failed: ${phlow.ia_id}: ${err.message}`);
        continue;
      }

      const expanded = expandIntoTracks(meta, phlow);
      for (const t of expanded) tracks.push(t);
    }
    if (tracks.length > 0) return tracks;
    // Otherwise continue: this slice yielded nothing (e.g. 10 consecutive
    // releases on a netlabel that doesn't mirror to IA), so advance the
    // cursor and try the next one.
  }
  return [];
}
