// Internet Archive Live Music Archive (etree collection).
//
// ~270k recordings, mostly jam bands and experimental scenes that
// explicitly allow taping and free redistribution under per-band taper
// policies (expressed as CC licenses or "free distribution allowed" in
// IA metadata).
//
// Reuses createArchiveSourceFetcher() from archive-base.js with a few
// livemusic-specific knobs:
//   - releaseFileLimit raised to 200 (multi-night box sets show up as
//     one IA item with many files; 50 was too tight)
//   - extraCollectionRejects on 'spokenwordandstorytelling' for the
//     occasional cross-tagged release
//   - rejectReleaseIfAnyFileLongerSec=5400 (90 min) — full-set
//     continuous recordings get skipped at the release level so we
//     don't emit a single 2-hour "track"
//   - title fallback walks file.title -> file.original (etree's real
//     song-name field) -> cleanFilename(file.name)
//   - artist fallback walks file.creator -> metadata.creator ->
//     metadata.artist -> derive-from-identifier (etree IDs lead with
//     the band slug, e.g. "gd1977-05-08", "phish1995-12-31"). The slug
//     is mapped to a canonical band name where we know it; otherwise
//     it's uppercased and used as-is.

import { createArchiveSourceFetcher } from './archive-base.js';
import { lookupArtist } from '../lib/etreeLocation.js';

export const ARCHIVE_LIVEMUSIC_QUERIES = [{ name: 'etree' }];

// Identifier-prefix -> band-name lookup. The leading alphabetic chunk of
// most etree identifiers maps cleanly to one of these. If it doesn't,
// we fall through and uppercase the prefix (still passes the artist
// quality gate, just less pretty than "Grateful Dead").
const ETREE_PREFIX_TO_BAND = {
  gd: 'Grateful Dead',
  jgb: 'Jerry Garcia Band',
  jgms: 'Jerry Garcia',
  jg: 'Jerry Garcia',
  ph: 'Phish',
  phish: 'Phish',
  wsp: 'Widespread Panic',
  sci: 'String Cheese Incident',
  moe: 'moe.',
  gov: "Gov't Mule",
  govtmule: "Gov't Mule",
  dso: 'Dark Star Orchestra',
  yonder: 'Yonder Mountain String Band',
  ymsb: 'Yonder Mountain String Band',
  kdtu: "Karl Denson's Tiny Universe",
  keller: 'Keller Williams',
  furthur: 'Furthur',
  db: 'The Disco Biscuits',
  discobiscuits: 'The Disco Biscuits',
  umphreys: "Umphrey's McGee",
  um: "Umphrey's McGee",
  abb: 'The Allman Brothers Band',
  allman: 'The Allman Brothers Band',
  allmanbrothers: 'The Allman Brothers Band',
  warrenhaynes: 'Warren Haynes',
  rrr: 'Railroad Earth',
  re: 'Railroad Earth',
  ratdog: 'RatDog',
  jrad: 'Joe Russo\'s Almost Dead',
  ls: 'Leftover Salmon',
  bobweir: 'Bob Weir',
  weir: 'Bob Weir',
  phil: 'Phil Lesh',
  philleshandfriends: 'Phil Lesh and Friends',
  plf: 'Phil Lesh and Friends',
  trey: 'Trey Anastasio',
  tab: 'Trey Anastasio Band',
  mmw: 'Medeski Martin & Wood',
  ssmf: 'Sound Tribe Sector 9',
  sts9: 'Sound Tribe Sector 9',
  lcd: 'lcd soundsystem',
  bm: 'Béla Fleck',
  bfleck: 'Béla Fleck',
  yes: 'Yes',
  derekandthedominos: 'Derek and the Dominos',
};

function artistFromEtreeIdentifier(identifier) {
  if (!identifier || typeof identifier !== 'string') return null;
  // Strip non-alpha leading chars, take run of letters until a digit/punct.
  const m = identifier.toLowerCase().match(/^([a-z]+)/);
  if (!m) return null;
  const prefix = m[1];
  if (ETREE_PREFIX_TO_BAND[prefix]) return ETREE_PREFIX_TO_BAND[prefix];
  // Last resort: use the prefix itself, capitalized. Better than "Unknown".
  if (prefix.length < 2) return null;
  return prefix.charAt(0).toUpperCase() + prefix.slice(1);
}

function pickEtreeTitle(file) {
  if (!file) return null;
  if (file.title && String(file.title).trim()) return String(file.title).trim();
  if (file.original && String(file.original).trim()) {
    // file.original is sometimes the canonical-format filename of the
    // same logical track; only use it if it doesn't look like a filename.
    const orig = String(file.original).trim();
    if (!/\.(mp3|flac|ogg|wav|shn)$/i.test(orig)) return orig;
  }
  return null;
}

const fetcher = createArchiveSourceFetcher({
  sourceName: 'archive_livemusic',
  collection: 'etree',
  // Live Music Archive items use mediatype:etree, not mediatype:audio,
  // so the default `AND mediatype:(audio)` filter would match zero
  // rows. Override to 'etree'.
  searchMediaType: 'etree',
  // Etree items have no license/licenseurl in IA metadata — taper
  // policies are band-by-band, not encoded as CC URLs. Slug all
  // releases as 'taper-policy' (Phase 17 added it to the gate's
  // ACCEPTED_LICENSES set) so the gate has something it can normalize.
  defaultLicense: 'taper-policy',
  releaseFileLimit: 200,
  extraCollectionRejects: ['spokenwordandstorytelling'],
  rejectReleaseIfAnyFileLongerSec: 5400, // 90 min
  pickFileTitle: pickEtreeTitle,
  artistFromIdentifier: artistFromEtreeIdentifier,
});

// Phase 17.8: layered artist-location lookup. Curated jam-scene table
// first (cultural shorthand), Wikidata fallback second. Resolved once per
// unique artist name on the page, then attached to every track for that
// artist. Cache lives inside lib/etreeLocation.js + lib/wikimediaLocation.js
// so repeat artists across pages and queries are free.
async function attachArtistLocations(tracks) {
  const uniq = [...new Set(
    tracks
      .map((t) => t.artist_name)
      .filter((n) => n && n !== 'Unknown')
  )];
  for (const name of uniq) {
    const loc = await lookupArtist(name);
    if (!loc) continue;
    for (const t of tracks) {
      if (t.artist_name === name) {
        t._artist_location_raw = loc.raw;
        t._artist_country = loc.country;
        t._artist_city = loc.city;
        t._artist_location_source = loc.source; // 'etree' or 'wikidata'
      }
    }
  }
}

// Wrap so every track carries _genre_hint='live' — the indexer's
// applyGenreNormalization tries the release's raw subject first
// (set on t.genre by archive-base), and falls back to 'live' when
// the subject doesn't map onto the canonical taxonomy. 'live' is
// listed in the canonical set in genre-mapper.js so it resolves cleanly.
export async function fetchTracksPage(query, page = 1, perPage) {
  const tracks = await fetcher.fetchTracksPage(query, page, perPage);
  for (const t of tracks) {
    if (t._genre_hint == null) t._genre_hint = 'live';
  }
  await attachArtistLocations(tracks);
  return tracks;
}
