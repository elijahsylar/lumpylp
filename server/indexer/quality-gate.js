// Phase 15 quality gate — applied AFTER source-specific normalization,
// BEFORE the upsert. Goal: prefer fewer, better tracks over high-volume spam.
//
// Each indexer that opts in calls passesQualityGate(track) and either
// upserts or pushes to the rejection log via logRejection().
//
// HEAD-test sampling for stream URLs is intentionally NOT in this module —
// that's a batch-level decision applied in the indexer driver, not per-track.

import fs from 'node:fs';
import path from 'node:path';

const REJECTION_LOG = process.env.LUMPYLP_REJECTION_LOG
  || '/var/log/lumpylp/indexer-rejections.log';

const MIN_DURATION_S = 30;
const MAX_DURATION_S = 60 * 60; // 60 minutes

// Permissive licenses we accept. Keys are normalized via normalizeLicense().
const ACCEPTED_LICENSES = new Set([
  'cc-by', 'cc-by-sa', 'cc-by-nc', 'cc-by-nc-sa', 'cc-by-nd', 'cc-by-nc-nd',
  'cc0', 'public-domain', 'pd',
  'free-art', 'free-art-license',
  // ccMixter Sampling Plus family (legitimate CC variants — sampling +
  // remix permitted, attribution required; NC variant adds non-commercial).
  'sampling-plus', 'cc-sampling-plus', 'nc-sampling-plus', 'cc-nc-sampling-plus',
  // Phase 17 additions:
  // - 'audius-platform': Audius platform-licensing model. Tracks remain
  //   owned by their artists but Audius's terms grant streaming/redistribution
  //   rights to apps like LumpyLP. Surfacing this through the gate (rather
  //   than bypassing via scripts/ingest-audius.js) keeps the spam/duration/
  //   artist-sanity rules in force without hiding the licensing reality.
  // - 'taper-policy': band-specific taper policies (Internet Archive's
  //   etree collection — Grateful Dead, Phish, etc.). Each band publishes
  //   permission to redistribute audience recordings; IA doesn't surface
  //   this as a CC URL, so we slug it as 'taper-policy' and trust the
  //   collection-level curation.
  'audius-platform', 'taper-policy',
]);

// Title spam patterns. Each entry: [regex, reason].
const TITLE_SPAM_PATTERNS = [
  // "Free X type beat" / "FREE BEAT" / "type beat" — SoundCloud beat-store spam.
  [/\b(free\s+(?:\w+\s+)*beat|type\s*beat|free\s+beat)\b/i, 'beat-store spam (type beat / FREE BEAT)'],
  // Marker prefixes typical of beat-mill uploads.
  [/(\[FREE\]|\[NO\s*TAGS\]|\[UNTAGGED\])/i, 'beat-store marker prefix'],
  // "Prod by" / "Prod." — beat-store producer credit pattern.
  [/\bprod(?:uced)?(?:\s+by\b|\.)/i, 'producer-credit ("prod by" / "prod.")'],
];

// Garbage artist values — case-insensitive exact match (after trim).
const GARBAGE_ARTIST_NAMES = new Set([
  'unknown', 'various artists', 'va', 'n/a', 'na', 'untitled', 'anonymous',
]);

// Canonicalize CC modifier-slug ordering. The CC modifier set is
// {sa, nc, nd}; canonical ordering is alphabetical (so "by-nc-nd" not
// "by-nd-nc"). Some IA items, ccMixter strings, and uploader-tagged
// licenses arrive with the modifiers in non-canonical order — same
// license, different slug. Without canonicalization, those would fail
// the ACCEPTED_LICENSES set lookup even though they're equivalent.
//
// This function takes a normalized key (the output of computeLicense)
// and reorders the cc-by-* suffix tokens alphabetically. Non-by keys
// (cc0, public-domain, sampling-plus, audius-platform, etc.) pass
// through unchanged.
function canonicalizeKey(key) {
  if (!key) return key;
  const m = key.match(/^cc-by(?:-(.+))?$/);
  if (!m) return key;
  if (!m[1]) return 'cc-by';
  const mods = m[1].split('-').sort();
  return `cc-by-${mods.join('-')}`;
}

// Map raw license strings to a canonical key. Returns null if unrecognized.
//
// Handles (with examples seen in the wild):
//   - jamendo style:    "by", "by-sa", "by-nc-nd"            -> cc-* prefix
//   - ccmixter style:   "Attribution Noncommercial (3.0)"
//   - spec style:       "cc-by", "cc-by-sa", "cc0", "public-domain", "pd"
//   - IA URL form:      "https://creativecommons.org/licenses/by/3.0/"
//   - PD URL form:      "https://creativecommons.org/publicdomain/zero/1.0/"
//   - Free Art License: "http://artlibre.org/licence/lal/en", "fal"
//   - Wikimedia bare:   "PDM-owner", "Public Domain Mark"
//   - Versioned:        "cc-by-3.0", "CC BY-SA 4.0" → strip the version
//   - HTML-wrapped:     "<a ...>https://example/X.txt</a>" → strip then retry
//   - Modifier reorder: "by-nd-nc" → "cc-by-nc-nd" (canonicalize tail)
//
// Returns null for ambiguous inputs ("CC", commons file URLs accidentally
// captured into the license field, GFDL, "Copyrighted free use", etc.).
export function normalizeLicense(raw) {
  return canonicalizeKey(computeLicense(raw));
}

function computeLicense(raw) {
  if (raw == null) return null;
  // Strip HTML tags first — Wikimedia's LicenseShortName sometimes arrives
  // wrapped in <a> from the API's HTML-rendered extmetadata.
  let s = String(raw).replace(/<[^>]+>/g, ' ').trim().toLowerCase();
  if (!s) return null;

  // Strip trailing version slugs/suffixes so cc-by-3.0 → cc-by, etc.
  // Apply this AFTER bucketing into the cc-* family but also as a
  // pre-pass for "cc by-sa 4.0" variants.
  const stripVersion = (t) => t.replace(/[\s-]*\d+(?:\.\d+)?$/, '').trim();

  // ── public domain variants ─────────────────────────────────────
  if (/\bpdm[\s-]?(owner|1\.0)?\b/.test(s)) return 'public-domain';
  if (/\bpublic[\s-]?domain[\s-]?mark\b/.test(s)) return 'public-domain';
  if (/^p(d|ublic[-\s]?domain)$/.test(s) || s.includes('public domain')) return 'public-domain';
  // Bare "cc-publicdomain" / "cc-pd" — produced by some upstream code paths
  // that template "cc-{slug}" without checking for PD-marker slugs.
  if (s === 'cc-publicdomain' || s === 'cc-pd') return 'public-domain';

  // ── Free Art License ──────────────────────────────────────────
  if (/artlibre\.org\/licence\/lal/.test(s)) return 'free-art';
  if (s === 'fal' || /\bfal\b/.test(s) && /licen[cs]e/.test(s)) return 'free-art';
  if (s.includes('free art license')) return 'free-art';

  // ── ccMixter Sampling Plus family ─────────────────────────────
  // The NC variant must be checked first so "Noncommercial Sampling Plus"
  // doesn't match the bare-Sampling-Plus regex below.
  if (/(?:^|\s|-)(?:noncommercial|nc)(?:[-\s])sampling[-\s+]?plus/.test(s)
      || /^(?:cc-)?nc-sampling[-\s+]?plus$/.test(s)
      || s === 'cc-nc-sampling-plus') {
    return 'nc-sampling-plus';
  }
  if (/(?:^|\s|-)sampling[-\s+]?plus(?:\s|$)/.test(s)
      || /^cc[-\s]?sampling[-\s+]?plus$/.test(s)
      || s === 'sampling-plus' || s === 'cc-sampling-plus' || s === 'cc-sampling+') {
    return 'sampling-plus';
  }

  // ── CC URL form ──────────────────────────────────────────────
  // Capture the slug after /licenses/ or /publicdomain/. Treat PD markers
  // explicitly so the URL form doesn't emit "cc-publicdomain" nonsense.
  const urlMatch = s.match(/creativecommons\.org\/(?:licenses|publicdomain)\/([a-z0-9-]+)/);
  if (urlMatch) {
    const slug = urlMatch[1];
    if (slug === 'zero' || slug === 'mark' || slug === 'publicdomain' || slug === 'pd') {
      return 'public-domain';
    }
    return stripVersion(`cc-${slug}`);
  }

  // ── Generic ambiguous / explicit-reject inputs ────────────────
  if (s === 'cc') return null;                              // too ambiguous
  if (/copyrighted free use/.test(s)) return null;          // not permissive enough
  if (/gnu|gfdl|gpl/.test(s)) return null;                  // not in spec
  if (s.startsWith('//commons.wikimedia.org/')) return null;// wiki-file URL leak
  if (s.startsWith('http') && !urlMatch) return null;       // unknown URL

  // ── CC0 variants ─────────────────────────────────────────────
  if (/^cc0\b/.test(s) || s.includes('cc zero') || s.includes('cc-zero')) return 'cc0';

  // ── ccmixter raw "Attribution Noncommercial Share-Alike (3.0)" ──
  if (/^attribution(?:\s+|$)/.test(s)) {
    let key = 'cc-by';
    if (/share[-\s]?alike/.test(s))   key += '-sa';
    if (/no[-\s]?derivat/.test(s))    key += '-nd';
    if (/non[-\s]?commercial/.test(s)) {
      key = key.replace(/^cc-by/, 'cc-by-nc');
    }
    return key;
  }

  // ── "CC BY-SA 4.0" / "CC BY 3.0" / etc. ──────────────────────
  const ccLooseMatch = s.match(/^cc\s+(by(?:[-\s][a-z]+)*)/);
  if (ccLooseMatch) {
    const tail = ccLooseMatch[1].replace(/\s+/g, '-');
    return stripVersion(`cc-${tail}`);
  }

  // ── Bare jamendo-style "by", "by-sa", "by-nc-nd", … ─────────
  if (/^by(?:[-\s][a-z-]+)*$/.test(s)) {
    const suffix = s.slice(2).replace(/^[-\s]+/, '').replace(/\s+/g, '-');
    return stripVersion(suffix ? `cc-by-${suffix}` : 'cc-by');
  }

  // ── spec style: "cc-by", "cc-by-sa-3.0", etc. ───────────────
  if (/^cc-/.test(s)) return stripVersion(s.replace(/\s+/g, ''));

  // ── Phase 17 Audius / taper-policy buckets ─────────────────
  if (s === 'audius-platform') return 'audius-platform';
  if (s === 'taper-policy') return 'taper-policy';

  return null;
}

// Returns { ok: boolean, reason: string }. reason is null when ok=true.
export function passesQualityGate(track) {
  const reason = checkReason(track);
  return reason ? { ok: false, reason } : { ok: true, reason: null };
}

function checkReason(t) {
  // 2. duration bounds
  const dur = t.duration_seconds;
  if (typeof dur === 'number') {
    if (dur < MIN_DURATION_S) return `duration < ${MIN_DURATION_S}s`;
    if (dur > MAX_DURATION_S) return `duration > ${MAX_DURATION_S / 60}min`;
  }

  // 4. title spam
  const title = String(t.title || '').trim();
  if (!title) return 'empty title';
  // All-caps with multiple bracketed tags. Loose interpretation: at least
  // one alpha char, all letters uppercase, and >=2 bracket pairs.
  const bracketPairs = (title.match(/[\[\(\{]/g) || []).length;
  const hasAlpha = /[A-Za-z]/.test(title);
  if (hasAlpha && title === title.toUpperCase() && bracketPairs >= 2) {
    return 'all-caps with multiple bracketed tags';
  }
  for (const [re, why] of TITLE_SPAM_PATTERNS) {
    if (re.test(title)) return `spam title: ${why}`;
  }

  // Repeated artist name in title (3+ times).
  const artist = String(t.artist_name || '').trim();
  if (artist.length >= 2) {
    const re = new RegExp(escapeRegExp(artist), 'gi');
    const hits = title.match(re);
    if (hits && hits.length >= 3) return 'artist name repeated 3+ times in title';
  }

  // 5. artist sanity
  if (!artist) return 'empty artist_name';
  const al = artist.toLowerCase();
  if (GARBAGE_ARTIST_NAMES.has(al)) return `placeholder artist: "${artist}"`;
  // Just a number, just punctuation, or 1 char — no artist signal.
  if (!/[a-z]/i.test(artist)) return 'artist has no letters';

  // 6. license must be in the accepted set
  const lic = normalizeLicense(t.license);
  if (!lic) return `license unrecognized: ${JSON.stringify(t.license)}`;
  if (!ACCEPTED_LICENSES.has(lic)) return `license not permissive: ${lic}`;
  // Surface the normalized license back to the caller so the upsert stores
  // a canonical value — we mutate here on purpose, called right before insert.
  t.license = lic;

  return null;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

let logFd = null;
let logFailedOnce = false;

// Append-only log of every rejection; used to tune the gates after each run.
// Format: ISO_TIMESTAMP | source | external_id | reason | title (60 chars)
export function logRejection({ source, external_id, reason, title }) {
  const line = [
    new Date().toISOString(),
    source || '?',
    external_id || '?',
    reason || '?',
    String(title || '').slice(0, 60).replace(/[\n\r|]/g, ' '),
  ].join(' | ') + '\n';

  if (logFd === null) {
    try {
      fs.mkdirSync(path.dirname(REJECTION_LOG), { recursive: true });
      logFd = fs.openSync(REJECTION_LOG, 'a');
    } catch (err) {
      if (!logFailedOnce) {
        console.error('[quality-gate] cannot open rejection log:', err.message);
        logFailedOnce = true;
      }
      logFd = -1;
    }
  }
  if (logFd > 0) {
    try { fs.writeSync(logFd, line); } catch { /* swallow */ }
  }
}
