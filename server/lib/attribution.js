// Attribution data for a track (relaunch item 11): who made it, where it
// comes from, and under what license. Pure and deterministic: derived from
// stored fields, no network. When an item page can't be derived, source_url
// falls back to the source's home page and source_url_exact is false.
import { licenseInfo } from './licenses.js';

const SOURCE_INFO = {
  archive_pd78s:     { name: 'Internet Archive (78rpm collection)', home: 'https://archive.org/details/78rpm' },
  archive_livemusic: { name: 'Internet Archive (Live Music Archive)', home: 'https://archive.org/details/etree' },
  archive_netlabels: { name: 'Internet Archive (Netlabels)', home: 'https://archive.org/details/netlabels' },
  archive_subjects:  { name: 'Internet Archive', home: 'https://archive.org/details/audio' },
  archive_cylinders: { name: 'Internet Archive (Cylinder recordings)', home: 'https://archive.org/details/cylinderrecordings' },
  phlow:             { name: 'phlow netlabel catalogue, hosted by the Internet Archive', home: 'https://phlow.net/' },
  ucsb_cylinders:    { name: 'UCSB Cylinder Audio Archive', home: 'https://cylinders.library.ucsb.edu/' },
  audius:            { name: 'Audius', home: 'https://audius.co/' },
  jamendo:           { name: 'Jamendo', home: 'https://www.jamendo.com/' },
  ccmixter:          { name: 'ccMixter', home: 'https://ccmixter.org/' },
  wikimedia:         { name: 'Wikimedia Commons', home: 'https://commons.wikimedia.org/' },
  musopen:           { name: 'Musopen', home: 'https://musopen.org/' },
  loc_jukebox:       { name: 'Library of Congress', home: 'https://www.loc.gov/audio/' },
  incompetech:       { name: 'Incompetech (Kevin MacLeod)', home: 'https://incompetech.com/music/royalty-free/' },
  audionautix:       { name: 'Audionautix (Jason Shaw)', home: 'https://audionautix.com/' },
  europeana:         { name: 'Europeana', home: 'https://www.europeana.eu/' },
  smithsonian:       { name: 'Smithsonian', home: 'https://www.si.edu/' },
  soundcloud:        { name: 'SoundCloud', home: 'https://soundcloud.com/' },
};

const ARCHIVE_SOURCES = new Set(['archive_pd78s', 'archive_livemusic', 'archive_netlabels',
  'archive_subjects', 'archive_cylinders', 'phlow']);

// Item page for a track, or null when it can't be derived from stored fields.
function itemUrl(t) {
  const ext = String(t.external_id || '');
  switch (t.source) {
    case 'audius':
      return /^[A-Za-z0-9]+$/.test(ext) ? `https://audius.co/tracks/${ext}` : null;
    case 'jamendo':
      return /^\d+$/.test(ext) ? `https://www.jamendo.com/track/${ext}` : null;
    case 'ccmixter': {
      // stream_url: https://ccmixter.org/content/<user>/<file>.mp3 ; external_id: upload id
      const m = String(t.stream_url || '').match(/^https?:\/\/ccmixter\.org\/content\/([^/]+)\//);
      return m && /^\d+$/.test(ext) ? `https://ccmixter.org/files/${m[1]}/${ext}` : null;
    }
    case 'wikimedia':
      return ext.startsWith('File:')
        ? `https://commons.wikimedia.org/wiki/${encodeURIComponent(ext.replace(/ /g, '_')).replace(/%3A/i, ':')}`
        : null;
    case 'loc_jukebox':
      return /^(jukebox-)?\d+$/.test(ext) ? `https://www.loc.gov/item/${ext}/` : null;
    default:
      if (ARCHIVE_SOURCES.has(t.source)) {
        const id = ext.split(':')[0];
        return id ? `https://archive.org/details/${encodeURIComponent(id)}` : null;
      }
      return null;
  }
}

export function sourceName(source) {
  return SOURCE_INFO[source]?.name || String(source || 'Unknown source');
}

/** The five attribution fields (plus flags) for one track row. */
export function attributionFor(t) {
  const info = SOURCE_INFO[t.source];
  const exact = itemUrl(t);
  const lic = licenseInfo(t.license);
  // A bare "CC" (old Jamendo rows) has no deed of its own: link the item page,
  // which states the exact license.
  if (lic.url === null && lic.known && exact) lic.url = exact;
  return {
    artist: t.artist_name || 'Performer unlisted',
    source_name: sourceName(t.source),
    source_url: exact || info?.home || null,
    source_url_exact: !!exact,
    license_name: lic.name,
    license_url: lic.url,
  };
}
