// Liberal junk filter for free-text location strings (mostly Audius user
// profiles). The probe found ~97% of non-empty Audius locations are clean
// — this is meant to reject obvious junk while preserving anything a human
// might have typed in good faith ("manchester, Britain (UK)" should pass).
//
// If a string fails this filter, the backfill should still preserve the
// original in artists.location_raw so we can revisit later.

// Junk patterns. Each is a RegExp that, if it matches the trimmed string,
// triggers rejection. Exported as JUNK_PATTERNS so the backfill can log
// which entries got filtered for manual review.
export const JUNK_PATTERNS = Object.freeze([
  // "the world" / "everywhere" / "nowhere" / "anywhere" / "somewhere"
  /^(the\s+)?world$/i,
  /^worldwide$/i,
  /^global$/i,
  /^everywhere$/i,
  /^anywhere$/i,
  /^somewhere$/i,
  /^nowhere(\s+\w+)?$/i,        // "nowhere", "nowhere ny" — the latter slipped past pure-junk in the probe
  /^earth$/i,
  /^the\s+universe$/i,

  // "in your X" / "in the X" / "your X" — romantic / abstract junk
  /^in\s+your\b/i,
  /^in\s+the\b/i,
  /^your\s+(heart|soul|head|mind|speakers|ears|dreams)$/i,

  // Outer space variants
  /^(outer\s+)?space$/i,
  /^(the\s+)?moon$/i,
  /^mars$/i,
  /^cyberspace$/i,
  /^the\s+matrix$/i,

  // "online" / network-only — not a real place
  /^(the\s+)?internet$/i,
  /^(the\s+)?web$/i,
  /^online$/i,
  /^cloud$/i,

  // Empty placeholders
  /^n\/?a$/i,
  /^none$/i,
  /^null$/i,
  /^undefined$/i,
  /^unknown$/i,
  /^\?+$/,
  /^-+$/,
  /^\.+$/,

  // Single-character box-drawing / decorative noise (saw "╲" in the probe)
  /^[╲╱║▓░╳▣◯●○◆◇■□]+$/,
]);

// Single-emoji-only check (BMP supplementary range covering most pictographic emoji).
// Treat any string that's purely emoji+whitespace as junk.
const EMOJI_ONLY_RE = /^(\s|[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F0FF}\u{1F100}-\u{1F1FF}\u{2700}-\u{27FF}])+$/u;

/**
 * Returns true if the string is plausibly a real-world location worth
 * sending to the geocoder. Liberal: only rejects clear junk.
 */
export function isPlausibleLocation(raw) {
  if (typeof raw !== 'string') return false;
  const s = raw.trim();
  if (s.length < 2 || s.length > 100) return false;
  if (!/[a-zA-Z]/.test(s)) return false;     // must contain at least one Latin letter
  if (EMOJI_ONLY_RE.test(s)) return false;
  for (const re of JUNK_PATTERNS) {
    if (re.test(s)) return false;
  }
  return true;
}
