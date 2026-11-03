// Archive.org subject-faceted CC/PD sweep. Phase 17.6 second IA-meta source.
//
// Per the parallel recon (commit c06e8cb on recon-world-music) and
// internal research notes (not in this repo), IA's advancedsearch.php with
// `subject:"<phrase>" AND mediatype:audio AND licenseurl:*creativecommons*`
// surfaces CC/PD audio in cultural categories the existing collection-based
// IA integrations (archive_livemusic / archive_netlabels) don't reach.
//
// Seven subject queries, each with its own search slice and (where needed)
// per-slice spoken-word / SFX rejection patterns. All rows are tagged
// `source: 'archive_subjects'` regardless of which subject matched first;
// the indexer log distinguishes slices via query.name.
//
// Cross-source dedup happens at search time via negative collection
// clauses: items already covered by archive_netlabels (collection:netlabels),
// archive_livemusic (collection:etree), or archive_cylinders
// (collection:cylindertransfer) are excluded server-side and never enter
// the pipeline.

import { createArchiveSourceFetcher } from './archive-base.js';

// Negative collection clauses applied to every subject query. Add to this
// list when new IA-collection sources are integrated (e.g. archive_great78
// when that ships).
//
// Phase 17.6 baseline excluded the obvious cross-source dupes (netlabels,
// etree, cylindertransfer). Phase 18 v1 international subject sweep
// expands the blacklist with the 15+ collections found in v2/v3 recon
// to be heavy in non-music content (audiobooks, academic lectures,
// podcasts, religious sermons). Defense-in-depth: even if a v1
// subject query (e.g., flamenco) co-tags with a contaminating
// collection like nuova-voce, we filter at search time.
//
// Source list compiled from:
//   internal research notes (not in this repo)
//   internal research notes (not in this repo)
const EXCLUDE_COLLECTIONS_LIST = [
  // Phase 17.6 baseline — cross-source dedup
  'netlabels', 'etree', 'cylindertransfer',
  // Audiobook collections
  'librivoxaudio', 'audio_bookspoetry', 'audioboo_ru', 'studiosimsim',
  'audiobook_viet', 'booksbylanguage_vietnamese', 'booksbylanguage',
  'folksoundomy_audio_y2k',
  // Academic / library lecture archives (Trento library dominates Italian + German)
  'nuova-voce', 'biblio-fbk',
  // Radio show / podcast collections
  'radioshowinbox', 'radioshowarchive', 'radioprograms',
  'radiostationarchives', 'radiocce', 'radionauta',
  'podcasts', 'podcasts_miscellaneous',
  // Spoken-word religious
  'audio_religion',
];
const EXCLUDE_COLLECTIONS = EXCLUDE_COLLECTIONS_LIST.map((c) => `-collection:(${c})`).join(' AND ');
const COMMON_FILTERS = `mediatype:(audio) AND licenseurl:*creativecommons* AND ${EXCLUDE_COLLECTIONS}`;

function buildSearchQuery(subjectPhrase) {
  return `subject:("${subjectPhrase}") AND ${COMMON_FILTERS}`;
}

// Per-subject extra spoken-word / SFX patterns, each tested against the
// extended haystack (subject + description + title) inside archive-base's
// isSpokenWordRelease. Used to reject release-level items that pass the
// stock SPOKEN_WORD_TERMS check but still fall outside the music intent.
const GOSPEL_SERMON_PATTERNS = [
  /\b(sermon|preaching|preached|preaches|pastor|reverend|deacon)\b/i,
  /\b(message by|teaching|bible study)\b/i,
  /\b(sunday service|funeral service|wedding service|prayer service)\b/i,
];

// Per-slice config. Each builds a configured fetcher; archive_subjects.js's
// fetchTracksPage routes the indexer's call to the right one based on
// query.name. All share `sourceName: 'archive_subjects'` so the catalog
// rolls up to one source row.
//
// `field-recording` is intentionally NOT in this list. The 2026-05-05
// sample run found that ~70% of the field-recording subject's CC/PD
// items are phonography / sound-art / urban-soundscape rather than
// music in the LumpyLP-catalog sense, and the SFX-pattern filter
// designed for freesound-style tag conventions doesn't catch them
// (archive.org items don't self-tag as "sample"/"loop"). Deferred to
// a future phase pending a better music-vs-phonography heuristic. See
// internal research notes (not in this repo) for the full rationale.
// FIELD_RECORDING_SFX_PATTERNS is kept above so a future re-enable
// doesn't require re-deriving them.
const SLICE_CONFIGS = [
  // ── Phase 17.6 original 6 slices ──────────────────────────
  {
    name: 'gospel',
    subjectPhrase: 'gospel',
    extraSpokenWordPatterns: GOSPEL_SERMON_PATTERNS,
    rejectReleaseIfAnyFileLongerSec: 3600, // 60 min — tighter for sermon-prone slice
  },
  {
    name: 'devotional',
    subjectPhrase: 'devotional',
    extraSpokenWordPatterns: GOSPEL_SERMON_PATTERNS,
    rejectReleaseIfAnyFileLongerSec: 3600,
  },
  {
    name: 'hindustani',
    subjectPhrase: 'Hindustani',
  },
  {
    name: 'folk-music',
    subjectPhrase: 'folk music',
  },
  {
    name: 'world-music',
    subjectPhrase: 'world music',
  },
  {
    name: 'psalm',
    subjectPhrase: 'psalm',
    extraSpokenWordPatterns: GOSPEL_SERMON_PATTERNS,
    rejectReleaseIfAnyFileLongerSec: 3600,
  },
  // ── Phase 18 v1 international subject sweep — 11 new slices ─
  // Per internal research notes (not in this repo) (recon
  // 2026-05-08, eyeball-verified, locked).
  // Genre + country/region applied via SLICE_GENRE_OVERRIDE +
  // SLICE_GEO_OVERRIDE below.
  {
    name: 'celtic',
    subjectPhrase: 'celtic',
  },
  {
    name: 'cumbia',
    subjectPhrase: 'cumbia',
  },
  {
    name: 'dancehall',
    subjectPhrase: 'dancehall',
    // DJ-mix culture in dancehall — long continuous mixes leak
    // through subject-tagged-as-music. 60-min ceiling matches the
    // gospel-slice precedent.
    rejectReleaseIfAnyFileLongerSec: 3600,
  },
  {
    name: 'flamenco',
    subjectPhrase: 'flamenco',
  },
  {
    name: 'reggaeton',
    subjectPhrase: 'reggaeton',
    // Same DJ-mix risk as dancehall.
    rejectReleaseIfAnyFileLongerSec: 3600,
  },
  {
    name: 'raga',
    subjectPhrase: 'raga',
  },
  {
    name: 'tango',
    subjectPhrase: 'tango',
  },
  {
    name: 'salsa',
    subjectPhrase: 'salsa',
    // Same DJ-mix risk.
    rejectReleaseIfAnyFileLongerSec: 3600,
  },
  {
    name: 'carnatic',
    subjectPhrase: 'Carnatic',
    // imcradio is a single uploader running a German-language radio
    // program about Indian classical music; v1 recon found 100% of
    // a 3-item sample under this subject was imcradio German
    // narration, not music. radioprograms is the broader IA
    // collection-naming convention. Both excluded server-side.
    extraExcludeCollections: ['imcradio', 'radioprograms'],
  },
  {
    name: 'samba',
    subjectPhrase: 'samba',
  },
  {
    name: 'bhajan',
    subjectPhrase: 'bhajan',
  },
];

// Per-slice genre — HARD OVERRIDE applied to every accepted track regardless
// of what `subject` metadata says. The slice is named after the search facet
// (`subject:"gospel"` etc.), so the user-facing promise is "this is the
// <slice> category"; mixed-subject items get the slice's name, not their
// first listed subject's name. All values verified canonical in
// server/indexer/genre-mapper.js (`religious` added 2026-05-05 for the
// devotional + psalm slices). 2026-05-05 gospel sample showed 13.6%
// (3/22) of accepted items had a non-gospel first-subject (Dorothy
// Moore disco-gospel hybrids tagged `disco` first); soft-hint fallback
// missed those, hence the override.
const SLICE_GENRE_OVERRIDE = {
  // Phase 17.6
  'gospel':          'gospel',
  'devotional':      'religious',
  'hindustani':      'classical',
  'folk-music':      'folk',
  'world-music':     'world',
  'psalm':           'religious',
  // Phase 18 v1 international subject sweep
  'celtic':          'folk',
  'cumbia':          'latin',
  'dancehall':       'reggae',
  'flamenco':        'latin',
  'reggaeton':       'latin',
  'raga':            'classical',
  'tango':           'latin',
  'salsa':           'latin',
  'carnatic':        'classical',
  'samba':           'latin',
  'bhajan':          'religious',
};

// Phase 18 — per-slice country/region override. Applied to every track
// from the slice unless the resolver already set country (it doesn't —
// archive_subjects has no per-track geo derivation, so the slice-level
// values are authoritative). Preserves nulls where the tradition spans
// multiple countries.
//
// Per internal research notes (not in this repo):
const SLICE_GEO_OVERRIDE = {
  // Phase 17.6 slices intentionally have no geo — they're cross-cultural
  // (gospel spans US/UK/global; devotional crosses Hindu/Buddhist/etc.;
  // folk-music + world-music are explicitly multi-region; psalm is global
  // religious; hindustani → IN but defer until full v3 plan lands).
  // Phase 18 v1 international slices:
  'celtic':    { country: null, region: 'Northern Europe' },  // IE/UK/Scotland ambiguous
  'cumbia':    { country: 'CO', region: 'Latin America' },    // primarily Colombian origin
  'dancehall': { country: 'JM', region: 'Caribbean' },
  'flamenco':  { country: 'ES', region: 'Southern Europe' },
  'reggaeton': { country: 'PR', region: 'Latin America' },
  'raga':      { country: 'IN', region: 'South Asia' },
  'tango':     { country: 'AR', region: 'Latin America' },
  'salsa':     { country: null, region: 'Latin America' },    // multi-country (Cuba/PR/NYC origins)
  'carnatic':  { country: 'IN', region: 'South Asia' },
  'samba':     { country: 'BR', region: 'Latin America' },
  'bhajan':    { country: 'IN', region: 'South Asia' },
};

// Build one fetcher per slice. Each closes over its own search query and
// filter rules; the per-call query.name routes here.
const _fetchers = new Map();
for (const cfg of SLICE_CONFIGS) {
  const fetcher = createArchiveSourceFetcher({
    sourceName: 'archive_subjects',
    searchQuery: buildSearchQuery(cfg.subjectPhrase),
    extraSpokenWordPatterns: cfg.extraSpokenWordPatterns || [],
    extraExcludeCollections: cfg.extraExcludeCollections || [],
    rejectReleaseIfAnyFileLongerSec: cfg.rejectReleaseIfAnyFileLongerSec ?? null,
  });
  _fetchers.set(cfg.name, fetcher);
}

// Indexer-shape uniformity. Each slice is a query in this array; the
// indexer iterates and calls fetchTracksPage(query, page, perPage) per
// slice. The genre hint is annotated onto each track post-fetch.
export const ARCHIVE_SUBJECTS_QUERIES = SLICE_CONFIGS.map((c) => ({
  name: c.name,
  subjectPhrase: c.subjectPhrase,
}));

export async function fetchTracksPage(query, page = 1, perPage) {
  const fetcher = _fetchers.get(query.name);
  if (!fetcher) {
    throw new Error(`archive_subjects: unknown slice "${query?.name}"`);
  }
  const tracks = await fetcher.fetchTracksPage(query, page, perPage);
  const genreOverride = SLICE_GENRE_OVERRIDE[query.name] || null;
  const geoOverride = SLICE_GEO_OVERRIDE[query.name] || null;
  if (genreOverride || geoOverride) {
    for (const t of tracks) {
      if (genreOverride) t.genre = genreOverride;
      if (geoOverride) {
        // Slice-level geo is authoritative — archive_subjects has no
        // per-track geo derivation (unlike archive_pd78s which uses
        // trackPostprocess). The ?? guards against a future scenario
        // where a postprocess does set it; today this just assigns.
        t.country = t.country ?? geoOverride.country;
        t.region = t.region ?? geoOverride.region;
      }
    }
  }
  return tracks;
}
