export interface Track {
  id: number;
  external_id: string;
  source: 'archive' | 'ccmixter' | 'jamendo' | 'wikimedia' | string;
  title: string;
  artist_name: string;
  genre: string | null;
  duration_seconds: number | null;
  /** Whether the track has a stream. The player always streams through
   *  /api/stream/:id; the API never sends file URLs (streaming only). */
  playable: boolean;
  license: string | null;
  /** Credit line data required by the track's license. Null only for the
   *  "Unavailable track" placeholder a lump owner sees for a hidden track. */
  attribution: Attribution | null;
  artwork_url: string | null;
  // Phase 2A: vote tallies. Optional because not every endpoint includes them.
  upvotes?: number;
  downvotes?: number;
  net_lumps?: number;
  user_vote?: 1 | -1 | 0 | null;
  /** Present on lump tracks: false when the track has gone dead or been hidden. */
  available?: boolean;
}

export interface Attribution {
  artist: string;
  source_name: string;
  /** The item's page at the source, or the source's home page. */
  source_url: string | null;
  source_url_exact: boolean;
  license_name: string;
  license_url: string | null;
}

export interface Genre {
  id: number;
  name: string;
  track_count: number;
}

export interface Artist {
  id: number;
  name: string;
  source: string;
  bio: string | null;
  artwork_url: string | null;
}
