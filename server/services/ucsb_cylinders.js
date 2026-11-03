// UCSB Cylinder Audio Archive — direct scrape of cylinders.library.ucsb.edu.
// ~10,000 cylinder digitizations from 1895-1923; we ingest only pre-1923
// (release year ≤ 1922) which UCSB declares fully PD and freely usable for
// any purpose, commercial or non-commercial (per licensing.php, 2022-01-01
// announcement). 1923+ transfers are CC BY-NC 2.5 and skipped.
//
// Discovery: sitemap.xml lists exactly 10,000 detail page URLs.
// URLs use nq=1 parameter which works without a PHP session cookie.
// Audio: S3 at cylinders.s3-us-west-2.amazonaws.com/{folder}/{id}/cusb-cyl{id}d.mp3
//
// Recon + build doc: internal research notes (not in this repo)
// Supersedes archive-cylinders.js's 183-item IA mirror long-term.

const SITEMAP_URL = 'https://cylinders.library.ucsb.edu/sitemap.xml';
const UA = `LumpyLP catalog indexer; contact ${process.env.INDEXER_CONTACT_EMAIL || 'takedowns@lumpylp.com'}`;
const POLITE_DELAY_MS = 2000;
const CUTOFF_YEAR = 1923; // < 1923 = PD any use; ≥ 1923 = CC BY-NC, skip

let _sitemapCache = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loadSitemapUrls() {
  if (_sitemapCache) return _sitemapCache;
  const res = await fetch(SITEMAP_URL, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`ucsb sitemap fetch ${res.status}`);
  const xml = await res.text();
  const urls = [];
  const re = /<loc>(https?:\/\/cylinders\.library\.ucsb\.edu\/detail\.php[^<]+)<\/loc>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    urls.push(m[1].replace(/&amp;/g, '&'));
  }
  _sitemapCache = urls;
  return urls;
}

function decodeHtmlEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&mdash;/g, '—')
    .replace(/&nbsp;/g, ' ');
}

function extractField(html, label) {
  // class may have a leading space: class=" data-label" (UCSB quirk)
  const re = new RegExp(
    `<div class="\\s*data-label">\\s*${label}:[\\s]*</div>[\\s\\S]*?<div class="data-entry"[^>]*>([\\s\\S]*?)</div>`,
    'i',
  );
  const m = html.match(re);
  if (!m) return null;
  return decodeHtmlEntities(m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

// Parse "between 1898 and 1900" → 1900, "ca. 1905" → 1905, "1910." → 1910
// Returns null if no year found.
function parseReleaseYear(str) {
  if (!str) return null;
  const nums = str.match(/\d{4}/g);
  if (!nums) return null;
  // "between X and Y" → take the later year (conservative: if Y < CUTOFF we're safe)
  const years = nums.map(Number).filter((y) => y >= 1880 && y <= 1940);
  if (!years.length) return null;
  return Math.max(...years);
}

function inferGenre(notes) {
  if (!notes) return null;
  const n = notes.toLowerCase();
  if (/opera|aria/.test(n)) return 'classical';
  if (/ragtime|cakewalk|two-step/.test(n)) return 'jazz';
  if (/jazz/.test(n)) return 'jazz';
  if (/vaudeville|comic|comedy/.test(n)) return 'comedy';
  if (/hymn|sacred|gospel/.test(n)) return 'folk';
  if (/folk/.test(n)) return 'folk';
  return null;
}

async function fetchDetail(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`ucsb detail ${res.status}: ${url}`);
  const html = await res.text();
  return parseDetail(url, html);
}

function parseDetail(url, html) {
  // Title
  const titleMatch = html.match(/<h1\s+id="uniform_title[^"]*">([\s\S]*?)<\/h1>/i);
  if (!titleMatch) return null;
  const title = decodeHtmlEntities(
    titleMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(),
  );
  if (!title) return null;

  // Audio URL — primary from <audio src>
  const audioMatch = html.match(/<audio[^>]*src="(https:\/\/cylinders\.s3[^"]+\.mp3)"[^>]*>/i);
  if (!audioMatch) return null;
  const streamUrl = audioMatch[1];

  // Cylinder ID from audio URL (e.g. cusb-cyl0006d.mp3 → 0006)
  const idMatch = streamUrl.match(/cusb-cyl(\d+)/);
  const cylinderId = idMatch ? idMatch[1] : streamUrl;

  const performers = extractField(html, 'Performers') || extractField(html, 'Performer');
  const yearStr = extractField(html, 'Release year') || extractField(html, 'Release Year');
  const notes = extractField(html, 'Notes');

  const releaseYear = parseReleaseYear(yearStr);

  // Only ingest pre-1923; skip unknowns to be conservative
  if (!releaseYear || releaseYear >= CUTOFF_YEAR) return null;

  // Avoid GARBAGE_ARTIST_NAMES rejection ("unknown", "unknown artist", etc.)
  const artist = performers && performers.length > 2 ? performers : 'Performer unlisted';

  return {
    external_id: `ucsb_cylinders:${cylinderId}`,
    source: 'ucsb_cylinders',
    title,
    artist_name: artist,
    genre: inferGenre(notes) || 'pre-1929',
    duration_seconds: null,
    stream_url: streamUrl,
    download_url: streamUrl,
    license: 'public-domain',
    artwork_url: null,
  };
}

export const UCSB_CYLINDERS_QUERIES = [{ name: 'all-cylinders' }];

export async function fetchTracksPage(query, page = 1, perPage = 25) {
  const urls = await loadSitemapUrls();
  const start = (page - 1) * perPage;
  const slice = urls.slice(start, start + perPage);
  if (slice.length === 0) return [];

  const tracks = [];
  for (const url of slice) {
    try {
      const t = await fetchDetail(url);
      if (t) tracks.push(t);
    } catch (err) {
      console.error(`[ucsb_cylinders] skip ${url}: ${err.message}`);
    }
    if (slice.indexOf(url) < slice.length - 1) {
      await sleep(POLITE_DELAY_MS);
    }
  }
  return tracks;
}
