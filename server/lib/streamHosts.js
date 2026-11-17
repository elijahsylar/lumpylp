// Where /api/stream/:trackId may redirect a browser, per catalog source.
//
// The stream route 302-redirects to the track's stored stream_url for every
// source except Audius (resolved per request) and ccMixter (proxied; see
// ccmixterProxyTarget in routes/tracks.js). The stored value comes from the
// indexer or a database write, so before redirecting it must:
//   1. parse as a URL,
//   2. use http: or https:, with no credentials and no explicit port,
//   3. have a host listed below for that track's source.
// Anything else is refused: the route answers 404 and never redirects.
//
// Entry forms:
//   'upload.wikimedia.org'   that exact host
//   '.archive.org'           any subdomain of archive.org (not archive.org
//                            itself, and never a look-alike such as
//                            archive.org.example.com)
//
// A source with NO entry is refused (the safe default). To add a source, or
// a new host for an existing one: read what its resolver in services/ stores
// as stream_url, add the narrowest entry that covers it, and add a case to
// test/audit-stream-redirect.test.js. That test also fails when a name in
// lib/sources.js has neither an entry here nor a place in NOT_REDIRECTED.
const ARCHIVE_ORG = ['archive.org', '.archive.org'];

export const STREAM_HOSTS = {
  // archive-base.js and phlow.js build https://archive.org/download/<item>/<file>.
  // Subdomains are allowed for archive.org's numbered download hosts.
  archive_pd78s: ARCHIVE_ORG,
  archive_livemusic: ARCHIVE_ORG,
  archive_netlabels: ARCHIVE_ORG,
  archive_subjects: ARCHIVE_ORG,
  archive_cylinders: ARCHIVE_ORG,
  phlow: ARCHIVE_ORG,
  // ucsb_cylinders.js only accepts an <audio src> starting https://cylinders.s3:
  // the "cylinders" S3 bucket, in the three host spellings S3 serves it under.
  ucsb_cylinders: [
    'cylinders.s3-us-west-2.amazonaws.com',
    'cylinders.s3.us-west-2.amazonaws.com',
    'cylinders.s3.amazonaws.com',
  ],
  // jamendo.js stores the API's `audio` URL (a *.storage.jamendo.com host).
  jamendo: ['.jamendo.com'],
  // wikimedia.js stores imageinfo.url, always on Commons' upload host.
  wikimedia: ['upload.wikimedia.org'],
  // musopen.js stores the API's `fileurl` (dl.musopen.org).
  musopen: ['musopen.org', '.musopen.org'],
  // loc_jukebox.js stores the media or download URL loc.gov returns (tile.loc.gov).
  loc_jukebox: ['loc.gov', '.loc.gov'],
  // incompetech.js builds https://incompetech.com/music/royalty-free/mp3-royaltyfree/<file>.
  incompetech: ['incompetech.com'],
  // audionautix.js stores the page's mp3 link, resolved against https://audionautix.com.
  audionautix: ['audionautix.com', 'www.audionautix.com'],
  // The two below had no rows when this list was written; the hosts are
  // what the resolvers and the upstream APIs point at, not observed values.
  // soundcloud.js stores the API's stream_url (api.soundcloud.com/tracks/<id>/stream).
  soundcloud: ['api.soundcloud.com'],
  // smithsonian.js stores an online_media URL from the Open Access API.
  smithsonian: ['.si.edu'],
};

// Sources in lib/sources.js that deliberately have no entry above.
export const NOT_REDIRECTED = {
  audius: 'the route resolves a CDN URL per request and ignores stream_url',
  ccmixter: 'proxied, never redirected (ccmixterProxyTarget)',
  europeana: 'media sits on each contributing archive\'s own host, so no fixed '
    + 'list exists; refused until its hosts are listed (no rows when this was written)',
};

function hostAllowed(hostname, entries) {
  // A dot entry needs a real label before the dot ('.archive.org' itself is not a host).
  return entries.some((e) => (e.startsWith('.')
    ? hostname.length > e.length && hostname.endsWith(e)
    : hostname === e));
}

/**
 * The URL the stream route may redirect to for a track of `source`, or null
 * when the stored value must not be used. Returns the parsed URL's
 * normalized href, never the raw stored string.
 */
export function streamRedirectTarget(source, raw) {
  const entries = Object.hasOwn(STREAM_HOSTS, source) ? STREAM_HOSTS[source] : null;
  if (!entries) return null;
  let u;
  try { u = new URL(String(raw)); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password || u.port) return null;
  if (!hostAllowed(u.hostname, entries)) return null;
  return u.href;
}
