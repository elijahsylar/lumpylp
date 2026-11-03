import { useEffect, useRef, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageHeader, SectionTitle } from '../components/PageHeader';
import { decodeEntities } from '../lib/text';

interface ArtistRow {
  name: string;
  track_count: number;
  sources: string[];
  top_genres: string[];
}

export function Artists() {
  const navigate = useNavigate();
  const [artists, setArtists] = useState<ArtistRow[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  const inflightRef = useRef(false);
  const reqIdRef = useRef(0);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const hasMore = artists.length < total;

  const fetchPage = useCallback(async (targetPage: number, append: boolean) => {
    if (inflightRef.current) return;
    const myId = ++reqIdRef.current;
    inflightRef.current = true;
    setLoading(true);
    try {
      const res = await fetch(`/api/artists?page=${targetPage}`);
      const data = await res.json();
      if (reqIdRef.current !== myId) return;
      const next: ArtistRow[] = data.artists || [];
      setTotal(data.total || 0);
      setPage(targetPage);
      setArtists((prev) => (append ? [...prev, ...next] : next));
    } catch {
      // ignore — keep current
    } finally {
      if (reqIdRef.current === myId) {
        inflightRef.current = false;
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    fetchPage(1, false);
  }, [fetchPage]);

  const loadMore = useCallback(() => {
    if (!hasMore) return;
    fetchPage(page + 1, true);
  }, [hasMore, page, fetchPage]);

  useEffect(() => {
    if (!hasMore) return;
    const el = sentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) loadMore();
      },
      { rootMargin: '300px' }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [hasMore, loadMore]);

  return (
    <div className="flex-1 overflow-y-auto">
      <PageHeader>
        <SectionTitle label="artists" />
        <p className="text-xs text-body-dim mt-1 uppercase tracking-wider">
          top {total.toLocaleString()} artists by track count
        </p>
      </PageHeader>

      <section className="px-4 sm:px-6 pb-6 bg-bg">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          {artists.map((a) => (
            <button
              key={a.name}
              onClick={() => navigate(`/artists/${encodeURIComponent(a.name)}`)}
              className="group text-left border border-accent-dim bg-bg hover:border-accent-bright
                         hover:bg-accent/5 px-4 py-3 transition-colors cursor-pointer"
            >
              <div className="text-sm text-white break-words line-clamp-2 group-hover:text-accent-bright">
                {decodeEntities(a.name)}
              </div>
              <div className="text-xs sm:text-[11px] text-accent-dim mt-1 uppercase tracking-[0.18em]">
                {a.track_count.toLocaleString()} tracks
              </div>
              {a.top_genres.length > 0 && (
                <div className="text-xs sm:text-[10px] text-accent uppercase tracking-[0.2em] mt-1 mb-2">
                  {a.top_genres.join(' · ')}
                </div>
              )}
              {a.sources.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-2">
                  {a.sources.map((s) => (
                    <span
                      key={s}
                      className="text-xs sm:text-[9px] px-1.5 py-0.5 border border-accent text-accent uppercase tracking-[0.15em]"
                    >
                      {s}
                    </span>
                  ))}
                </div>
              )}
            </button>
          ))}
        </div>

        {loading && artists.length === 0 && (
          <div className="px-2 py-8 text-body-very-dim text-sm uppercase tracking-wider">
            loading…
          </div>
        )}

        {hasMore && (
          <div
            ref={sentinelRef}
            className="px-4 py-6 text-center text-body-very-dim text-xs sm:text-[10px] uppercase tracking-[0.25em]"
          >
            {loading ? 'loading more…' : ''}
          </div>
        )}
      </section>
    </div>
  );
}
