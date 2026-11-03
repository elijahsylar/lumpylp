// IA pre-1926 78 RPM corpus — PD-by-age under 17 USC § 1401 (Music
// Modernization Act / CLASSICS Act, 2018). Sound recordings fixed
// before Jan 1, 1926 are US public domain as of 2026-05-09; the
// cutoff advances by 1 year each Jan 1.
//
// Recon: internal research notes (not in this repo)
// Sample-verified 49/49 items pre-1926 are music (no spoken-word
// leakage). 0.2% spoken-word-tagged across the corpus; stock
// SPOKEN_WORD_TERMS handles them.
//
// Volume: ~49,260 unique items (post-cylindertransfer dedup);
// estimated ~58,000 tracks after expansion.
//
// Per-track tagging (Phase 18, schema option (a)):
//   - genre = 'pre-1929' (temporal category, hard override)
//   - country = derived from IA metadata.language via lib/lang_geo
//   - region = derived from country (or directly when country null
//     for multi-country languages like Yiddish/Arabic)
//   - title-mining as secondary signal when language tag missing

import { createArchiveSourceFetcher } from './archive-base.js';
import { deriveTrackGeo } from '../lib/lang_geo.js';

// Sound-recording PD calendar (17 USC § 1401): on Jan 1 of year Y, US
// recordings first published in Y-101 or earlier are public domain
// (2026: 1925 and earlier; 2027: 1926). Computed, so no yearly bump.
//
// The old filter was `date:[* TO 1926-01-01]`. Lucene ranges are inclusive
// and IA indexes a year-only date "1926" as 1926-01-01, so 2,450 items of
// 1926 recordings (2,558 tracks) slipped in. The range now ends on Dec 31 of
// the last PD year. Migration 018 hid the rows that got in.
export function pdCutoffYear(today = new Date()) {
  return today.getUTCFullYear() - 101;
}

// Cross-source dedup: cylindertransfer is the existing
// archive_cylinders source (~169 pre-1926 items, all members of the
// 78rpm parent — verified during recon).
export function buildSearchQuery(today = new Date()) {
  return `collection:(78rpm)`
    + ` AND mediatype:(audio)`
    + ` AND date:[* TO ${pdCutoffYear(today)}-12-31]`
    + ` AND -collection:(cylindertransfer)`;
}

// Per-release postprocess: attach temporal genre + country/region.
// Called once per release from archive-base; the returned object
// merges onto every track in that release.
function pd78sPostprocess(meta) {
  const m = meta?.metadata || {};
  const haystack = [
    m.title || '',
    Array.isArray(m.creator) ? m.creator.join(' ') : (m.creator || ''),
    Array.isArray(m.subject) ? m.subject.join(' ') : (m.subject || ''),
    Array.isArray(m.description) ? m.description.join(' ') : (m.description || ''),
  ].join(' ');
  const geo = deriveTrackGeo({
    language: m.language,
    fallbackText: haystack,
  });
  return {
    // Temporal category — hard override regardless of subject metadata
    genre: 'pre-1929',
    // Geographic — language-tag primary, title-mining secondary
    country: geo.country,
    region: geo.region,
  };
}

const fetcher = createArchiveSourceFetcher({
  sourceName: 'archive_pd78s',
  searchQuery: buildSearchQuery(),
  // 90% of pre-1926 78rpm items have no licenseurl set on IA but are
  // PD by age. The date filter in the search query is the legal
  // justification (MMA / CLASSICS Act); mark the corpus PD here so
  // the quality gate doesn't drop items that pass the date check
  // but lack IA-tagged license metadata.
  defaultLicense: 'public-domain',
  // Pre-1929 multi-side opera box sets routinely have 70-100 sides
  // per release (one IA "release" = one digitized box set, not one
  // disc). DEFAULT_RELEASE_FILE_LIMIT=50 dropped them; raise to 200
  // matching archive_livemusic. Estimated ~50-100 such box sets
  // across the full 49k corpus.
  releaseFileLimit: 200,
  // Per recon, 49/49 sampled items were music. Stock spoken-word
  // filter (SPOKEN_WORD_TERMS in archive-base.js) handles the
  // ~0.2% (120/61,022) tagged-spoken-word edge cases; no per-slice
  // override needed.
  trackPostprocess: pd78sPostprocess,
});

export const ARCHIVE_PD78S_QUERIES = [{ name: 'pd78s' }];

export async function fetchTracksPage(query, page = 1, perPage) {
  return fetcher.fetchTracksPage(query, page, perPage);
}
