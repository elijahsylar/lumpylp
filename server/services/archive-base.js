// Internet Archive fetcher factory. Both archive_netlabels and
// archive_cylinders use the same two-stage flow (Advanced Search →
// per-identifier Metadata API → expand release into per-track rows);
// only the collection filter differs. This module returns a configured
// fetchTracksPage() bound to a specific collection.
//
// Phase 15B additions vs. raw 15A logic:
//   - format-deduplication: pick one row per logical track (e.g. choose
//     `_vbr.mp3` over `.mp3` over `.flac` over `.ogg`)
//   - spoken-word filter: skip releases whose subject metadata reads as
//     a lecture / talk / interview / audiobook (the IA `netlabels` and
//     `UCSBCylinder` collections both have edge cases here)
//
// Phase 17 additions:
//   - basename logicalKey (chunk 13) so etree subdirectory paths don't
//     blow up external_id past varchar(128)
//   - capExternalId hash-suffix fallback (chunk 14) for the residual
//     ~1% of etree releases whose identifier+basename together still
//     exceed 128 chars (e.g. `06-s-1t-6-chewie-drive-to-space-...`
//     paired with `03-s1t3-old-home-place-drive-to-space-...`)
//
// Phase 18 fix (2026-05-09): switched fetchIdentifierPage from offset
// pagination (`advancedsearch.php?...&page=N`) to cursor pagination
// (`services/search/v1/scrape?...&cursor=...`).
//
// Why: advancedsearch.php has a hard 10,000-result deep-paging cap.
// Past page=200 (item 10,001+), it returns:
//   {"error":"[DEEP_PAGING] Requested results would exceed the deep
//    paging limit for this service, 10000 results; scraping is
//    supported through the Scraping API"}
// IA's own recommendation: switch to scrape API. See
//   https://archive.org/help/aboutsearch.htm
//
// Effect across our IA resolvers (numFound vs DB before fix):
//   archive_pd78s     49,259 → 9,913   (cap hit)
//   archive_netlabels 78,111 → 2,023   (cap hit, 97% missing)
//   archive_livemusic 289,459 → 124,723 (pre-cap leftover; cap now
//                                        hits new runs)
//   archive_subjects  varies; per-subject slices stayed under 10k
//   archive_cylinders 183 → 307         (well under cap, unaffected)
//
// Sort behavior change:
//   Before: sort=identifier asc — deterministic alphabetic ordering
//           per IA's Solr backend. Same query at different times
//           returned the same first-N items in the same order.
//   After:  no sort (per IA: "For best results, do NOT specify any
//           sort"). Cursor-defined order — internally consistent
//           within a single walk but not reproducible across runs.
//
//   Implications:
//     - "First N items" is no longer stable. A --max-pages=2 sample
//       run today may surface different items than tomorrow.
//     - Dedup analysis on a partial slice can't assume the same
//       items are sampled across runs.
//     - INSERT IGNORE on (external_id, source) handles non-deterministic
//       ingest order correctly — full ingest converges to the same
//       set regardless of order. No resolver depends on alphabetical
//       ordering for correctness.
//
//   Why this is fine: full-corpus runs always reach the same items
//   eventually (cursor walks until exhaustion), and partial runs have
//   never been guaranteed-stable across ingests anyway (IA adds new
//   items, items get removed, etc.). The non-determinism only matters
//   for ad-hoc sample-run inspection, where it's a minor inconvenience.
//
// earlyExitOnShortPage in the indexer driver still works correctly:
// the new code only sets _scrapeExhausted=true on a genuinely empty
// batch or missing-cursor response (real end-of-data), not on the
// DEEP_PAGING error that the old code couldn't distinguish from
// end-of-data.

import crypto from 'node:crypto';

const SCRAPE = 'https://archive.org/services/search/v1/scrape';
const METADATA = 'https://archive.org/metadata';
const DOWNLOAD = 'https://archive.org/download';
const ARTWORK = 'https://archive.org/services/img';
const UA = 'LumpyLP catalog indexer (https://lumpylp.com)';

const POLITE_DELAY_MS = 500;
// Scrape API enforces a minimum count of 100, but observed behavior on
// 2026-05-10 shows the API exhausts a cursor walk early at lower
// batch sizes:
//   count=100  exhausts at ~19,200 items (regardless of corpus size)
//   count=1000 walks the full corpus (verified at 49,259 for
//              archive_pd78s' query — exhausts cleanly at full count)
// Use 1000 to ensure full-corpus coverage. Each scrape call still
// returns one batch; downstream metadata fetch loop processes the
// 1000 items sequentially. Caller-facing "page" semantics unchanged.
const SEARCH_PAGE_SIZE = 1000;
const DEFAULT_RELEASE_FILE_LIMIT = 50;

const AUDIO_EXT = /\.(mp3|flac|ogg)$/i;

// Subject substrings that mean "this isn't music". Matched case-insensitively
// against the joined release subject string.
//
// TODO (post-17.5): the filter only checks metadata.subject + description,
// so academic lectures whose IA subject is e.g. "history, india" but whose
// titles read "Statement by Prof Wendy Doniger - 6 march 2014" slip
// through. Patterns to consider for a future expansion:
//   - title regex for date-in-title (`\b\d{1,2}[ -][a-z]+[ -]\d{4}\b`)
//   - title prefixes: "lecture by", "talk by", "statement by"
//   - academic title markers in artist: "Dr.", "Prof.", "Professor"
// Surfaced by phase17.5 deep probe of opensource_audio. Out of 17.5 scope
// since fixing it benefits all IA wrappers and warrants its own phase.
const SPOKEN_WORD_TERMS = [
  'lecture', 'talk', 'speech', 'interview', 'audiobook', 'podcast',
  'radio show', 'spoken word', 'spoken-word', 'oral history', 'sermon',
  'reading', 'narration', 'panel discussion', 'conference',
  // Phase 18 v1 international additions: collection-name + es/pt
  // cognates for non-English talk content. radioprograms catches IA's
  // collection-name convention; entrevista/palestra/conferencia/charla
  // catch Spanish/Portuguese interview / talk content found in the
  // samba-slice and similar v2 recon samples.
  'radioprograms', 'entrevista', 'palestra', 'conferencia', 'charla',
];

// Format priority for dedup: lower index = preferred. We keep at most one
// row per "logical track" identified by stripping known format-variant
// suffixes (`_vbr`, `_64kb`, `_hifi`, …) before the extension.
const FORMAT_PRIORITY = [
  /_vbr\.mp3$/i,    // VBR mp3 — best of mp3 family
  /\.mp3$/i,        // plain mp3
  /\.flac$/i,       // lossless but huge
  /_64kb\.mp3$/i,   // low-bitrate mp3
  /\.ogg$/i,        // ogg
];

function formatRank(filename) {
  for (let i = 0; i < FORMAT_PRIORITY.length; i++) {
    if (FORMAT_PRIORITY[i].test(filename)) return i;
  }
  return FORMAT_PRIORITY.length; // unknown → worst
}

// Reduce "Track_01_-_Foo_vbr.mp3" / "Track_01_-_Foo.mp3" / "Track_01_-_Foo.flac"
// to a single shared key so the dedup logic can pick the best format.
//
// Etree releases can put files in a sub-directory whose name duplicates
// the IA identifier (e.g. "<id>.flac16/<id>file_t01.flac16.flac"); we
// drop the directory component so the external_id stays within the
// tracks.external_id varchar(128) column.
function logicalKey(filename) {
  const base = filename.split('/').pop() || filename;
  return base
    .toLowerCase()
    .replace(/_(vbr|64kb|128kb|192kb|256kb|320kb|hifi|hires|sample)$/i, '')
    .replace(/\.(mp3|flac|ogg)$/i, '');
}

// tracks.external_id is varchar(128). For most sources `${id}:${key}` fits
// comfortably, but a small fraction of etree releases pair a 60+ char IA
// identifier with a 60+ char file basename and overflow. When that
// happens we keep the 115-char prefix and append a 12-hex SHA-1 of the
// full string, separated by ':'. The prefix is enough to keep the row
// human-readable; the hash makes collisions vanishingly unlikely. ID is
// still deterministic per (identifier, file) so re-runs INSERT IGNORE
// correctly.
const EXTERNAL_ID_MAX = 128;
function capExternalId(id) {
  if (id.length <= EXTERNAL_ID_MAX) return id;
  const hash = crypto.createHash('sha1').update(id).digest('hex').slice(0, 12);
  const head = id.slice(0, EXTERNAL_ID_MAX - 1 - hash.length); // ":" + hash
  return `${head}:${hash}`;
}

let lastFetchAt = 0;
async function politeFetch(url) {
  const wait = POLITE_DELAY_MS - (Date.now() - lastFetchAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastFetchAt = Date.now();
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json' },
  });
  if (!res.ok) throw new Error(`archive ${res.status} on ${url}`);
  return res;
}

function arrify(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

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

function cleanFilename(name) {
  let s = name.replace(/\.(mp3|flac|ogg)$/i, '');
  s = s.replace(/^[0-9]{1,3}[\s._\-]+/, ''); // leading "01 - "
  s = s.replace(/[_-]+/g, ' ').trim();
  return s;
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

function isSpokenWordRelease(meta, extraCollectionRejects = [], extraSpokenWordPatterns = []) {
  // Join all subject + collection + description text we have and check
  // for spoken-word markers. Avoid checking the title alone because legit
  // music sometimes has words like "interview" in the title (e.g. an
  // album track called "The Interview").
  const subjects = arrify(meta?.metadata?.subject).join(' ').toLowerCase();
  const desc = String(meta?.metadata?.description || '').toLowerCase();
  const haystack = `${subjects} ${desc}`;
  if (SPOKEN_WORD_TERMS.some((term) => haystack.includes(term))) return true;
  if (extraCollectionRejects.length) {
    const cols = arrify(meta?.metadata?.collection).map((c) => String(c).toLowerCase());
    if (cols.some((c) => extraCollectionRejects.includes(c))) return true;
  }
  // Per-source extra patterns (e.g. archive_subjects' gospel-sermon regex
  // and field-recording SFX-loop regex). Applied against an extended haystack
  // that ALSO includes the release title, since archive_subjects items
  // often have the spoken-word marker in the title rather than the subject.
  if (extraSpokenWordPatterns.length) {
    const title = String(meta?.metadata?.title || '').toLowerCase();
    const extHaystack = `${haystack} ${title}`;
    if (extraSpokenWordPatterns.some((re) => re.test(extHaystack))) return true;
  }
  return false;
}

// Group files by logical-track key and emit one entry per group, picking
// the highest-priority format from each. Filenames that don't match any
// AUDIO_EXT are skipped before this step.
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

// Optional per-source overrides:
//   releaseFileLimit:                int    drop releases above this file count (default 50)
//   extraCollectionRejects:          string[] additional collection names that imply non-music
//                                            (e.g. ['spokenwordandstorytelling'])
//   rejectReleaseIfAnyFileLongerSec: number drop the entire release if any audio file exceeds
//                                            this length (etree multi-night box sets often
//                                            have one continuous-recording file per night)
//   pickFileTitle:                   fn(file) -> string|null  — title resolver per audio file
//                                            (defaults to file.title fallback)
//   artistFromIdentifier:            fn(identifier) -> string|null  — last-resort artist
//                                            derivation when neither file nor metadata creator
//                                            is set (etree identifiers usually start with a
//                                            band-name slug)
//   searchMediaType:                 string IA `mediatype:` value used in the search query
//                                            (default 'audio'). The Live Music Archive
//                                            (collection:etree) tags its items mediatype:etree
//                                            instead, so AND-ing with mediatype:(audio)
//                                            matches zero rows there — pass 'etree' or null
//                                            to skip the mediatype filter.
//   defaultLicense:                  string fallback license used when neither
//                                            metadata.licenseurl nor metadata.license is set
//                                            on the release. Etree items lack any license
//                                            metadata at the IA level (taper policies are
//                                            band-by-band, not encoded as CC URLs); we slug
//                                            them as 'taper-policy' so the gate has something
//                                            it can normalize. Sources that genuinely require
//                                            an IA license (netlabels, cylinders) leave this
//                                            null so the legacy "no license -> drop" rule
//                                            stays in force.
export function createArchiveSourceFetcher({
  sourceName,
  collection,
  searchQuery = null,
  releaseFileLimit = DEFAULT_RELEASE_FILE_LIMIT,
  extraCollectionRejects = [],
  extraExcludeCollections = [],
  extraSpokenWordPatterns = [],
  rejectReleaseIfAnyFileLongerSec = null,
  pickFileTitle = null,
  artistFromIdentifier = null,
  searchMediaType = 'audio',
  defaultLicense = null,
  trackPostprocess = null,
}) {
  // extraExcludeCollections: array of collection names to AND-exclude
  // server-side at search time via `-collection:(name)` clauses. Used
  // when a noisy parent collection contaminates a subject-faceted view
  // (e.g., archive_subjects' carnatic slice excludes the imcradio
  // German-radio flood). Different from extraCollectionRejects, which
  // is per-item filtering during expansion.
  // trackPostprocess: optional fn(meta) -> object. Called once per release
  // after the per-track expansion; the returned object's properties are
  // merged onto every track. Used by archive_pd78s to inject per-track
  // country/region from metadata.language without each resolver reaching
  // into the IA metadata shape directly.
  // searchQuery overrides the collection-based default. Pass searchQuery
  // for sources that filter by `subject:` or other facets rather than by
  // a fixed `collection:` slug. `collection` and `searchQuery` are
  // mutually exclusive — exactly one must be provided.
  if ((collection == null) === (searchQuery == null)) {
    throw new Error(
      `archive-base: createArchiveSourceFetcher needs exactly one of `
      + `{collection, searchQuery} for source "${sourceName}"`
    );
  }
  const _BASE_QUERY = searchQuery
    ? searchQuery
    : (searchMediaType
        ? `collection:(${collection}) AND mediatype:(${searchMediaType})`
        : `collection:(${collection})`);
  // Append per-fetcher search-time exclusions (extraExcludeCollections).
  // Used by archive_subjects' carnatic slice to drop the imcradio German-
  // radio flood at search time rather than per-item.
  const SEARCH_QUERY = extraExcludeCollections.length
    ? `${_BASE_QUERY} AND ${extraExcludeCollections.map((c) => `-collection:(${c})`).join(' AND ')}`
    : _BASE_QUERY;
  const _identifierCache = new Map();
  // Cursor state for the scrape-API walk. The cursor advances
  // monotonically across fetchIdentifierPage(page=1, 2, 3, ...) calls.
  // Within a single fetcher instance, pages must be requested in order
  // (the indexer driver does this) — re-asking for an earlier page
  // hits the cache; jumping forward walks the cursor as needed.
  let _scrapeCursor = null;
  let _highestPageWalked = 0;
  let _scrapeExhausted = false;
  const extraRejects = extraCollectionRejects.map((c) => String(c).toLowerCase());

  async function fetchIdentifierPage(page) {
    // Defensive reset on page=1: production runs spawn fresh Node
    // processes so the module-level fetcher's cursor is always
    // pristine, but interactive --dry-run testing reuses the same
    // process and would otherwise leak cursor state across calls.
    if (page === 1) {
      _scrapeCursor = null;
      _highestPageWalked = 0;
      _scrapeExhausted = false;
      _identifierCache.clear();
    }
    if (_identifierCache.has(page)) return _identifierCache.get(page);

    while (_highestPageWalked < page && !_scrapeExhausted) {
      const params = new URLSearchParams();
      params.set('q', SEARCH_QUERY);
      params.set('fields', 'identifier');
      params.set('count', String(SEARCH_PAGE_SIZE));
      if (_scrapeCursor) params.set('cursor', _scrapeCursor);
      // No sort — see top-of-file rationale block.
      const res = await politeFetch(`${SCRAPE}?${params.toString()}`);
      const data = await res.json();
      const ids = (data?.items || [])
        .map((it) => it.identifier)
        .filter(Boolean);
      _highestPageWalked++;
      _identifierCache.set(_highestPageWalked, ids);

      _scrapeCursor = data?.cursor || null;
      if (!_scrapeCursor || ids.length === 0) {
        _scrapeExhausted = true;
      }
    }

    return _identifierCache.get(page) || [];
  }

  async function fetchMetadata(identifier) {
    const res = await politeFetch(`${METADATA}/${encodeURIComponent(identifier)}`);
    return res.json();
  }

  function expandRelease(identifier, meta) {
    if (!meta || !Array.isArray(meta.files)) {
      console.error(`[${sourceName}] reject:no-metadata ${identifier}`);
      return [];
    }

    // Collection-membership check applies only when this fetcher was
    // configured with a fixed `collection`. Search-query-mode fetchers
    // (archive_subjects) don't have a single canonical collection — items
    // surface from many collections via the subject facet, so we trust
    // the search query already filtered correctly.
    if (collection != null) {
      const collections = arrify(meta.metadata?.collection);
      if (!collections.includes(collection)) {
        console.error(`[${sourceName}] reject:wrong-collection ${identifier}`);
        return [];
      }
    }

    if (meta.files.length > releaseFileLimit) {
      console.error(`[${sourceName}] reject:too-many-files ${identifier} files=${meta.files.length}`);
      return [];
    }

    const releaseLicense = meta.metadata?.licenseurl
      || meta.metadata?.license
      || defaultLicense
      || null;
    if (!releaseLicense) {
      console.error(`[${sourceName}] reject:no-licenseurl ${identifier}`);
      return [];
    }

    if (isSpokenWordRelease(meta, extraRejects, extraSpokenWordPatterns)) {
      console.error(`[${sourceName}] reject:spoken-word ${identifier}`);
      return [];
    }

    // Live-music releases sometimes contain a single multi-hour file
    // (a full continuous set). One per-file rejection drops the whole
    // release so we don't emit a 90+min "track".
    if (rejectReleaseIfAnyFileLongerSec) {
      for (const f of meta.files) {
        if (!f || typeof f.name !== 'string' || !AUDIO_EXT.test(f.name)) continue;
        const sec = parseDuration(f.length);
        if (typeof sec === 'number' && sec > rejectReleaseIfAnyFileLongerSec) {
          console.error(`[${sourceName}] reject:file-too-long ${identifier} sec=${sec}`);
          return [];
        }
      }
    }

    const releaseArtist = pickFirst(
      meta.metadata?.creator,
      meta.metadata?.artist
    );
    const releaseGenre = pickFirst(meta.metadata?.subject) || null;

    const tracks = [];
    for (const f of dedupeByFormat(meta.files)) {
      let title;
      if (pickFileTitle) {
        title = pickFileTitle(f);
        if (!title) title = cleanFilename(f.name);
      } else {
        title = (f.title && String(f.title).trim()) || cleanFilename(f.name);
      }
      if (!title) continue;

      let artist = pickFirst(f.creator, f.artist) || releaseArtist;
      if (!artist && artistFromIdentifier) artist = artistFromIdentifier(identifier);

      tracks.push({
        external_id: capExternalId(`${identifier}:${logicalKey(f.name)}`),
        source: sourceName,
        title: title.slice(0, 510),
        artist_name: (artist || 'Unknown').slice(0, 250),
        genre: releaseGenre,
        duration_seconds: parseDuration(f.length),
        stream_url: `${DOWNLOAD}/${encodeURIComponent(identifier)}/${encodeURI(f.name)}`,
        download_url: `${DOWNLOAD}/${encodeURIComponent(identifier)}/${encodeURI(f.name)}`,
        license: releaseLicense,
        artwork_url: `${ARTWORK}/${encodeURIComponent(identifier)}`,
      });
    }
    // Per-resolver post-processing: inject geo/temporal fields from the
    // release-level metadata onto every track. Callback returns null to
    // skip; otherwise its properties merge in.
    if (trackPostprocess) {
      try {
        const extra = trackPostprocess(meta);
        if (extra) {
          for (const t of tracks) Object.assign(t, extra);
        }
      } catch (err) {
        console.error(`[${sourceName}] trackPostprocess threw on ${identifier}: ${err.message}`);
      }
    }
    return tracks;
  }

  async function fetchTracksPage(_query, page = 1) {
    const ids = await fetchIdentifierPage(page);
    if (ids.length === 0) return [];
    const tracks = [];
    for (const id of ids) {
      let meta;
      try {
        meta = await fetchMetadata(id);
      } catch (err) {
        console.error(`[${sourceName}] metadata failed for ${id}:`, err.message);
        continue;
      }
      const expanded = expandRelease(id, meta);
      for (const t of expanded) tracks.push(t);
    }
    return tracks;
  }

  return { fetchTracksPage };
}
