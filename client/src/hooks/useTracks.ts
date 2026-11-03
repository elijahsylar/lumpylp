import { useEffect, useRef, useState, useCallback } from 'react';
import type { Track, Genre } from '../types/track';

export type TrackSort = 'heap' | 'fresh' | 'alpha';

interface UseTracksOpts {
  genre?: string | null;
  artist?: string | null;
  sort?: TrackSort;
  includeDumped?: boolean;
}

export function useTracks(opts: UseTracksOpts = {}) {
  const { genre = null, artist = null, sort, includeDumped } = opts;
  const [tracks, setTracks] = useState<Track[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Synchronous dedupe lock — protects against IntersectionObserver firing
  // loadMore twice before React re-renders with the new loading state.
  const inflightRef = useRef(false);
  // Monotonic request id — stale responses (after a genre change) check this
  // and bail before writing state.
  const reqIdRef = useRef(0);

  const hasMore = tracks.length < total;

  const fetchPage = useCallback(
    async (targetPage: number, append: boolean) => {
      if (inflightRef.current) return;
      const myId = ++reqIdRef.current;
      inflightRef.current = true;
      setLoading(true);
      setError(null);

      try {
        const params = new URLSearchParams({ page: String(targetPage) });
        if (genre) params.set('genre', genre);
        if (artist) params.set('artist', artist);
        if (sort) params.set('sort', sort);
        if (includeDumped) params.set('include_dumped', '1');
        const res = await fetch(`/api/tracks?${params.toString()}`);
        const data = await res.json();
        if (reqIdRef.current !== myId) return;
        const newTracks: Track[] = data.tracks || [];
        setTotal(data.total || 0);
        setPage(targetPage);
        setTracks((prev) => (append ? [...prev, ...newTracks] : newTracks));
      } catch (e: unknown) {
        if (reqIdRef.current !== myId) return;
        setError(e instanceof Error ? e.message : 'fetch failed');
      } finally {
        if (reqIdRef.current === myId) {
          inflightRef.current = false;
          setLoading(false);
        }
        // If stale, the newer fetch already owns the lock — leave it alone.
      }
    },
    [genre, artist, sort, includeDumped]
  );

  // Reset and refetch from page 1 whenever the filter changes.
  useEffect(() => {
    reqIdRef.current++;
    inflightRef.current = false;
    setTracks([]);
    setPage(1);
    setTotal(0);
    fetchPage(1, false);
  }, [genre, artist, sort, includeDumped, fetchPage]);

  const loadMore = useCallback(() => {
    if (!hasMore) return;
    fetchPage(page + 1, true);
  }, [hasMore, page, fetchPage]);

  return { tracks, total, loading, error, hasMore, loadMore };
}

export function useGenres() {
  const [genres, setGenres] = useState<Genre[]>([]);
  useEffect(() => {
    fetch('/api/genres')
      .then((r) => r.json())
      .then((d) => setGenres(d.genres || []))
      .catch(() => setGenres([]));
  }, []);
  return genres;
}
