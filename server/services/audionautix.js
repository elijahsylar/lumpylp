// Audionautix — Jason Shaw's personal CC BY 4.0 catalog. No public API,
// so we scrape the genre pages. Site is small (a few hundred tracks across
// the genre listing) and Jason updates rarely — this is essentially a
// one-shot indexer; the indexer driver de-dupes via the (external_id, source)
// unique key.
//
// URL structure (verified by probing the homepage):
//   listing pages live at  https://audionautix.com/free-music/<slug>
//   each track row contains  <h3>Title (M:SS)</h3>  +  <a href="/Music/<File>.mp3">
//   genres are slug-cased (e.g. "hard-rock", "lo-fi", "acid-jazz")
//
// Politeness: 2s delay between page fetches, custom UA. We never need to
// fetch individual track pages — listing pages already have the .mp3 URL,
// title, and duration embedded.

import * as cheerio from 'cheerio';

const BASE = 'https://audionautix.com';
const UA = 'LumpyLP catalog indexer (https://lumpylp.com)';

// Slugs taken straight from the genre menu on https://audionautix.com.
// `name` is the per-query indexer log tag; `path` is the URL path.
export const AUDIONAUTIX_QUERIES = [
  { name: 'acid-jazz',      path: '/free-music/acid-jazz' },
  { name: 'acoustic',       path: '/free-music/acoustic' },
  { name: 'ballad',         path: '/free-music/ballad' },
  { name: 'bluegrass',      path: '/free-music/bluegrass' },
  { name: 'blues',          path: '/free-music/blues' },
  { name: 'country',        path: '/free-music/country' },
  { name: 'dance',          path: '/free-music/dance' },
  { name: 'easy-listening', path: '/free-music/easy-listening' },
  { name: 'electronic',     path: '/free-music/electronic' },
  { name: 'ethnic',         path: '/free-music/ethnic' },
  { name: 'folk',           path: '/free-music/folk' },
  { name: 'gospel',         path: '/free-music/gospel' },
  { name: 'hard-rock',      path: '/free-music/hard-rock' },
  { name: 'hip-hop',        path: '/free-music/hip-hop' },
  { name: 'house',          path: '/free-music/house' },
  { name: 'jazz',           path: '/free-music/jazz' },
  { name: 'jazz-funk',      path: '/free-music/jazz-funk' },
  { name: 'latin',          path: '/free-music/latin' },
  { name: 'lo-fi',          path: '/free-music/lo-fi' },
  { name: 'meditative',     path: '/free-music/meditative' },
  { name: 'other',          path: '/free-music/other' },
  { name: 'pop-funk',       path: '/free-music/pop-funk' },
  { name: 'punk-rock',      path: '/free-music/punk-rock' },
  { name: 'reggae',         path: '/free-music/reggae' },
  { name: 'rock',           path: '/free-music/rock' },
  { name: 'soundtrack',     path: '/free-music/soundtrack' },
  { name: 'symphony',       path: '/free-music/symphony' },
  { name: 'techno',         path: '/free-music/techno' },
];

const PAGE_DELAY_MS = 2000;

let lastFetchAt = 0;

async function politeFetch(url) {
  const wait = PAGE_DELAY_MS - (Date.now() - lastFetchAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastFetchAt = Date.now();
  // No explicit Accept header: audionautix's Apache returns 406 with
  // Accept: text/html (mod_negotiation strangeness with their PHP variants).
  // Default fetch Accept (*/*) negotiates fine.
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`audionautix ${res.status} on ${url}`);
  return res.text();
}

// Audionautix lists every track on its genre page in a single flat HTML
// view — there's no pagination. Honor the indexer's page param by returning
// the full list on page 1 and an empty array thereafter.
export async function fetchTracksPage(query, page = 1) {
  if (page > 1) return [];
  const url = `${BASE}${query.path}`;
  const html = await politeFetch(url);
  return parseGenrePage(html, query);
}

function parseGenrePage(html, query) {
  const $ = cheerio.load(html);
  const out = [];
  const seen = new Set();

  // Each track block lives in .feat-left; title + duration in its <h3>,
  // mp3 in a sibling .songs anchor. Iterating .feat-left gives us one row
  // per track and lets us scope title extraction to that block.
  $('.feat-left').each((_, el) => {
    const $block = $(el);
    const h3 = $block.find('h3').first().text().trim();
    if (!h3) return;

    const m = h3.match(/^(.*?)\s*\((\d{1,2}):([0-5]\d)\)\s*$/);
    let title, duration_seconds = null;
    if (m) {
      title = m[1].trim();
      duration_seconds = Number(m[2]) * 60 + Number(m[3]);
    } else {
      title = h3;
    }
    if (!title) return;

    const mp3Href = $block.find('a[href$=".mp3"]').first().attr('href')
      || $block.next().find('a[href$=".mp3"]').first().attr('href')
      || $block.parents().find('a[href$=".mp3"]').first().attr('href');
    if (!mp3Href) return;

    const absUrl = mp3Href.startsWith('http')
      ? mp3Href
      : new URL(mp3Href, BASE).toString();
    if (seen.has(absUrl)) return;
    seen.add(absUrl);

    // External ID — stable slug from the mp3 path.
    const slug = absUrl
      .replace(/^https?:\/\/[^/]+/, '')
      .replace(/\.mp3.*$/i, '')
      .replace(/^\/+/, '')
      .replace(/[^a-z0-9]+/gi, '-')
      .toLowerCase();

    out.push({
      external_id: slug,
      source: 'audionautix',
      title: title.slice(0, 510),
      artist_name: 'Jason Shaw',
      genre: null, // assigned via genre-mapper using query.name as hint
      _genre_hint: query.name,
      duration_seconds,
      stream_url: absUrl,
      download_url: absUrl,
      license: 'cc-by',
      artwork_url: null,
    });
  });

  return out;
}
