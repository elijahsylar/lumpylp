import { useEffect, useState } from 'react';

/**
 * The catalog-wide track count — one source of truth for every "N tracks"
 * string in the UI.
 *
 * Before this existed there were three separate numbers: a hardcoded
 * "search 40,000 tracks…" placeholder, a hardcoded "400,000+ tracks" line
 * on the About page, and Home's live (genre-filtered) count. All three
 * disagreed with each other and with the database.
 *
 * The fetch is shared across every caller via a module-level promise, so
 * mounting five components that all want the number costs one request per
 * page load. The server caches the underlying COUNT(*) as well.
 */
let cached: number | null = null;
let inflight: Promise<number> | null = null;

function load(): Promise<number> {
  if (cached !== null) return Promise.resolve(cached);
  if (!inflight) {
    inflight = fetch('/api/stats')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => {
        cached = Number(d?.tracks) || 0;
        return cached;
      })
      .catch(() => 0)
      .finally(() => { inflight = null; });
  }
  return inflight;
}

/**
 * Returns null until the count is known. Callers should render a neutral
 * placeholder for null rather than `0` — showing "0 tracks indexed" while
 * a request is in flight reads as "the archive is empty".
 */
export function useCatalogTotal(): number | null {
  const [total, setTotal] = useState<number | null>(cached);

  useEffect(() => {
    if (cached !== null) { setTotal(cached); return; }
    let alive = true;
    load().then((n) => { if (alive) setTotal(n); });
    return () => { alive = false; };
  }, []);

  return total;
}

/** Formatted for display, with a stable-width placeholder while loading. */
export function formatCatalogTotal(total: number | null): string {
  return total === null ? '…' : total.toLocaleString();
}
