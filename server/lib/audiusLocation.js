// Audius free-text user.location parser. Used by both the indexer (capture
// at ingest) and backfill-audius-locations.js (legacy backfill of rows
// pre-Phase-17.8 where ingest didn't capture location).
//
// Heuristic:
//   - comma → last segment is country (or US state — both work for display)
//   - no comma + matches a known country name → country only
//   - else → city only
//
// Conservative: when in doubt we put it in city, never country.

const COUNTRY_NAMES = new Set([
  'usa', 'united states', 'us', 'uk', 'united kingdom', 'england',
  'scotland', 'wales', 'ireland', 'germany', 'france', 'spain', 'italy',
  'portugal', 'netherlands', 'belgium', 'sweden', 'norway', 'denmark',
  'finland', 'iceland', 'poland', 'austria', 'switzerland', 'greece',
  'czech republic', 'czechia', 'romania', 'hungary', 'bulgaria',
  'croatia', 'serbia', 'slovakia', 'slovenia', 'turkey', 'russia',
  'ukraine', 'belarus',
  'canada', 'mexico', 'brazil', 'argentina', 'chile', 'colombia',
  'peru', 'venezuela', 'uruguay', 'ecuador', 'cuba',
  'china', 'japan', 'korea', 'south korea', 'india', 'pakistan',
  'thailand', 'vietnam', 'philippines', 'malaysia', 'singapore',
  'indonesia', 'australia', 'new zealand', 'taiwan',
  'south africa', 'nigeria', 'egypt', 'kenya', 'morocco', 'ethiopia',
  'israel', 'saudi arabia', 'uae', 'qatar', 'lebanon', 'jordan',
]);

export function parseAudiusLocation(raw) {
  const s = String(raw || '').trim();
  if (!s) return { city: null, country: null };

  if (s.includes(',')) {
    const parts = s.split(',').map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
      const country = parts[parts.length - 1];
      const city = parts.slice(0, -1).join(', ');
      return {
        city: city.slice(0, 128) || null,
        country: country.slice(0, 64) || null,
      };
    }
    return { city: s.slice(0, 128), country: null };
  }

  if (COUNTRY_NAMES.has(s.toLowerCase())) {
    return { city: null, country: s.slice(0, 64) };
  }
  return { city: s.slice(0, 128), country: null };
}
