// Shared title/artist normalization + junk detection.
// Mirrors the SQL cleanups so future indexer runs don't re-introduce the
// same patterns we just stripped from the catalog.

const LEADING_NUM      = /^[0-9]+(?:[. ,_\-]+|\.)\s*/;
const YEAR_SUFFIX      = /\s*[\(\[][0-9]{4}[\)\]]\s*$/;
const BITRATE_SUFFIX   = /\s*[\(\[\-]?\s*(?:320kbps|192kbps|128kbps|HQ|HD|MASTER|REMASTER(?:ED)?)\s*[\)\]\-]?\s*$/i;
const URL_RE           = /https?:\/\/|www\.|\.(?:com|net|org|io|fm)\b/i;

/**
 * Strip mechanical noise from a track title. Multi-pass so combined
 * suffixes like "Title (2019) [HQ]" both come off.
 */
export function cleanTitle(raw) {
  if (typeof raw !== 'string') return raw;
  let t = raw.trim();
  for (let i = 0; i < 2; i++) {
    t = t.replace(YEAR_SUFFIX, '').replace(BITRATE_SUFFIX, '').trim();
  }
  // Only apply the leading-number strip when the result is still substantial.
  // Protects "01" from becoming "" and short numeric titles from disappearing.
  const stripped = t.replace(LEADING_NUM, '').trim();
  if (stripped.length >= 2) t = stripped;
  return t;
}

/**
 * Returns a reason string when the track is obvious garbage to reject at
 * ingest time, or null when it's fine to keep. Caller should run cleanTitle
 * first so the URL check sees the cleaned title.
 */
export function isJunkTrack(track) {
  const title  = String(track.title || '').trim();
  const artist = String(track.artist_name || '').trim();
  if (!/[a-z0-9]/i.test(title))   return 'title has no alphanumerics';
  if (URL_RE.test(title))         return 'title contains URL';
  if (URL_RE.test(artist))        return 'artist contains URL';
  return null;
}
