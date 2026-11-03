// Phase 15 genre normalizer. Coerce raw genre strings from any source onto
// the existing 63-genre taxonomy in the prod genres table. If no match,
// return null — the indexer still ingests the track (just without a genre).
//
// Don't add new canonical genres without coordinating with the indexer; the
// genres table is rebuilt from tracks.genre on each run, so an unrecognized
// value here would silently dilute the taxonomy.

const CANONICAL = new Set([
  'acoustic', 'ambient', 'bass', 'beat', 'blues', 'chiptune', 'choral',
  'classical', 'comedy', 'country', 'dance', 'disco', 'dnb', 'downtempo',
  'drone', 'dub', 'electro', 'electronic', 'experimental', 'folk', 'funk',
  'game', 'garage', 'gospel', 'grunge', 'guitar', 'hardrock', 'hip hop',
  'hip-hop', 'hiphop', 'house', 'hyperpop', 'indie', 'industrial',
  'instrumental', 'jazz', 'latin', 'live', 'lo-fi', 'lofi', 'metal',
  'noise', 'opera', 'orchestral', 'piano', 'pop', 'post-rock', 'punk',
  'r&b', 'rap', 'reggae', 'religious', 'rnb', 'rock', 'shoegaze', 'ska', 'soul',
  'soundtrack', 'spoken word', 'swing', 'synthwave', 'techno', 'trance',
  'trap', 'world',
  // Phase 18 — temporal categories. Stored in tracks.genre alongside
  // musical genres; Discover can browse temporal eras as sibling
  // categories. Currently only pre-1929 ships (archive_pd78s); future
  // resolvers may add 1930s/1940s/etc.
  'pre-1929',
]);

// All keys lowercased + trimmed before lookup. Values must be in CANONICAL.
const SYNONYMS = {
  // hip-hop variants — all coerce to existing 'hip hop' (the taxonomy keeps
  // three spellings for historical reasons; pick the most common).
  'hip hop': 'hip hop', 'hip-hop': 'hip-hop', 'hiphop': 'hiphop',
  'rap and hip hop': 'hip hop',

  // electronic family
  'edm': 'electronic',
  'idm': 'electronic',
  'electronica': 'electronic',
  'glitch': 'electronic',
  'breakbeat': 'electronic',
  'drum & bass': 'dnb', 'drum and bass': 'dnb', 'd&b': 'dnb',
  'drum n bass': 'dnb', 'drumnbass': 'dnb',
  'down tempo': 'downtempo', 'down-tempo': 'downtempo',
  'lofi hip hop': 'lo-fi', 'lo fi': 'lo-fi',
  'synth wave': 'synthwave', 'synth-wave': 'synthwave',
  'house music': 'house',
  'tech house': 'house',
  'deep house': 'house',
  'minimal techno': 'techno',
  'minimal': 'electronic',

  // rock family
  'hard rock': 'hardrock', 'hard-rock': 'hardrock',
  'classic rock': 'rock',
  'alt rock': 'rock', 'alternative': 'rock', 'alternative rock': 'rock',
  'prog rock': 'rock', 'progressive rock': 'rock',
  'post rock': 'post-rock',
  'indie rock': 'indie',
  'rock and roll': 'rock', 'rock & roll': 'rock', "rock 'n' roll": 'rock',

  // metal — fold into 'metal' (no subgenre canon)
  'heavy metal': 'metal', 'death metal': 'metal', 'black metal': 'metal',
  'doom metal': 'metal', 'thrash metal': 'metal', 'power metal': 'metal',
  'metalcore': 'metal', 'nu metal': 'metal',

  // pop
  'pop music': 'pop',
  'synth pop': 'synthwave', 'synth-pop': 'synthwave',
  'dream pop': 'pop',
  'electropop': 'pop',
  'k-pop': 'pop', 'kpop': 'pop',
  'j-pop': 'pop', 'jpop': 'pop',

  // jazz family
  'smooth jazz': 'jazz',
  'free jazz': 'jazz',
  'bebop': 'jazz',
  'big band': 'swing',

  // classical family
  'baroque': 'classical', 'romantic': 'classical', 'modern classical': 'classical',
  'symphony': 'orchestral', 'symphonic': 'orchestral',
  'chamber music': 'classical',
  'piano music': 'piano', 'solo piano': 'piano',
  'opera music': 'opera',
  'choral music': 'choral', 'choir': 'choral',

  // world / folk / latin
  'world music': 'world',
  'folk music': 'folk', 'acoustic folk': 'folk',
  'celtic': 'folk',
  'bluegrass': 'folk',
  'americana': 'folk',
  'reggaeton': 'latin',
  'salsa': 'latin',
  'bossa nova': 'latin',
  'cumbia': 'latin',
  'flamenco': 'latin',
  'african': 'world',
  'indian': 'world',

  // r&b / soul
  'r and b': 'r&b', 'rhythm and blues': 'r&b',
  'neo soul': 'soul', 'neosoul': 'soul',

  // blues / country
  'delta blues': 'blues', 'electric blues': 'blues',
  'country music': 'country', 'country and western': 'country',

  // reggae / dub / ska
  'roots reggae': 'reggae', 'dub reggae': 'dub', 'ska punk': 'ska',

  // ambient / drone / experimental
  'dark ambient': 'ambient', 'space ambient': 'ambient',
  'noise music': 'noise', 'harsh noise': 'noise',
  'experimental music': 'experimental', 'avant-garde': 'experimental',
  'avant garde': 'experimental',

  // soundtrack / game
  'film score': 'soundtrack', 'movie soundtrack': 'soundtrack', 'ost': 'soundtrack',
  'video game': 'game', 'video game music': 'game', 'vgm': 'game',
  'chiptunes': 'chiptune', '8-bit': 'chiptune', '8bit': 'chiptune',

  // comedy / spoken
  'standup': 'comedy', 'stand-up': 'comedy',
  'spokenword': 'spoken word', 'spoken_word': 'spoken word',
  'poetry': 'spoken word',

  // dance / disco / funk / soul shorthand
  'disco music': 'disco', 'nu disco': 'disco',
  'funky': 'funk',
  'dance music': 'dance',

  // bass / trap / trance variants
  'dubstep': 'bass',
  'future bass': 'bass',
  'psy trance': 'trance', 'psytrance': 'trance',
  'goa': 'trance',
  'trap music': 'trap',

  // misc / instrument-led
  'guitar music': 'guitar',
  'instrumental music': 'instrumental',

  // industrial / shoegaze / grunge / punk
  'industrial rock': 'industrial', 'ebm': 'industrial',
  'shoegazer': 'shoegaze',
  'post grunge': 'grunge',
  'post punk': 'punk', 'pop punk': 'punk', 'hardcore punk': 'punk',
  'hardcore': 'punk',
};

export function normalizeGenre(raw) {
  if (raw == null) return null;
  let s = String(raw).trim().toLowerCase();
  if (!s) return null;

  // Strip surrounding punctuation/quotes, collapse whitespace.
  s = s.replace(/^[\s'"`]+|[\s'"`]+$/g, '').replace(/\s+/g, ' ');
  if (!s) return null;

  // Direct hit
  if (CANONICAL.has(s)) return s;

  // Synonym lookup
  const mapped = SYNONYMS[s];
  if (mapped) return mapped;

  // Last-resort substring contains for the more distinctive canonical names.
  // Only applied to multi-word inputs to avoid e.g. "rap" matching "rapture".
  if (s.includes(' ')) {
    for (const can of CANONICAL) {
      if (can.length >= 4 && s.includes(can)) return can;
    }
  }

  return null;
}
