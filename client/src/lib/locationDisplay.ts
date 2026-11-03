// Display-layer normalizers for artist locations.
//
// The DB intentionally stores raw values as ingested:
//   - Jamendo: ISO-2 country codes ("FR", "DE")
//   - Audius free-text: country names ("France", "Germany") OR US state codes
//     ("CA", "TX", "NY") because "Brooklyn, NY" parsed to country="NY"
// We don't normalize at the data layer (per the LumpyLP rule: keep raw,
// normalize at display). These helpers fix all three quirks at render time:
//   1. US state codes display as "<State>, USA" with code='US'
//   2. ISO-2 codes display as the full country name (FR → France)
//   3. Free-text names that match a known country dedupe with their ISO-2
//      counterpart (groupByCountry + REVERSE_COUNTRY_NAMES)

// 50 states + DC + territories with US Postal Service codes.
export const US_STATES: Readonly<Record<string, string>> = Object.freeze({
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas',
  CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware',
  FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho',
  IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas',
  KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi',
  MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada',
  NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
  NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma',
  OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina',
  SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah',
  VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia',
  WI: 'Wisconsin', WY: 'Wyoming',
  DC: 'District of Columbia', PR: 'Puerto Rico', VI: 'U.S. Virgin Islands',
  GU: 'Guam', AS: 'American Samoa', MP: 'Northern Mariana Islands',
});

// Top-50 ISO-2 country codes by population + smaller European ones common in
// our catalog. Inverted from server/lib/countries.js iso3→iso2 + name lookup.
export const COUNTRY_NAMES: Readonly<Record<string, string>> = Object.freeze({
  AR: 'Argentina', AT: 'Austria', AU: 'Australia',
  BE: 'Belgium', BG: 'Bulgaria', BR: 'Brazil', BY: 'Belarus',
  CA: 'Canada', CH: 'Switzerland', CL: 'Chile', CN: 'China',
  CO: 'Colombia', CR: 'Costa Rica', CU: 'Cuba', CZ: 'Czech Republic',
  DE: 'Germany', DK: 'Denmark', DO: 'Dominican Republic',
  EC: 'Ecuador', EE: 'Estonia', EG: 'Egypt', ES: 'Spain', ET: 'Ethiopia',
  FI: 'Finland', FR: 'France',
  GB: 'United Kingdom', GE: 'Georgia', GR: 'Greece', GT: 'Guatemala',
  HK: 'Hong Kong', HR: 'Croatia', HU: 'Hungary',
  ID: 'Indonesia', IE: 'Ireland', IL: 'Israel', IN: 'India',
  IR: 'Iran', IS: 'Iceland', IT: 'Italy',
  JP: 'Japan',
  KE: 'Kenya', KR: 'South Korea', KZ: 'Kazakhstan',
  LT: 'Lithuania', LU: 'Luxembourg', LV: 'Latvia',
  MA: 'Morocco', MD: 'Moldova', MX: 'Mexico', MY: 'Malaysia',
  NG: 'Nigeria', NL: 'Netherlands', NO: 'Norway', NZ: 'New Zealand',
  PE: 'Peru', PH: 'Philippines', PK: 'Pakistan', PL: 'Poland', PT: 'Portugal',
  RO: 'Romania', RS: 'Serbia', RU: 'Russia',
  SA: 'Saudi Arabia', SE: 'Sweden', SG: 'Singapore', SI: 'Slovenia',
  SK: 'Slovakia',
  TH: 'Thailand', TR: 'Turkey', TW: 'Taiwan',
  UA: 'Ukraine', US: 'United States', UY: 'Uruguay', UZ: 'Uzbekistan',
  VE: 'Venezuela', VN: 'Vietnam',
  ZA: 'South Africa',
});

// Reverse US state map: full state name → state code. Used to recognize
// Audius free-text country values like "Texas" (parsed from "Houston, Texas")
// as US states, not as unknown countries.
const US_STATE_NAMES_REVERSE: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(Object.entries(US_STATES).map(([code, name]) => [name.toLowerCase(), code]))
);

// Reverse map (lowercased name → ISO-2). Includes common synonyms users type:
// "USA" → US, "UK" → GB, "England" → GB, "Czechia" → CZ, etc.
export const REVERSE_COUNTRY_NAMES: Readonly<Record<string, string>> = Object.freeze({
  ...Object.fromEntries(
    Object.entries(COUNTRY_NAMES).map(([code, name]) => [name.toLowerCase(), code])
  ),
  // Synonyms / common alt-names typed by humans
  usa: 'US', 'u.s.a.': 'US', 'u.s.': 'US', america: 'US',
  uk: 'GB', 'u.k.': 'GB', england: 'GB', scotland: 'GB', wales: 'GB',
  britain: 'GB', 'great britain': 'GB',
  czechia: 'CZ',
  russia: 'RU',
  korea: 'KR', 'south korea': 'KR',
  vietnam: 'VN', 'viet nam': 'VN',
  taiwan: 'TW',
  'hong kong': 'HK',
  'south africa': 'ZA',
  'new zealand': 'NZ',
});

/** Title-case a city name. Preserves non-Latin scripts (Cyrillic, etc.) by
 *  word-boundary splitting on whitespace + apostrophes; words inside still
 *  lowercase except first letter. "MILANO" → "Milano", "moscow" → "Moscow",
 *  "new york" → "New York", "Москва" → "Москва" (already correct). */
export function displayCity(rawCity: string | null | undefined): string | null {
  if (!rawCity) return null;
  const s = String(rawCity).trim();
  if (!s) return null;
  // Capitalize each whitespace-delimited word's first letter; leave rest
  // lowercase. Handles ALL-CAPS and lowercase inputs the same way.
  return s
    .split(/(\s+)/)
    .map((w) => {
      if (/^\s+$/.test(w)) return w;
      // Don't touch a word that has no Latin letters (Cyrillic/Greek/CJK).
      if (!/[a-zA-Z]/.test(w)) return w;
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    })
    .join('');
}

// Conservative continental-US bounding box. Tighter than the actual border
// to avoid mis-tagging Canadian cities that overlap longitudes with the US
// (Toronto 43.6°N, Montréal 45.5°N). Loses a sliver of WA/MN/upstate NY
// but those don't have CA/DE/IL/GA-style code collisions in practice — the
// only states with ambiguous 2-char codes (DE, GA, IN, MA, IL, CA, MD)
// all sit south of 42.5°N. Used to disambiguate 2-char country/state codes.
function isInContinentalUS(lat?: number, lng?: number): boolean {
  if (typeof lat !== 'number' || typeof lng !== 'number') return false;
  return lat >= 24 && lat <= 42.5 && lng >= -125 && lng <= -67;
}

/** Smart-display country.
 *  - 2-char US state code (CA, TX, NY) → { code: 'US', name: 'California, USA' }
 *  - ISO-2 country code (FR, JP)       → { code: 'FR', name: 'France' }
 *  - Free-text country name ("France") → { code: 'FR', name: 'France' } via reverse lookup
 *  - Anything else                     → { code: '?', name: raw }
 *
 *  When a 2-char code overlaps both the US state list AND the ISO-2 country
 *  list, we disambiguate with (in order of precedence):
 *    1. lat/lng — if the artist is geographically in the continental US,
 *       prefer US state interpretation (even if Audius source).
 *    2. locationSource — Jamendo/self default to ISO-2 country; Audius
 *       defaults to US state (Audius free-text "City, ST" pattern).
 */
export function displayCountry(
  rawCountry: string | null | undefined,
  locationSource?: string | null,
  opts?: { lat?: number; lng?: number }
): { code: string; name: string } | null {
  if (!rawCountry) return null;
  const raw = String(rawCountry).trim();
  if (!raw) return null;

  if (raw.length === 2) {
    const upper = raw.toUpperCase();
    const isStateCode = !!US_STATES[upper];
    const isCountryCode = !!COUNTRY_NAMES[upper];

    if (isStateCode && isCountryCode) {
      // Geography wins when known. (Berlin at 52.5,13.4 is not in the US.
      // Los Angeles at 34,-118 is. Toronto at 43.6,-79.4 is not.)
      const inUS = isInContinentalUS(opts?.lat, opts?.lng);
      const isUSGeography = inUS;
      const isOutsideUSGeography =
        typeof opts?.lat === 'number' && typeof opts?.lng === 'number' && !inUS;
      if (isUSGeography) {
        return { code: 'US', name: `${US_STATES[upper]}, USA` };
      }
      if (isOutsideUSGeography) {
        return { code: upper, name: COUNTRY_NAMES[upper] };
      }
      // No coords — fall back to source bias.
      if (locationSource === 'audius') {
        return { code: 'US', name: `${US_STATES[upper]}, USA` };
      }
      return { code: upper, name: COUNTRY_NAMES[upper] };
    }
    if (isStateCode) {
      return { code: 'US', name: `${US_STATES[upper]}, USA` };
    }
    if (isCountryCode) {
      return { code: upper, name: COUNTRY_NAMES[upper] };
    }
  }

  // Full US state name (e.g. "Texas" from Audius free-text "Houston, Texas")
  const lower = raw.toLowerCase();
  if (US_STATE_NAMES_REVERSE[lower]) {
    const stateCode = US_STATE_NAMES_REVERSE[lower];
    return { code: 'US', name: `${US_STATES[stateCode]}, USA` };
  }

  // Free-text country name lookup
  if (REVERSE_COUNTRY_NAMES[lower]) {
    const code = REVERSE_COUNTRY_NAMES[lower];
    return { code, name: COUNTRY_NAMES[code] || raw };
  }

  // Unknown — show raw
  return { code: '?', name: raw };
}

// Type used by groupByCountry — keeps it loose so any artist-shaped row works.
type ArtistLike = {
  country: string | null;
  location_source?: string | null;
  [k: string]: unknown;
};

/** Group artists by canonical country code. Artists with country='FR' and
 *  artists with country='France' end up in the same bucket keyed 'FR'. Any
 *  US state codes (TX, NY) collapse into 'US'. Unknown countries grouped
 *  under '?'. Artists with no country appear under '_no_country'. */
export function groupByCountry<T extends ArtistLike>(
  artists: T[]
): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const a of artists) {
    let key = '_no_country';
    if (a.country) {
      const d = displayCountry(a.country, a.location_source);
      key = d?.code || '?';
    }
    if (!out.has(key)) out.set(key, []);
    out.get(key)!.push(a);
  }
  return out;
}

// === Unit-test cases for hand-verification ===
// displayCity:
//   "moscow"      → "Moscow"
//   "lyon"        → "Lyon"
//   "MILANO"      → "Milano"
//   "Mexico City" → "Mexico City"
//   "new york"    → "New York"
//   "los angeles" → "Los Angeles"
//   "Москва"      → "Москва"  (Cyrillic untouched)
//   "São Paulo"   → "São Paulo"
//   ""            → null
//   null          → null
//
// displayCountry:
//   "FR"      → { code: 'FR', name: 'France' }
//   "France"  → { code: 'FR', name: 'France' }     ← dedup with FR
//   "TX"      → { code: 'US', name: 'Texas, USA' }
//   "NY"      → { code: 'US', name: 'New York, USA' }
//   "DE"      → { code: 'DE', name: 'Germany' }
//   "Germany" → { code: 'DE', name: 'Germany' }    ← dedup with DE
//   "USA"     → { code: 'US', name: 'United States' }  ← synonym
//   "UK"      → { code: 'GB', name: 'United Kingdom' } ← synonym
//   "England" → { code: 'GB', name: 'United Kingdom' } ← synonym
//   "ANT"     → { code: '?', name: 'ANT' }         ← Netherlands Antilles, dissolved
//   "bulgaria"→ { code: 'BG', name: 'Bulgaria' }   ← case-insensitive
//   ""        → null
//   null      → null
//
// groupByCountry:
//   [{country:'FR'},{country:'France'},{country:'TX'},{country:'NY'},{country:null}]
//   → Map { 'FR' → 2, 'US' → 2, '_no_country' → 1 }
