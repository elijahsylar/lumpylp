/**
 * Display-time HTML entity decoding.
 *
 * Some ingesters store artist names and titles with HTML entities still
 * encoded — 51 rows in `artists.name` hold strings like
 * "AJC &amp; The Envelope Pushers", which render literally as "&amp;".
 *
 * The real fix is to decode at ingest time and backfill the affected rows;
 * until that happens this keeps the UI honest. It is display-only — nothing
 * here writes back to the database.
 *
 * Deliberately a small fixed table rather than an innerHTML round-trip:
 * assigning untrusted strings to innerHTML to decode them is a well-known
 * way to introduce XSS, and React already escapes what we return.
 */
const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&#39;': "'",
  '&#039;': "'",
  '&nbsp;': ' ',
  '&mdash;': '—',
  '&ndash;': '–',
  '&hellip;': '…',
};

const NAMED = /&(?:amp|lt|gt|quot|apos|nbsp|mdash|ndash|hellip|#0?39);/g;
const NUMERIC = /&#(\d+);/g;
const HEX = /&#x([0-9a-fA-F]+);/g;

/**
 * Decode HTML entities for display. Runs twice so double-encoded values
 * ("&amp;amp;" — which the archive.org scrapers do produce) collapse all
 * the way down. Returns the input unchanged when there is nothing to do,
 * which is the overwhelmingly common case.
 */
export function decodeEntities(input: string | null | undefined): string {
  if (!input) return '';
  let out = String(input);
  if (!out.includes('&')) return out;

  for (let pass = 0; pass < 2 && out.includes('&'); pass++) {
    const before = out;
    out = out
      .replace(NAMED, (m) => ENTITIES[m] ?? ENTITIES[m.toLowerCase()] ?? m)
      .replace(NUMERIC, (m, code) => {
        const n = Number(code);
        return n >= 32 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
      })
      .replace(HEX, (m, code) => {
        const n = parseInt(code, 16);
        return n >= 32 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
      });
    if (out === before) break;
  }
  return out;
}
