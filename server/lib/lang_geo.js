// Shared language → country/region lookup. Used by archive_pd78s and
// will be used by every subsequent resolver that needs per-track origin
// from an IA `language` tag (or equivalent).
//
// Per user spec 2026-05-09:
//   Italian → Italy, German → Germany, French → France, Russian → Russia,
//   Spanish → Spain (default; Latin America override only via explicit
//   metadata), Yiddish → no country (diaspora — region only),
//   Polish → Poland, Swedish → Sweden, Danish → Denmark, etc.
//   English language with no country signal → null country.
//
// IA's language field uses a mix of ISO-639-3 codes ('ita', 'deu', 'fre')
// and English names ('Italian', 'German', 'French'). lookupGeoForLang()
// normalizes both. If the language doesn't map, returns
// { country: null, region: null }.

// Canonical map. Keys are normalized: lowercased, common ISO codes too.
const LANG_TO_GEO = {
  // Single-country (or default-country per user spec) languages
  italian:    { country: 'IT', region: 'Southern Europe' },
  ita:        { country: 'IT', region: 'Southern Europe' },
  it:         { country: 'IT', region: 'Southern Europe' },
  neapolitan: { country: 'IT', region: 'Southern Europe' },
  sicilian:   { country: 'IT', region: 'Southern Europe' },

  german:     { country: 'DE', region: 'Western Europe' },
  deutsch:    { country: 'DE', region: 'Western Europe' },
  ger:        { country: 'DE', region: 'Western Europe' },
  deu:        { country: 'DE', region: 'Western Europe' },
  de:         { country: 'DE', region: 'Western Europe' },

  french:     { country: 'FR', region: 'Western Europe' },
  francais:   { country: 'FR', region: 'Western Europe' },
  fre:        { country: 'FR', region: 'Western Europe' },
  fra:        { country: 'FR', region: 'Western Europe' },
  fr:         { country: 'FR', region: 'Western Europe' },

  spanish:    { country: 'ES', region: 'Southern Europe' },
  espanol:    { country: 'ES', region: 'Southern Europe' },
  spa:        { country: 'ES', region: 'Southern Europe' },
  esp:        { country: 'ES', region: 'Southern Europe' },
  es:         { country: 'ES', region: 'Southern Europe' },
  catalan:    { country: 'ES', region: 'Southern Europe' },
  galician:   { country: 'ES', region: 'Southern Europe' },
  basque:     { country: 'ES', region: 'Southern Europe' },

  russian:    { country: 'RU', region: 'Eastern Europe' },
  rus:        { country: 'RU', region: 'Eastern Europe' },
  ru:         { country: 'RU', region: 'Eastern Europe' },

  ukrainian:  { country: 'UA', region: 'Eastern Europe' },
  ukr:        { country: 'UA', region: 'Eastern Europe' },
  uk:         { country: 'UA', region: 'Eastern Europe' },

  polish:     { country: 'PL', region: 'Eastern Europe' },
  pol:        { country: 'PL', region: 'Eastern Europe' },
  pl:         { country: 'PL', region: 'Eastern Europe' },

  czech:      { country: 'CZ', region: 'Eastern Europe' },
  cze:        { country: 'CZ', region: 'Eastern Europe' },
  ces:        { country: 'CZ', region: 'Eastern Europe' },
  cs:         { country: 'CZ', region: 'Eastern Europe' },

  slovak:     { country: 'SK', region: 'Eastern Europe' },
  slo:        { country: 'SK', region: 'Eastern Europe' },
  slk:        { country: 'SK', region: 'Eastern Europe' },

  hungarian:  { country: 'HU', region: 'Eastern Europe' },
  magyar:     { country: 'HU', region: 'Eastern Europe' },
  hun:        { country: 'HU', region: 'Eastern Europe' },
  hu:         { country: 'HU', region: 'Eastern Europe' },

  romanian:   { country: 'RO', region: 'Eastern Europe' },
  ron:        { country: 'RO', region: 'Eastern Europe' },
  rum:        { country: 'RO', region: 'Eastern Europe' },
  ro:         { country: 'RO', region: 'Eastern Europe' },

  bulgarian:  { country: 'BG', region: 'Eastern Europe' },
  bul:        { country: 'BG', region: 'Eastern Europe' },
  bg:         { country: 'BG', region: 'Eastern Europe' },

  serbian:    { country: 'RS', region: 'Eastern Europe' },
  croatian:   { country: 'HR', region: 'Eastern Europe' },

  greek:      { country: 'GR', region: 'Southern Europe' },
  ell:        { country: 'GR', region: 'Southern Europe' },
  gre:        { country: 'GR', region: 'Southern Europe' },
  el:         { country: 'GR', region: 'Southern Europe' },

  turkish:    { country: 'TR', region: 'MENA' },
  tur:        { country: 'TR', region: 'MENA' },
  tr:         { country: 'TR', region: 'MENA' },

  hebrew:     { country: 'IL', region: 'MENA' },
  heb:        { country: 'IL', region: 'MENA' },
  he:         { country: 'IL', region: 'MENA' },

  persian:    { country: 'IR', region: 'MENA' },
  farsi:      { country: 'IR', region: 'MENA' },
  per:        { country: 'IR', region: 'MENA' },
  fas:        { country: 'IR', region: 'MENA' },
  fa:         { country: 'IR', region: 'MENA' },

  // Multi-country languages — region only, country null
  arabic:     { country: null, region: 'MENA' },
  ara:        { country: null, region: 'MENA' },
  ar:         { country: null, region: 'MENA' },

  yiddish:    { country: null, region: 'Eastern Europe' },  // diaspora
  yid:        { country: null, region: 'Eastern Europe' },
  yi:         { country: null, region: 'Eastern Europe' },

  // Portuguese: PT vs BR ambiguous from language alone — null/null
  // unless title-mining or metadata resolves. Resolvers can override
  // (e.g. a flamenco/samba slice maps to BR/PT explicitly).
  portuguese: { country: null, region: null },
  por:        { country: null, region: null },
  pt:         { country: null, region: null },

  // Nordic — single-country
  swedish:    { country: 'SE', region: 'Nordic' },
  swe:        { country: 'SE', region: 'Nordic' },
  sv:         { country: 'SE', region: 'Nordic' },

  norwegian:  { country: 'NO', region: 'Nordic' },
  nor:        { country: 'NO', region: 'Nordic' },
  no:         { country: 'NO', region: 'Nordic' },

  danish:     { country: 'DK', region: 'Nordic' },
  dan:        { country: 'DK', region: 'Nordic' },
  da:         { country: 'DK', region: 'Nordic' },

  finnish:    { country: 'FI', region: 'Nordic' },
  fin:        { country: 'FI', region: 'Nordic' },
  fi:         { country: 'FI', region: 'Nordic' },

  icelandic:  { country: 'IS', region: 'Nordic' },
  isl:        { country: 'IS', region: 'Nordic' },
  is:         { country: 'IS', region: 'Nordic' },

  dutch:      { country: 'NL', region: 'Western Europe' },
  nederlands: { country: 'NL', region: 'Western Europe' },
  dut:        { country: 'NL', region: 'Western Europe' },
  nld:        { country: 'NL', region: 'Western Europe' },
  nl:         { country: 'NL', region: 'Western Europe' },

  // South Asia
  hindi:      { country: 'IN', region: 'South Asia' },
  hin:        { country: 'IN', region: 'South Asia' },
  hi:         { country: 'IN', region: 'South Asia' },
  tamil:      { country: 'IN', region: 'South Asia' },  // primarily IN; LK/SG also
  tam:        { country: 'IN', region: 'South Asia' },
  ta:         { country: 'IN', region: 'South Asia' },
  bengali:    { country: null, region: 'South Asia' },  // IN/BD ambiguous
  ben:        { country: null, region: 'South Asia' },
  bn:         { country: null, region: 'South Asia' },
  punjabi:    { country: null, region: 'South Asia' },  // IN/PK ambiguous
  pan:        { country: null, region: 'South Asia' },
  urdu:       { country: 'PK', region: 'South Asia' },
  urd:        { country: 'PK', region: 'South Asia' },
  ur:         { country: 'PK', region: 'South Asia' },

  // East Asia
  japanese:   { country: 'JP', region: 'East Asia' },
  jpn:        { country: 'JP', region: 'East Asia' },
  ja:         { country: 'JP', region: 'East Asia' },
  korean:     { country: 'KR', region: 'East Asia' },
  kor:        { country: 'KR', region: 'East Asia' },
  ko:         { country: 'KR', region: 'East Asia' },
  chinese:    { country: 'CN', region: 'East Asia' },
  mandarin:   { country: 'CN', region: 'East Asia' },
  cantonese:  { country: 'CN', region: 'East Asia' },  // simplification; HK also
  zho:        { country: 'CN', region: 'East Asia' },
  chi:        { country: 'CN', region: 'East Asia' },
  zh:         { country: 'CN', region: 'East Asia' },

  // SE Asia
  vietnamese: { country: 'VN', region: 'SE Asia' },
  vie:        { country: 'VN', region: 'SE Asia' },
  vi:         { country: 'VN', region: 'SE Asia' },
  thai:       { country: 'TH', region: 'SE Asia' },
  tha:        { country: 'TH', region: 'SE Asia' },
  th:         { country: 'TH', region: 'SE Asia' },
  indonesian: { country: 'ID', region: 'SE Asia' },
  ind:        { country: 'ID', region: 'SE Asia' },
  id:         { country: 'ID', region: 'SE Asia' },
  tagalog:    { country: 'PH', region: 'SE Asia' },
  tgl:        { country: 'PH', region: 'SE Asia' },
  tl:         { country: 'PH', region: 'SE Asia' },
  malay:      { country: 'MY', region: 'SE Asia' },
  mal:        { country: 'MY', region: 'SE Asia' },
  ms:         { country: 'MY', region: 'SE Asia' },

  // Sub-Saharan Africa
  swahili:    { country: null, region: 'East Africa' },  // KE/TZ/UG/etc.
  swa:        { country: null, region: 'East Africa' },
  sw:         { country: null, region: 'East Africa' },
  yoruba:     { country: 'NG', region: 'West Africa' },
  yor:        { country: 'NG', region: 'West Africa' },
  yo:         { country: 'NG', region: 'West Africa' },
  zulu:       { country: 'ZA', region: 'Southern Africa' },
  zul:        { country: 'ZA', region: 'Southern Africa' },
  zu:         { country: 'ZA', region: 'Southern Africa' },
  amharic:    { country: 'ET', region: 'East Africa' },
  amh:        { country: 'ET', region: 'East Africa' },
  am:         { country: 'ET', region: 'East Africa' },
  hausa:      { country: 'NG', region: 'West Africa' },
  hau:        { country: 'NG', region: 'West Africa' },
  ha:         { country: 'NG', region: 'West Africa' },

  // English with no country signal: null/null per user spec
  english:    { country: null, region: null },
  eng:        { country: null, region: null },
  en:         { country: null, region: null },
};

// Title/subject substring match for country-mention secondary signal.
// Applied AFTER language map fails. Only triggers on explicit mentions
// in lowercase wordlist; conservative to avoid false positives.
const TITLE_GEO_HINTS = [
  // Italy
  { match: /\b(itali[ay]?n?|napoli|napoletan|sicili[ay]?n?|verdi|puccini|rossini|donizetti|bellini)\b/i,
    country: 'IT', region: 'Southern Europe' },
  // Germany
  { match: /\b(german[ay]?|deutsch|berlin|münchen|hamburg|wagner|tannh|lohengrin|schubert|brahms|beethoven|bach)\b/i,
    country: 'DE', region: 'Western Europe' },
  // France
  { match: /\b(french|france|française|paris|debussy|bizet|gounod|massenet|fauré|ravel|carmen|faust)\b/i,
    country: 'FR', region: 'Western Europe' },
  // Spain
  { match: /\b(spanish|españa|sevill[ae]|madrid|barcelona|granada|de falla|albéniz|granados)\b/i,
    country: 'ES', region: 'Southern Europe' },
  // Russia
  { match: /\b(russian|russia|moscow|moskva|leningrad|tchaikov|rachmaninoff|stravinsky|rimsky|borodin|mussorgsky)\b/i,
    country: 'RU', region: 'Eastern Europe' },
  // Greece
  { match: /\b(greek|greece|hellenic|athens)\b/i,
    country: 'GR', region: 'Southern Europe' },
  // Turkey
  { match: /\b(turkish|turkey|ottoman|istanbul)\b/i,
    country: 'TR', region: 'MENA' },
  // Poland
  { match: /\b(polish|poland|chopin|paderewski|warsaw)\b/i,
    country: 'PL', region: 'Eastern Europe' },
  // Hungary
  { match: /\b(hungarian|hungary|budapest|bartók|liszt|kodály)\b/i,
    country: 'HU', region: 'Eastern Europe' },
  // Czech
  { match: /\b(czech|bohemia|prague|dvořák|smetana)\b/i,
    country: 'CZ', region: 'Eastern Europe' },
  // Yiddish — diaspora, region only
  { match: /\b(yiddish|klezmer)\b/i, country: null, region: 'Eastern Europe' },
  // Brazil (Lusophone)
  { match: /\b(brazil|brasil|samba|bossa nova|carioca)\b/i,
    country: 'BR', region: 'Latin America' },
  // Portugal
  { match: /\b(portuguese|portugal|fado|lisbon)\b/i,
    country: 'PT', region: 'Southern Europe' },
  // Mexico
  { match: /\b(mexican|mexico|méxico|mariachi|ranchera)\b/i,
    country: 'MX', region: 'Latin America' },
  // Argentina
  { match: /\b(argentin[oa]|tango|buenos aires)\b/i,
    country: 'AR', region: 'Latin America' },
  // India / Hindustani
  { match: /\b(indian|india|hindustani|carnatic|raga|bhajan|ghazal)\b/i,
    country: 'IN', region: 'South Asia' },
  // Japan
  { match: /\b(japanese|japan|nihon|gagaku|shakuhachi|enka)\b/i,
    country: 'JP', region: 'East Asia' },
  // China
  { match: /\b(chinese|china|peking opera|guzheng|guqin)\b/i,
    country: 'CN', region: 'East Asia' },
  // Hawaii
  { match: /\b(hawaiian|hawaii)\b/i,
    country: 'US', region: 'Pacific' },
  // Ireland (Celtic / trad)
  { match: /\b(irish|ireland|celtic|jig|reel)\b/i,
    country: 'IE', region: 'Northern Europe' },
  // Scotland
  { match: /\b(scottish|scotland)\b/i,
    country: 'GB', region: 'Northern Europe' },
];

function normalizeKey(s) {
  if (!s) return null;
  return String(s).toLowerCase().trim();
}

// Look up geo for a single language tag string. Returns { country, region }
// where either may be null. Returns { country: null, region: null } if not
// recognized.
export function lookupGeoForLang(lang) {
  const key = normalizeKey(lang);
  if (!key) return { country: null, region: null };
  return LANG_TO_GEO[key] || { country: null, region: null };
}

// Try a list of language tags (e.g. IA returns array sometimes); take the
// first that maps to a non-null country, else first non-null region.
export function lookupGeoForLangs(langs) {
  const arr = Array.isArray(langs) ? langs : (langs ? [langs] : []);
  let firstRegion = null;
  for (const l of arr) {
    const g = lookupGeoForLang(l);
    if (g.country) return g;
    if (g.region && !firstRegion) firstRegion = g;
  }
  return firstRegion || { country: null, region: null };
}

// Secondary signal: scan a free-text haystack (title + subject + creator)
// for explicit country/region mentions. Only triggers when language map
// returns null country.
export function inferGeoFromText(text) {
  if (!text) return { country: null, region: null };
  for (const hint of TITLE_GEO_HINTS) {
    if (hint.match.test(text)) {
      return { country: hint.country, region: hint.region };
    }
  }
  return { country: null, region: null };
}

// Combined: try language tag(s) first, fall back to title text.
export function deriveTrackGeo({ language, fallbackText }) {
  const fromLang = lookupGeoForLangs(language);
  // If language map gave us a country, that's authoritative — return it.
  if (fromLang.country) return fromLang;
  // If language gave region but no country, try to upgrade with title text.
  const fromText = inferGeoFromText(fallbackText);
  if (fromText.country) {
    // Title gave us a country; prefer it but keep language's region if title
    // has no region (shouldn't happen with current TITLE_GEO_HINTS — every
    // entry sets region).
    return fromText;
  }
  // Neither gave a country. Prefer whichever has a region.
  return fromLang.region ? fromLang : fromText;
}
