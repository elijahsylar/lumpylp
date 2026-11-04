import { createContext, useContext, useEffect, useRef, useState, useCallback, useMemo } from 'react';
import type { Track } from '../types/track';
import { announce } from '../lib/announce';

export type PlayMode = 'order' | 'shuffle';

// Where the next-up tracks come from when shuffle is on.
//   - 'array': shuffle the explicit Track[] passed to load() (today's
//     behavior; used for lump pages, search results, single-track plays).
//   - 'filter': fetch random tracks from /api/tracks/shuffle?genre=X&artist=Y
//     so the pool is the full filtered result set rather than the loaded
//     scroll subset. Phase 18.0.
//   - 'location': fetch random tracks from /api/tracks/shuffle?lat=&lng=&radius=
//     for the "shuffle all in {city}" button on /discover.
export type ShuffleSource =
  | { kind: 'array' }
  | { kind: 'filter'; genre?: string; artist?: string }
  | { kind: 'location'; lat: number; lng: number; radius: number };

interface PlayerState {
  current: Track | null;
  queue: Track[];
  isPlaying: boolean;
  progress: number;
  duration: number;
  volume: number;
  playMode: PlayMode;
  load: (track: Track, queue?: Track[], shuffleSource?: ShuffleSource) => void;
  toggle: () => void;
  next: () => void;
  prev: () => void;
  seek: (seconds: number) => void;
  setVolume: (v: number) => void;
  setPlayMode: (mode: PlayMode) => void;
}

export const PlayerContext = createContext<PlayerState | null>(null);

export function usePlayer() {
  const ctx = useContext(PlayerContext);
  if (!ctx) throw new Error('usePlayer must be used inside <PlayerProvider>');
  return ctx;
}

// Phase 18.0 buffer caps.
//   PLAYED_CAP        — prev() can't walk back past this many tracks; oldest
//                       evicted FIFO. Product call: 200.
//   REFILL_THRESHOLD  — when shuffle is on and the source is filter-backed,
//                       fetch REFILL_BATCH more tracks once upcoming drops
//                       below this.
//   EXCLUDE_CAP       — matches the server-side cap on the exclude param.
const PLAYED_CAP = 200;
const REFILL_THRESHOLD = 10;
const REFILL_BATCH = 50;
const EXCLUDE_CAP = 200;

// Shuffle every track in `arr` except the one matching `keepId`, which stays
// at its original index. If `keepId` isn't in the array, shuffle everything.
function shuffleAroundCurrent(arr: Track[], keepId: number | null): Track[] {
  if (arr.length <= 1) return [...arr];
  const keepIdx = keepId == null ? -1 : arr.findIndex((t) => t.id === keepId);
  const others = arr.filter((_, i) => i !== keepIdx);
  for (let i = others.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [others[i], others[j]] = [others[j], others[i]];
  }
  if (keepIdx < 0) return others;
  const out: Track[] = new Array(arr.length);
  let oi = 0;
  for (let i = 0; i < arr.length; i++) {
    out[i] = i === keepIdx ? arr[keepIdx] : others[oi++];
  }
  return out;
}

export function usePlayerEngine(): PlayerState {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [current, setCurrent] = useState<Track | null>(null);
  // Queue split: played history + upcoming buffer. The exposed `queue` field
  // (below) is derived. Filter-source shuffle refills `upcoming` from the
  // server; array-source shuffle and order mode populate it from the loaded
  // Track[] passed to load().
  const [played, setPlayed] = useState<Track[]>([]);
  const [upcoming, setUpcoming] = useState<Track[]>([]);
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolumeState] = useState(0.8);
  const [playMode, setPlayModeState] = useState<PlayMode>('order');
  const [shuffleSource, setShuffleSource] = useState<ShuffleSource>({ kind: 'array' });

  // Original (canonical) queue order — used to restore on mode='order' and
  // as the source for shuffling on mode='shuffle' for array-source pools.
  const originalQueueRef = useRef<Track[]>([]);
  const playModeRef = useRef<PlayMode>('order');
  const shuffleSourceRef = useRef<ShuffleSource>({ kind: 'array' });
  const refillingRef = useRef(false);
  useEffect(() => { playModeRef.current = playMode; }, [playMode]);
  useEffect(() => { shuffleSourceRef.current = shuffleSource; }, [shuffleSource]);

  // ───────────────────────────────────────────────────────────────────────
  // Audio element — UNCHANGED from prior version. new Audio(), preload,
  // volume, four event listeners. Phase 18.0 deliberately preserves this
  // surface byte-for-byte; the queue-buffer refactor below changes only
  // how tracks are picked, not how bytes flow.
  // ───────────────────────────────────────────────────────────────────────
  useEffect(() => {
    const a = new Audio();
    a.preload = 'metadata';
    a.volume = volume;
    audioRef.current = a;
    const onTime = () => setProgress(a.currentTime);
    const onMeta = () => setDuration(a.duration || 0);
    const onEnd = () => nextRef.current?.();
    a.addEventListener('timeupdate', onTime);
    a.addEventListener('loadedmetadata', onMeta);
    a.addEventListener('ended', onEnd);
    return () => {
      a.pause();
      a.removeEventListener('timeupdate', onTime);
      a.removeEventListener('loadedmetadata', onMeta);
      a.removeEventListener('ended', onEnd);
    };
  }, []);

  // Internal helper: just play the bytes. State management for played/upcoming
  // happens in the caller (next/prev/load). Audio element calls are identical
  // to what load() did before the refactor.
  const playTrack = useCallback((track: Track) => {
    if (!audioRef.current || !track.playable) return;
    setCurrent(track);
    audioRef.current.src = `/api/stream/${track.id}`;
    audioRef.current.play().then(() => setIsPlaying(true)).catch(() => setIsPlaying(false));
    announce(`now playing ${track.title} by ${track.artist_name}`);
  }, []);

  const load = useCallback((track: Track, q?: Track[], source?: ShuffleSource) => {
    if (!audioRef.current || !track.playable) return;
    const src = source || { kind: 'array' };
    setShuffleSource(src);
    if (q) {
      // Always remember the canonical order so toggling back to 'order' works.
      originalQueueRef.current = q;
      if (playModeRef.current === 'shuffle' && src.kind === 'array') {
        // Array-source shuffle: shuffle the loaded subset around the clicked
        // track. Played/upcoming are positions within the shuffled array —
        // matches today's behavior for lumps, search, single-track plays.
        const shuffled = shuffleAroundCurrent(q, track.id);
        const idx = shuffled.findIndex((t) => t.id === track.id);
        setPlayed(idx >= 0 ? shuffled.slice(0, idx) : []);
        setUpcoming(idx >= 0 ? shuffled.slice(idx + 1) : []);
      } else if (playModeRef.current === 'shuffle' && src.kind === 'filter') {
        // Filter-source shuffle: clear so the refill effect populates upcoming
        // from /api/tracks/shuffle. (No caller exercises this until chunk 3.)
        setPlayed([]);
        setUpcoming([]);
      } else if (src.kind === 'location') {
        // Location-source: callers pre-fetch the first batch from
        // /api/tracks/shuffle (server already randomized) and pass it as q.
        // Use linearly — same as order mode — and let the refill effect
        // top up from the catalog when upcoming runs low.
        const idx = q.findIndex((t) => t.id === track.id);
        setPlayed(idx >= 0 ? q.slice(0, idx) : []);
        setUpcoming(idx >= 0 ? q.slice(idx + 1) : [...q]);
      } else {
        // Order mode: linear from q.
        const idx = q.findIndex((t) => t.id === track.id);
        setPlayed(idx >= 0 ? q.slice(0, idx) : []);
        setUpcoming(idx >= 0 ? q.slice(idx + 1) : [...q]);
      }
    }
    playTrack(track);
  }, [playTrack]);

  const toggle = useCallback(() => {
    const a = audioRef.current;
    if (!a || !current) return;
    if (a.paused) {
      a.play().then(() => setIsPlaying(true)).catch(() => {});
    } else {
      a.pause();
      setIsPlaying(false);
    }
  }, [current]);

  const next = useCallback(() => {
    if (!current || !upcoming.length || !audioRef.current) return;
    // Skip tracks that can't play (dead links in a lump or list): stopping
    // at one would end playback for good, since nothing else advances.
    // Validated before any state mutation, so played/upcoming stay intact
    // when nothing ahead is playable.
    const i = upcoming.findIndex((t) => t.playable);
    if (i < 0) return;
    setPlayed((p) => {
      const appended = [...p, current];
      return appended.length > PLAYED_CAP ? appended.slice(-PLAYED_CAP) : appended;
    });
    setUpcoming((u) => u.slice(i + 1));
    playTrack(upcoming[i]);
  }, [current, upcoming, playTrack]);

  const prev = useCallback(() => {
    if (!current || !played.length || !audioRef.current) return;
    // The most recent playable track; dead ones in between are dropped.
    let j = played.length - 1;
    while (j >= 0 && !played[j].playable) j -= 1;
    if (j < 0) return;
    setPlayed((p) => p.slice(0, j));
    setUpcoming((u) => [current, ...u]);
    playTrack(played[j]);
  }, [current, played, playTrack]);

  const nextRef = useRef(next);
  useEffect(() => { nextRef.current = next; }, [next]);

  const seek = useCallback((seconds: number) => {
    if (audioRef.current) audioRef.current.currentTime = seconds;
  }, []);

  const setVolume = useCallback((v: number) => {
    setVolumeState(v);
    if (audioRef.current) audioRef.current.volume = v;
  }, []);

  const setPlayMode = useCallback((mode: PlayMode) => {
    setPlayModeState(mode);
    if (mode === 'order') {
      // Restore linear order as the forward direction. played stays intact
      // (user can still hit prev to walk back through what they actually
      // played, including any shuffle picks not in originalQueueRef).
      const orig = originalQueueRef.current;
      if (!current || !orig.length) { setUpcoming([]); return; }
      const idx = orig.findIndex((t) => t.id === current.id);
      setUpcoming(idx >= 0 ? orig.slice(idx + 1) : [...orig]);
      return;
    }
    // mode === 'shuffle'
    if (shuffleSource.kind === 'filter' || shuffleSource.kind === 'location') {
      // Server-backed source: clear upcoming, refill effect handles the
      // fetch. played stays (matches toggle-off symmetry).
      setUpcoming([]);
      return;
    }
    // Array source: today's behavior preserved — shuffle the canonical queue
    // around the current track and rebuild played/upcoming from the shuffled
    // array.
    if (!current) return;
    const orig = originalQueueRef.current;
    if (!orig.length) return;
    const shuffled = shuffleAroundCurrent(orig, current.id);
    const idx = shuffled.findIndex((t) => t.id === current.id);
    setPlayed(idx >= 0 ? shuffled.slice(0, idx) : []);
    setUpcoming(idx >= 0 ? shuffled.slice(idx + 1) : []);
  }, [current, shuffleSource]);

  // Refill effect — fires for any server-backed shuffle source (filter or
  // location). Array-source and order mode return early. inflight flag
  // prevents overlapping fetches when next() runs faster than the network.
  // Source captured at fetch start; resolution check compares kind + the
  // identifying fields so a mid-flight source change (e.g. user navigates
  // Electronic → Hip-Hop, or expands radius 50 → 250) can't append stale
  // results from the prior source.
  useEffect(() => {
    if (playMode !== 'shuffle') return;
    if (shuffleSource.kind !== 'filter' && shuffleSource.kind !== 'location') return;
    if (upcoming.length >= REFILL_THRESHOLD) return;
    if (refillingRef.current) return;

    refillingRef.current = true;
    const sourceAtFetchStart = shuffleSource;
    const params = new URLSearchParams({ n: String(REFILL_BATCH) });
    if (sourceAtFetchStart.kind === 'filter') {
      if (sourceAtFetchStart.genre) params.set('genre', sourceAtFetchStart.genre);
      if (sourceAtFetchStart.artist) params.set('artist', sourceAtFetchStart.artist);
    } else {
      params.set('lat', String(sourceAtFetchStart.lat));
      params.set('lng', String(sourceAtFetchStart.lng));
      params.set('radius', String(sourceAtFetchStart.radius));
    }
    const excludeIds = [
      ...(current ? [current.id] : []),
      ...played.map((t) => t.id),
      ...upcoming.map((t) => t.id),
    ].slice(0, EXCLUDE_CAP);
    if (excludeIds.length) params.set('exclude', excludeIds.join(','));

    fetch(`/api/tracks/shuffle?${params.toString()}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`shuffle ${r.status}`))))
      .then((data) => {
        // Stale-source check: bail if mode flipped, kind changed, or the
        // identifying fields shifted while this fetch was in flight.
        if (playModeRef.current !== 'shuffle') return;
        const cur = shuffleSourceRef.current;
        if (cur.kind !== sourceAtFetchStart.kind) return;
        if (cur.kind === 'filter' && sourceAtFetchStart.kind === 'filter') {
          if (cur.genre !== sourceAtFetchStart.genre) return;
          if (cur.artist !== sourceAtFetchStart.artist) return;
        } else if (cur.kind === 'location' && sourceAtFetchStart.kind === 'location') {
          if (cur.lat !== sourceAtFetchStart.lat) return;
          if (cur.lng !== sourceAtFetchStart.lng) return;
          if (cur.radius !== sourceAtFetchStart.radius) return;
        }
        const fetched: Track[] = data.tracks || [];
        setUpcoming((u) => {
          const blocked = new Set([
            ...(current ? [current.id] : []),
            ...played.map((t) => t.id),
            ...u.map((t) => t.id),
          ]);
          return [...u, ...fetched.filter((t) => !blocked.has(t.id))];
        });
      })
      .catch(() => { /* silent — next state change retries */ })
      .finally(() => { refillingRef.current = false; });
  }, [playMode, shuffleSource, upcoming.length, current, played]);

  const queue = useMemo(
    () => (current ? [...played, current, ...upcoming] : []),
    [played, current, upcoming]
  );

  return {
    current, queue, isPlaying, progress, duration, volume, playMode,
    load, toggle, next, prev, seek, setVolume, setPlayMode,
  };
}
