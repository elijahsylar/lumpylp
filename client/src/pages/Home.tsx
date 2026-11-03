import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Play } from 'lucide-react';
import { useTracks, type TrackSort } from '../hooks/useTracks';
import { TrackList } from '../components/TrackList';
import { PageHeader, SectionTitle } from '../components/PageHeader';
import { SortTabs } from '../components/SortTabs';
import { usePlayer } from '../hooks/usePlayer';
import type { ShuffleSource } from '../hooks/usePlayer';
import { useAuth } from '../lib/auth';
import { useCatalogTotal, formatCatalogTotal } from '../hooks/useCatalogTotal';
import type { Track } from '../types/track';

function SignupCTA() {
  return (
    <aside
      aria-label="sign up to lump"
      className="mx-4 sm:mx-6 mb-4 sm:mb-6 mt-2 px-4 sm:px-6 py-5 sm:py-7 border border-accent-bright bg-accent-dim/10 text-center bg-bg"
    >
      <p className="text-base text-accent-bright leading-relaxed">
        Free to listen — sign up to lump.
      </p>
      <p className="text-xs text-body-dim uppercase tracking-[0.2em] mt-2">
        Accounts are free. They&rsquo;re for lumping and playlists.
      </p>
      <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
        <Link
          to="/login"
          className="h-11 sm:h-9 px-5 leading-[2.75rem] sm:leading-9 border border-accent bg-accent text-bg uppercase text-xs sm:text-[10px] tracking-[0.25em]
                     hover:bg-accent-bright hover:border-accent-bright transition-colors"
        >
          sign up
        </Link>
        <Link
          to="/about"
          className="inline-flex items-center justify-center min-h-[44px] md:min-h-[24px] h-11 sm:h-9 px-3 leading-[2.75rem] sm:leading-9
                     text-xs sm:text-[10px] uppercase tracking-[0.25em] text-accent-dim hover:text-accent-bright transition-colors"
        >
          what is lumpylp? →
        </Link>
      </div>
    </aside>
  );
}

interface Props { genre: string | null; }

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return 'late night, listener';
  if (h < 12) return 'morning, listener';
  if (h < 17) return 'afternoon, listener';
  if (h < 21) return 'evening, listener';
  return 'night, listener';
}

function isValidSort(s: string | null): s is TrackSort {
  return s === 'heap' || s === 'fresh' || s === 'alpha';
}

function FeaturedTop() {
  const [track, setTrack] = useState<Track | null>(null);
  const [loaded, setLoaded] = useState(false);
  const player = usePlayer();

  useEffect(() => {
    fetch('/api/tracks/top?window=all&page=1')
      .then((r) => r.json())
      .then((d) => {
        const t = (d.tracks || [])[0] as Track | undefined;
        setTrack(t || null);
      })
      .catch(() => setTrack(null))
      .finally(() => setLoaded(true));
  }, []);

  if (!loaded) return null;

  if (!track) {
    return (
      <div className="border border-accent-dim p-4 sm:p-6 mb-6 text-center">
        <p className="text-sm text-body-dim mb-3">no top of the top yet</p>
        <p className="text-xs sm:text-[11px] text-body-very-dim uppercase tracking-[0.2em] mb-4">
          start lumping things up
        </p>
        <Link
          to="/genres"
          className="inline-block h-11 sm:h-9 px-4 leading-[2.75rem] sm:leading-9 border border-accent text-accent uppercase text-xs sm:text-[10px] tracking-[0.25em] hover:border-accent-bright hover:text-accent-bright transition-colors"
        >
          browse genres
        </Link>
      </div>
    );
  }

  const net = track.net_lumps ?? 0;

  return (
    <div className="border border-accent bg-bg p-4 sm:p-5 mb-4 sm:mb-6 flex flex-col md:flex-row gap-4 sm:gap-5 items-center">
      {track.artwork_url ? (
        <img
          src={track.artwork_url}
          alt=""
          className="w-32 h-32 object-cover border border-accent-dim shrink-0"
          draggable={false}
        />
      ) : (
        <div className="w-32 h-32 border border-accent-dim flex items-center justify-center text-accent-dim text-xl tracking-widest shrink-0">
          LP
        </div>
      )}
      <div className="flex-1 min-w-0 w-full">
        <div className="text-xs sm:text-[10px] uppercase tracking-[0.25em] text-accent mb-1">
          top of the top right now
        </div>
        <h3 className="text-xl text-white truncate">{track.title}</h3>
        <p className="text-sm text-accent truncate">{track.artist_name}</p>
        {track.genre && (
          <span className="inline-block text-xs sm:text-[10px] mt-2 px-2 py-0.5 border border-accent-dim text-accent-dim uppercase tracking-[0.2em]">
            {track.genre}
          </span>
        )}
        <div className="flex flex-wrap items-center gap-3 mt-3">
          <span className="font-display text-3xl leading-none text-accent-bright tabular-nums">
            {net > 0 ? '+' : ''}{net}
          </span>
          <span className="text-xs sm:text-[10px] uppercase tracking-[0.25em] text-body-very-dim">
            net lumps
          </span>
        </div>
        <div className="flex flex-wrap gap-2 mt-4">
          <button
            onClick={() => player.load(track, [track])}
            className="h-11 sm:h-9 px-4 flex items-center gap-2 border border-accent text-accent uppercase text-xs sm:text-[10px] tracking-[0.25em] hover:border-accent-bright hover:text-accent-bright transition-colors"
          >
            <Play size={14} strokeWidth={1.75} />
            play this
          </button>
          <Link
            to="/top"
            className="h-11 sm:h-9 px-4 leading-[2.75rem] sm:leading-9 text-xs sm:text-[10px] uppercase tracking-[0.25em] text-accent-dim hover:text-accent-bright transition-colors"
          >
            see the full top of the top →
          </Link>
        </div>
      </div>
    </div>
  );
}

export function Home({ genre }: Props) {
  const [params, setParams] = useSearchParams();
  const sortFromUrl = params.get('sort');
  const defaultSort: TrackSort = genre ? 'heap' : 'fresh';
  const sort: TrackSort = isValidSort(sortFromUrl) ? sortFromUrl : defaultSort;
  const { user } = useAuth();

  const { tracks, total, loading, hasMore, loadMore } = useTracks({ genre, sort });

  // The hero line counts the whole catalog, not the current genre slice, so
  // it comes from /api/stats rather than the filtered track fetch. That also
  // stops it rendering "0 tracks indexed" for the ~1s the track query takes.
  const catalogTotal = useCatalogTotal();

  // Phase 18.0: when a genre filter is active, click-to-play seeds the player
  // with a filter-source shuffle pool — toggling shuffle then draws from the
  // full ~66k Electronic catalog (or whatever genre), not just the loaded
  // scroll subset. Home-unfiltered stays array-source pending the random_seed
  // perf work in phase18.1.
  const shuffleSource: ShuffleSource | undefined = genre ? { kind: 'filter', genre } : undefined;

  const setSort = (next: TrackSort) => {
    const np = new URLSearchParams(params);
    np.set('sort', next);
    setParams(np, { replace: true });
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <PageHeader>
        {genre ? (
          <>
            <SectionTitle label={genre} />
            <p className="text-xs text-body-dim mt-1 uppercase tracking-wider">
              {loading && total === 0 ? 'counting…' : `${total.toLocaleString()} tracks`}
              {' · curated from open music archives'}
            </p>
          </>
        ) : null}
      </PageHeader>

      {!user && <SignupCTA />}

      {!genre && (
        <div className="px-4 sm:px-6 bg-bg">
          <div className="flex flex-col items-center py-4 sm:py-6">
            <img
              src="/lumpylp-logo.png"
              alt="LumpyLP"
              className="w-40 sm:w-56 h-auto mb-3 sm:mb-4 select-none"
              draggable={false}
            />
            <p className="text-accent italic text-sm">{greeting()}</p>
            <p className="text-body-dim text-xs uppercase tracking-[0.25em] mt-2">
              {catalogTotal === null ? (
                <span
                  className="inline-block align-middle w-24 h-3 bg-body-very-dim/20 animate-pulse-soft"
                  aria-label="counting tracks"
                />
              ) : (
                formatCatalogTotal(catalogTotal)
              )}{' '}
              tracks indexed · curated from open music archives
            </p>
          </div>
          <FeaturedTop />
        </div>
      )}

      <section className="px-4 sm:px-6 pb-6 bg-bg">
        <div className="mb-3">
          <SectionTitle label="tracks" size="md" />
        </div>
        <SortTabs active={sort} onChange={setSort} />
        <div className="border border-accent-dim p-3">
          <TrackList
            tracks={tracks}
            loading={loading}
            hasMore={hasMore}
            loadMore={loadMore}
            countMode={sort === 'heap' ? 'lumps' : 'index'}
            shuffleSource={shuffleSource}
          />
        </div>
      </section>
    </div>
  );
}
