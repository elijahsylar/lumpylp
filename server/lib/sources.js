// Canonical registry of catalog sources, used to build the search source
// filter.
//
// This mirrors the SOURCES array in server/indexer/index.js. It is a
// hand-maintained copy rather than a runtime import because importing the
// indexer pulls in every resolver module (and their network clients) —
// the API process has no reason to load any of that. When you add a source
// to the indexer, add it here too.
//
// Historically the API hardcoded ALLOWED_SOURCES = ['archive', 'ccmixter',
// 'jamendo', 'wikimedia'] and matched with `t.source = ?`. No row has ever
// had source='archive' — the archive.org corpus is split across five
// collection-specific resolvers — so the Archive filter always returned
// zero rows, and the other 14 sources (including audius, the largest by
// far) were not filterable at all.

/** Every source name the indexer can write into tracks.source. */
export const SOURCE_NAMES = [
  'archive_pd78s',
  'archive_livemusic',
  'archive_netlabels',
  'archive_subjects',
  'archive_cylinders',
  'ucsb_cylinders',
  'audius',
  'jamendo',
  'ccmixter',
  'wikimedia',
  'musopen',
  'loc_jukebox',
  'incompetech',
  'audionautix',
  'phlow',
  'europeana',
  'smithsonian',
  'soundcloud',
];

/**
 * Filter keys that expand to more than one concrete source name. `archive`
 * keeps the old filter key working — it now matches every archive.org
 * collection rather than a source name that never existed.
 */
export const SOURCE_GROUPS = {
  archive: [
    'archive_pd78s',
    'archive_livemusic',
    'archive_netlabels',
    'archive_subjects',
    'archive_cylinders',
  ],
};

/** Display labels; anything not listed is title-cased from its key. */
const LABELS = {
  archive: 'Archive.org',
  archive_pd78s: 'Archive · 78s',
  archive_livemusic: 'Archive · Live',
  archive_netlabels: 'Archive · Netlabels',
  archive_subjects: 'Archive · Subjects',
  archive_cylinders: 'Archive · Cylinders',
  ucsb_cylinders: 'UCSB Cylinders',
  audius: 'Audius',
  jamendo: 'Jamendo',
  ccmixter: 'ccMixter',
  wikimedia: 'Wikimedia',
  musopen: 'Musopen',
  loc_jukebox: 'LOC Jukebox',
  incompetech: 'Incompetech',
  audionautix: 'Audionautix',
  phlow: 'Phlow',
  europeana: 'Europeana',
  smithsonian: 'Smithsonian',
  soundcloud: 'SoundCloud',
};

const labelFor = (key) =>
  LABELS[key] || key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * The filter list the client renders as tabs. Groups come first so the
 * broad "Archive.org" option sits ahead of its five members.
 */
export const SOURCE_FILTERS = [
  ...Object.keys(SOURCE_GROUPS).map((key) => ({
    value: key,
    label: labelFor(key),
    sources: SOURCE_GROUPS[key],
  })),
  ...SOURCE_NAMES.map((name) => ({
    value: name,
    label: labelFor(name),
    sources: [name],
  })),
];

const VALID = new Set(SOURCE_FILTERS.map((f) => f.value));

/**
 * Turn a ?source= value into a SQL fragment + params.
 *
 * Returns null for empty/unknown values so callers can treat "no filter"
 * and "garbage filter" the same way (show everything) rather than
 * silently returning zero rows.
 */
export function resolveSourceFilter(value) {
  const key = String(value || '').trim();
  if (!key || !VALID.has(key)) return null;

  const names = SOURCE_GROUPS[key] || [key];
  if (names.length === 1) {
    return { sql: 't.source = ?', params: [names[0]] };
  }
  return {
    sql: `t.source IN (${names.map(() => '?').join(', ')})`,
    params: names,
  };
}
