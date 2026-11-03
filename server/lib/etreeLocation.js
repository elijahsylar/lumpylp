// Internet Archive Live Music Archive (etree) artist location lookup.
//
// Used by both services/archive_livemusic.js (capture at ingest) and
// scripts/backfill-archive-livemusic-locations.js (existing rows).
//
// Two-stage lookup:
//   1. Curated band → home-base table. Hand-maintained for the jam-scene
//      bands that dominate the etree corpus. Curated answers may be more
//      accurate than Wikidata for cultural identity (e.g. Grateful Dead
//      = "SF Bay Area" rather than Wikidata's "Palo Alto").
//   2. Wikidata fallback via lib/wikimediaLocation.js — same conservative
//      label-substring match used by the wikimedia ingest path. When a
//      band isn't curated, this catches most well-known acts and many
//      obscure ones; truly long-tail / typo'd / generic-sounding names
//      stay null.
//
// Conservative throughout: when both strategies miss we return null.
// Better NULL than wrong.

import { lookupArtist as wikidataLookup } from './wikimediaLocation.js';

const US = 'United States';
const SF_BAY = { city: 'San Francisco',   country: US, raw: 'San Francisco Bay Area, CA, USA' };
const BURLINGTON = { city: 'Burlington',  country: US, raw: 'Burlington, VT, USA' };

// Curated table. Keys are normalized artist names (lowercased, trimmed,
// internal whitespace collapsed). Values are { city, country, raw }
// matching the artists table column shape.
//
// Sourced from the existing ETREE_PREFIX_TO_BAND in
// services/archive_livemusic.js plus a handful of top-track-count bands
// from a DB survey (Phil Lesh, ALO, Andrew Bird, Animal Collective, …).
// Add to this list when a new high-volume etree band lands without
// coverage; do NOT add bands whose home city you can't cite cleanly.
const ETREE_BAND_LOCATIONS = Object.freeze({
  // Grateful Dead extended family
  'grateful dead':           SF_BAY,
  'phil lesh':               SF_BAY,
  'phil lesh and friends':   SF_BAY,
  'phil lesh & friends':     SF_BAY,
  'jerry garcia':            SF_BAY,
  'jerry garcia band':       SF_BAY,
  'bob weir':                SF_BAY,
  'ratdog':                  SF_BAY,
  'furthur':                 SF_BAY,
  'mickey hart':             SF_BAY,
  'mickey hart band':        SF_BAY,
  'bill kreutzmann':         SF_BAY,
  'dead & company':          SF_BAY,
  'the dead':                SF_BAY,

  // Phish family
  'phish':                   BURLINGTON,
  'trey anastasio':          BURLINGTON,
  'trey anastasio band':     BURLINGTON,
  'mike gordon':             BURLINGTON,
  'page mcconnell':          BURLINGTON,

  // Jam-scene staples
  'widespread panic':                  { city: 'Athens',          country: US, raw: 'Athens, GA, USA' },
  'string cheese incident':            { city: 'Crested Butte',   country: US, raw: 'Crested Butte, CO, USA' },
  'the string cheese incident':        { city: 'Crested Butte',   country: US, raw: 'Crested Butte, CO, USA' },
  'moe.':                              { city: 'Buffalo',         country: US, raw: 'Buffalo, NY, USA' },
  "gov't mule":                        { city: 'New York',        country: US, raw: 'New York, NY, USA' },
  "umphrey's mcgee":                   { city: 'South Bend',      country: US, raw: 'South Bend, IN, USA' },
  'the disco biscuits':                { city: 'Philadelphia',    country: US, raw: 'Philadelphia, PA, USA' },
  'the allman brothers band':          { city: 'Macon',           country: US, raw: 'Macon, GA, USA' },
  'warren haynes':                     { city: 'Asheville',       country: US, raw: 'Asheville, NC, USA' },
  'yonder mountain string band':       { city: 'Nederland',       country: US, raw: 'Nederland, CO, USA' },
  "karl denson's tiny universe":       { city: 'San Diego',       country: US, raw: 'San Diego, CA, USA' },
  'keller williams':                   { city: 'Fredericksburg',  country: US, raw: 'Fredericksburg, VA, USA' },
  'leftover salmon':                   { city: 'Boulder',         country: US, raw: 'Boulder, CO, USA' },
  'railroad earth':                    { city: 'Stillwater',      country: US, raw: 'Stillwater, NJ, USA' },
  "joe russo's almost dead":           { city: 'Brooklyn',        country: US, raw: 'Brooklyn, NY, USA' },
  'medeski martin & wood':             { city: 'New York',        country: US, raw: 'New York, NY, USA' },
  'medeski martin and wood':           { city: 'New York',        country: US, raw: 'New York, NY, USA' },
  'sound tribe sector 9':              { city: 'Atlanta',         country: US, raw: 'Atlanta, GA, USA' },
  'sts9':                              { city: 'Atlanta',         country: US, raw: 'Atlanta, GA, USA' },
  'béla fleck':                        { city: 'Nashville',       country: US, raw: 'Nashville, TN, USA' },
  'bela fleck':                        { city: 'Nashville',       country: US, raw: 'Nashville, TN, USA' },
  'béla fleck and the flecktones':     { city: 'Nashville',       country: US, raw: 'Nashville, TN, USA' },
  'bela fleck and the flecktones':     { city: 'Nashville',       country: US, raw: 'Nashville, TN, USA' },
  'derek and the dominos':             { city: 'Miami',           country: US, raw: 'Miami, FL, USA' },

  // Top track-count bands surfaced from DB survey
  'animal liberation orchestra':       { city: 'Santa Cruz',      country: US, raw: 'Santa Cruz, CA, USA' },
  'alo':                               { city: 'Santa Cruz',      country: US, raw: 'Santa Cruz, CA, USA' },
  'andrew bird':                       { city: 'Chicago',         country: US, raw: 'Chicago, IL, USA' },
  'animal collective':                 { city: 'Baltimore',       country: US, raw: 'Baltimore, MD, USA' },
  'acid mothers temple':               { city: 'Nagoya',          country: 'Japan', raw: 'Nagoya, Japan' },
  'aquarium rescue unit':              { city: 'Atlanta',         country: US, raw: 'Atlanta, GA, USA' },
  '7 walkers':                         { city: 'New Orleans',     country: US, raw: 'New Orleans, LA, USA' },
  'american aquarium':                 { city: 'Raleigh',         country: US, raw: 'Raleigh, NC, USA' },
  'american babies':                   { city: 'Philadelphia',    country: US, raw: 'Philadelphia, PA, USA' },
  'aqueous':                           { city: 'Buffalo',         country: US, raw: 'Buffalo, NY, USA' },
  'arkansauce':                        { city: 'Fayetteville',    country: US, raw: 'Fayetteville, AR, USA' },
  'addison groove project':            { city: 'Boston',          country: US, raw: 'Boston, MA, USA' },
  'alejandro escovedo':                { city: 'Austin',          country: US, raw: 'Austin, TX, USA' },
  'acoustic junction':                 { city: 'Boulder',         country: US, raw: 'Boulder, CO, USA' },

  // Phase 17.8 chunk 5 top-up — top-10-misses pass, sourced from band's
  // own bio page or major outlet. Bands whose home city was unclear or
  // multi-city were left out (the Aerolites, Alvar Hanso) — null > wrong.
  'the andy coe band':                 { city: 'Seattle',         country: US, raw: 'Seattle, WA, USA' },         // andycoe.org bio + EverOut Seattle
  'adam ezra group':                   { city: 'Boston',          country: US, raw: 'Boston, MA, USA' },          // adamezra.com about + Boston Magazine
  'armchair boogie':                   { city: 'Madison',         country: US, raw: 'Madison, WI, USA' },         // armchairboogiemusic.com bio
  'all mighty senators':               { city: 'Baltimore',       country: US, raw: 'Baltimore, MD, USA' },       // Severn Records artist page
  'j.grizz band':                      { city: 'Upland',          country: US, raw: 'Upland, CA, USA' },          // ReverbNation bio
  'airshow':                           { city: 'Nashville',       country: US, raw: 'Nashville, TN, USA' },       // airshowband.com — current base (originated Reading PA, relocated 2015)
  'andrew north & the rangers':        { city: 'Concord',         country: US, raw: 'Concord, NH, USA' },         // andrewnorthandtherangers.com bio + Bill Copeland Music News
  'andrew north and the rangers':      { city: 'Concord',         country: US, raw: 'Concord, NH, USA' },         // alt punctuation
  'all night boogie band':             { city: 'Burlington',      country: US, raw: 'Burlington, VT, USA' },      // allnightboogieband.com about
});

function normalizeKey(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function lookupBandTable(name) {
  const key = normalizeKey(name);
  if (!key) return null;
  const hit = ETREE_BAND_LOCATIONS[key];
  if (!hit) return null;
  return { ...hit, source: 'etree' };
}

/**
 * Look up an etree artist's home location. Async because of the Wikidata
 * fallback. Returns { city, country, raw, source } where `source` is
 * 'etree' for curated-table hits or 'wikidata' for fallback hits — useful
 * later if we ever want to audit which strategy populated a given row.
 *
 * @param {string} artistName
 * @returns {Promise<{city: string|null, country: string|null, raw: string|null, source: 'etree'|'wikidata'} | null>}
 */
export async function lookupArtist(artistName) {
  const fromTable = lookupBandTable(artistName);
  if (fromTable) return fromTable;

  const fromWikidata = await wikidataLookup(artistName);
  if (fromWikidata) {
    return { ...fromWikidata, source: 'wikidata' };
  }

  return null;
}

// Test-only / diagnostic introspection.
export function _tableSize() {
  return Object.keys(ETREE_BAND_LOCATIONS).length;
}
