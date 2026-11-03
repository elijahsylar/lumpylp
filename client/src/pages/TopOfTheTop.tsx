import { useEffect, useRef, useState, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { Track } from '../types/track';
import { TrackList } from '../components/TrackList';
import { PageHeader, SectionTitle } from '../components/PageHeader';

type Window = 'today' | 'week' | 'month' | 'all';

const WINDOW_OPTIONS: { value: Window; label: string }[] = [
  { value: 'today', label: 'today' },
  { value: 'week',  label: 'this week' },
  { value: 'month', label: 'this month' },
  { value: 'all',   label: 'all time' },
];

const WINDOW_SUBTITLE: Record<Window, string> = {
  today: 'most lumped today',
  week:  'most lumped this week',
  month: 'most lumped this month',
  all:   'most lumped of all time',
};

function isValidWindow(s: string | null): s is Window {
  return s === 'today' || s === 'week' || s === 'month' || s === 'all';
}

interface TrackWithWindow extends Track {
  window_net?: number | string;
}

export function TopOfTheTop() {
  const [params, setParams] = useSearchParams();
  const win: Window = isValidWindow(params.get('window')) ? (params.get('window') as Window) : 'all';

  const [tracks, setTracks] = useState<TrackWithWindow[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  const inflightRef = useRef(false);
  const reqIdRef = useRef(0);

  const hasMore = tracks.length < total;

  const fetchPage = useCallback(async (targetPage: number, append: boolean) => {
    if (inflightRef.current) return;
    const myId = ++reqIdRef.current;
    inflightRef.current = true;
    setLoading(true);
    try {
      const sp = new URLSearchParams({ window: win, page: String(targetPage) });
      const res = await fetch(`/api/tracks/top?${sp.toString()}`);
      const data = await res.json();
      if (reqIdRef.current !== myId) return;
      const next: TrackWithWindow[] = data.tracks || [];
      setTotal(data.total || 0);
      setPage(targetPage);
      setTracks((prev) => (append ? [...prev, ...next] : next));
    } catch {
      /* ignore */
    } finally {
      if (reqIdRef.current === myId) {
        inflightRef.current = false;
        setLoading(false);
      }
    }
  }, [win]);

  useEffect(() => {
    reqIdRef.current++;
    inflightRef.current = false;
    setTracks([]);
    setPage(1);
    setTotal(0);
    fetchPage(1, false);
  }, [win, fetchPage]);

  const loadMore = useCallback(() => {
    if (!hasMore) return;
    fetchPage(page + 1, true);
  }, [hasMore, page, fetchPage]);

  const setWindow = (next: Window) => {
    const np = new URLSearchParams(params);
    np.set('window', next);
    setParams(np, { replace: true });
  };

  // For windowed views the API returns per-window vote totals as `window_net`.
  // Override each track's net_lumps for the heap-mode # column display so the
  // column reflects the active window, while the all-time count still appears
  // beside it for context.
  const displayTracks: TrackWithWindow[] = tracks.map((t) => {
    const winNet = typeof t.window_net === 'string' ? parseInt(t.window_net, 10) : (t.window_net ?? 0);
    return win === 'all' ? t : { ...t, net_lumps: Number.isFinite(winNet) ? winNet : 0 };
  });

  return (
    <div className="flex-1 overflow-y-auto">
      <PageHeader>
        <SectionTitle label="top of the top" />
        <p className="text-xs text-body-dim mt-1 uppercase tracking-wider">
          {WINDOW_SUBTITLE[win]} · {total.toLocaleString()} tracks
        </p>
      </PageHeader>

      <section className="px-4 sm:px-6 pb-6 bg-bg">
        <div className="scroll-strip flex flex-nowrap sm:flex-wrap gap-2 mb-4
                        overflow-x-auto sm:overflow-x-visible
                        -mx-4 px-4 sm:mx-0 sm:px-0 pb-1 sm:pb-0">
          {WINDOW_OPTIONS.map((w) => {
            const active = win === w.value;
            return (
              <button
                key={w.value}
                onClick={() => setWindow(w.value)}
                aria-pressed={active}
                className={`shrink-0 whitespace-nowrap h-11 sm:h-7 px-4 sm:px-3 text-xs sm:text-[10px] uppercase tracking-[0.2em] border transition-colors ${
                  active
                    ? 'bg-accent text-bg border-accent'
                    : 'border-accent-dim text-accent hover:border-accent-bright hover:text-accent-bright'
                }`}
              >
                {w.label}
              </button>
            );
          })}
        </div>

        {tracks.length === 0 && !loading ? (
          <div className="border border-accent-dim p-4 sm:p-6 text-body-very-dim text-sm uppercase tracking-wider">
            no votes yet in this window
          </div>
        ) : (
          <div className="border border-accent-dim p-3">
            <TrackList
              tracks={displayTracks}
              loading={loading}
              hasMore={hasMore}
              loadMore={loadMore}
              countMode="lumps"
            />
          </div>
        )}
      </section>
    </div>
  );
}
