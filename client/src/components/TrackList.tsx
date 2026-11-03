import { useEffect, useRef } from 'react';
import type { Track } from '../types/track';
import type { ShuffleSource } from '../hooks/usePlayer';
import { TrackCard } from './TrackCard';

interface Props {
  tracks: Track[];
  loading?: boolean;
  hasMore?: boolean;
  loadMore?: () => void;
  countMode?: 'index' | 'lumps';
  /** Forwarded to each TrackCard. When set, click-to-play seeds the
   *  player with a filter-source shuffle pool. */
  shuffleSource?: ShuffleSource;
  /** Drops the Artist column — used on the artist detail page. */
  hideArtist?: boolean;
}

export function TrackList({ tracks, loading, hasMore, loadMore, countMode, shuffleSource, hideArtist }: Props) {
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!hasMore || !loadMore) return;
    const el = sentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) loadMore();
      },
      { rootMargin: '200px' }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [hasMore, loadMore]);

  if (loading && tracks.length === 0) {
    return <div className="px-2 py-8 text-body-very-dim text-sm uppercase tracking-wider">loading…</div>;
  }
  if (!tracks.length) {
    return (
      <div className="px-2 py-8 text-body-very-dim text-sm uppercase tracking-wider">
        no tracks indexed yet — run the indexer.
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <div className="hidden md:grid grid-cols-[2.5rem_1fr_1fr_8rem_4rem_3.5rem_2.5rem] gap-3 px-3 py-2 bg-bg
                      border-b border-accent-dim text-xs sm:text-[10px] uppercase tracking-[0.2em] text-body-very-dim">
        {/* In 'lumps' mode this column holds the net score, not a row
            number, so '#' would be actively misleading. */}
        <span className="bg-bg">{countMode === 'lumps' ? 'Net' : '#'}</span>
        <span className="bg-bg">Title</span>
        <span className="bg-bg">{hideArtist ? '' : 'Artist'}</span>
        <span className="bg-bg">Genre</span>
        <span className="bg-bg text-right">Time</span>
        <span className="bg-bg text-center">Lumps</span>
        <span className="bg-bg text-center">Lump</span>
      </div>
      {tracks.map((t, i) => (
        <TrackCard
          key={t.id}
          track={t}
          queue={tracks}
          index={i}
          countMode={countMode}
          shuffleSource={shuffleSource}
          hideArtist={hideArtist}
        />
      ))}
      {hasMore && (
        <div
          ref={sentinelRef}
          className="px-4 py-6 text-center text-body-very-dim text-xs sm:text-[10px] uppercase tracking-[0.25em]"
        >
          {loading ? 'loading more…' : ''}
        </div>
      )}
    </div>
  );
}
