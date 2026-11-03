// License display data for every raw `tracks.license` value seen in
// production (recon 2026-10-25, work/license.txt), plus the canonical slugs
// the quality gate writes. Unknown values fall back to "License unknown".
//
// Version: our rows don't record the CC license version (the normalizer
// keeps the family only), so names carry no version and links go to CC's
// version-less deed path, which CC redirects to the current version. The
// item's own page (attribution.source_url) carries the exact license.
const CC = (code, name) => ({ name, url: `https://creativecommons.org/licenses/${code}/` });

const TABLE = {
  'cc0':           { name: 'CC0 (public domain dedication)', url: 'https://creativecommons.org/publicdomain/zero/1.0/' },
  'public-domain': { name: 'Public domain (US)', url: 'https://creativecommons.org/publicdomain/mark/1.0/' },
  'cc-by':         CC('by', 'CC BY'),
  'cc-by-sa':      CC('by-sa', 'CC BY-SA'),
  'cc-by-nd':      CC('by-nd', 'CC BY-ND'),
  'cc-by-nc':      CC('by-nc', 'CC BY-NC'),
  'cc-by-nc-sa':   CC('by-nc-sa', 'CC BY-NC-SA'),
  'cc-by-nc-nd':   CC('by-nc-nd', 'CC BY-NC-ND'),
  'sampling-plus':    { name: 'CC Sampling Plus', url: 'https://creativecommons.org/licenses/sampling+/1.0/' },
  'nc-sampling-plus': { name: 'CC NonCommercial Sampling Plus', url: 'https://creativecommons.org/licenses/nc-sampling+/1.0/' },
  'free-art':      { name: 'Free Art License', url: 'https://artlibre.org/licence/lal/en/' },
  'taper-policy':  { name: 'Live Music Archive trading policy (non-commercial, streaming)', url: 'https://help.archive.org/help/live-music-archive-etree-org/' },
  'audius-platform':     { name: 'Audius terms (streaming only)', url: 'https://openaudiofoundation.org/legal/terms-of-use' },
  'all-rights-reserved': { name: 'All rights reserved; streamed under Audius terms', url: 'https://openaudiofoundation.org/legal/terms-of-use' },
  'loc-jukebox-stream-only': { name: 'Library of Congress: streaming only, rights reserved', url: 'https://www.loc.gov/jukebox/about' },
};

// Raw values ingested before the quality gate existed (Jamendo's bare
// "by-*", ccMixter's long names) map onto the slugs above.
const ALIASES = {
  'by': 'cc-by', 'by-sa': 'cc-by-sa', 'by-nd': 'cc-by-nd', 'by-nc': 'cc-by-nc',
  'by-nc-sa': 'cc-by-nc-sa', 'by-nc-nd': 'cc-by-nc-nd',
  'attribution': 'cc-by', 'attribution (3.0)': 'cc-by', 'attribution (4.0)': 'cc-by',
  'attribution noncommercial': 'cc-by-nc', 'attribution noncommercial  (3.0)': 'cc-by-nc',
  'attribution noncommercial (3.0)': 'cc-by-nc',
  'sampling plus': 'sampling-plus', 'noncommercial sampling plus': 'nc-sampling-plus',
};

/** Every raw value observed in production on 2026-10-25 (coverage test). */
export const PROD_OBSERVED_LICENSES = [
  'cc-by-nc-sa', 'cc-by-nc-nd', 'cc-by-nc', 'public-domain', 'cc-by-sa', 'taper-policy', 'cc-by',
  'cc-by-nd', 'all-rights-reserved', 'audius-platform', 'nc-sampling-plus', 'sampling-plus', 'cc0',
  'Attribution Noncommercial  (3.0)', 'Attribution (3.0)', 'Noncommercial Sampling Plus', 'Sampling Plus',
  'Attribution Noncommercial', 'Attribution (4.0)', 'Attribution', 'by-nc-nd', 'CC', 'by-nc-sa', 'by-sa',
  'by', 'by-nd', 'by-nc', 'free-art',
];

const UNKNOWN = { name: 'License unknown', url: null };

/** { name, url } for a raw license value. `known` is false for the fallback. */
export function licenseInfo(raw) {
  const key = String(raw || '').trim();
  if (!key) return { ...UNKNOWN, known: false };
  if (key === 'CC') {
    // Jamendo 2005-08 rows whose specific CC license could not be parsed.
    // attribution.js links the item page, which states the exact license.
    return { name: 'Creative Commons (exact license on the source page)', url: null, known: true };
  }
  const slug = TABLE[key] ? key : ALIASES[key.toLowerCase()];
  return slug ? { ...TABLE[slug], known: true } : { ...UNKNOWN, known: false };
}
