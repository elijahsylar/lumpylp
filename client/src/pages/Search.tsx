import { useEffect, useRef, useState, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { Track } from '../types/track';
import { TrackList } from '../components/TrackList';
import { PageHeader, SectionTitle } from '../components/PageHeader';

interface SourceFilter {
  value: string;
  label: string;
}

/** Shown before /api/sources responds, and if that request fails. */
const ALL_SOURCES: SourceFilter = { value: '', label: 'All Sources' };

const SORT_OPTIONS = [
  { value: 'relevance', label: 'Relevance' },
  { value: 'title_asc', label: 'Title A–Z' },
  { value: 'title_desc', label: 'Title Z–A' },
  { value: 'duration_asc', label: 'Duration ↑' },
  { value: 'duration_desc', label: 'Duration ↓' },
];

export function Search() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') || '';
  const source = params.get('source') || '';
  const sort = params.get('sort') || 'relevance';

  const [tracks, setTracks] = useState<Track[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);

  // Source tabs come from the server's canonical registry rather than a
  // hardcoded list. The old array named a source ('archive') that no row
  // has ever had, and omitted 14 real sources including the largest.
  const [sourceFilters, setSourceFilters] = useState<SourceFilter[]>([ALL_SOURCES]);

  useEffect(() => {
    let alive = true;
    fetch('/api/sources')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => {
        if (!alive) return;
        const list: SourceFilter[] = Array.isArray(d?.sources) ? d.sources : [];
        setSourceFilters([ALL_SOURCES, ...list]);
      })
      .catch(() => { /* keep the All Sources fallback */ });
    return () => { alive = false; };
  }, []);

  const inflightRef = useRef(false);
  const reqIdRef = useRef(0);

  const hasMore = tracks.length < total;

  const fetchPage = useCallback(
    async (targetPage: number, append: boolean) => {
      if (inflightRef.current) return;
      if (!q.trim()) {
        setTracks([]); setTotal(0); setPage(1); setLoading(false);
        return;
      }
      const myId = ++reqIdRef.current;
      inflightRef.current = true;
      setLoading(true);

      try {
        const sp = new URLSearchParams({ q, page: String(targetPage), sort });
        if (source) sp.set('source', source);
        const res = await fetch(`/api/search?${sp.toString()}`);
        const data = await res.json();
        if (reqIdRef.current !== myId) return;
        const newTracks: Track[] = data.tracks || [];
        setTotal(data.total || 0);
        setPage(targetPage);
        setTracks((prev) => (append ? [...prev, ...newTracks] : newTracks));
      } catch {
        // swallow — keep what we have
      } finally {
        if (reqIdRef.current === myId) {
          inflightRef.current = false;
          setLoading(false);
        }
      }
    },
    [q, source, sort]
  );

  // Reset and refetch from page 1 when query, source, or sort changes.
  useEffect(() => {
    reqIdRef.current++;
    inflightRef.current = false;
    setTracks([]);
    setPage(1);
    setTotal(0);
    fetchPage(1, false);
  }, [q, source, sort, fetchPage]);

  const loadMore = useCallback(() => {
    if (!hasMore) return;
    fetchPage(page + 1, true);
  }, [hasMore, page, fetchPage]);

  const setSource = (next: string) => {
    const np = new URLSearchParams(params);
    if (next) np.set('source', next); else np.delete('source');
    setParams(np, { replace: true });
  };
  const setSort = (next: string) => {
    const np = new URLSearchParams(params);
    np.set('sort', next);
    setParams(np, { replace: true });
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <PageHeader>
        <SectionTitle label={q ? `search: ${q}` : 'search'} />
        <p className="text-xs text-body-dim mt-1 uppercase tracking-wider">
          {q ? `${total.toLocaleString()} results` : 'type to search the catalog · ⌘K'}
        </p>
      </PageHeader>

      <section className="px-4 sm:px-6 pb-6 bg-bg">
        {q && (
          <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-center gap-2 mb-4">
            {/* 19 source tabs wrapped into six rows on a phone — ~244px of
                chrome before the first result. Below sm: they become a
                single horizontally-scrolling strip; from sm: up the
                original wrap behaviour returns. The negative margin +
                padding lets the strip bleed to the screen edges so it
                reads as scrollable. */}
            <div
              className="scroll-strip flex flex-nowrap sm:flex-wrap gap-2
                         overflow-x-auto sm:overflow-x-visible
                         -mx-4 px-4 sm:mx-0 sm:px-0 pb-1 sm:pb-0
                         snap-x snap-mandatory sm:snap-none"
            >
              {sourceFilters.map((f) => {
                const active = source === f.value;
                return (
                  <button
                    key={f.value || 'all'}
                    onClick={() => setSource(f.value)}
                    aria-pressed={active}
                    className={`shrink-0 snap-start whitespace-nowrap
                                h-11 sm:h-7 px-4 sm:px-3
                                text-xs sm:text-[10px] uppercase tracking-[0.2em]
                                border transition-colors ${
                      active
                        ? 'bg-accent text-bg border-accent'
                        : 'border-accent-dim text-accent hover:border-accent-bright hover:text-accent-bright'
                    }`}
                  >
                    {f.label}
                  </button>
                );
              })}
            </div>

            <div className="sm:ml-auto flex items-center gap-2">
              <label htmlFor="search-sort" className="text-xs sm:text-[10px] uppercase tracking-[0.2em] text-body-very-dim">sort</label>
              <select
                id="search-sort"
                value={sort}
                onChange={(e) => setSort(e.target.value)}
                className="h-11 sm:h-7 flex-1 sm:flex-none px-3 sm:px-2 text-xs sm:text-[10px] uppercase tracking-[0.2em] bg-bg border border-accent-dim text-accent focus:border-accent outline-none"
              >
                {SORT_OPTIONS.map((s) => (
                  <option key={s.value} value={s.value} className="bg-bg text-accent">
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}

        {q ? (
          tracks.length === 0 && !loading ? (
            <div className="border border-accent-dim p-4 sm:p-6 text-body-very-dim text-sm uppercase tracking-wider">
              no tracks found — try a different search
            </div>
          ) : (
            <div className="border border-accent-dim p-3">
              <TrackList tracks={tracks} loading={loading} hasMore={hasMore} loadMore={loadMore} />
            </div>
          )
        ) : (
          <div className="border border-accent-dim p-4 sm:p-6 text-body-dim text-sm">
            search the catalog by title or artist · use{' '}
            <span className="text-accent">⌘K</span> /{' '}
            <span className="text-accent">Ctrl+K</span> from anywhere
          </div>
        )}
      </section>
    </div>
  );
}
