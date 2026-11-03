import { useEffect, useState } from 'react';

// Public site config from /api/config, fetched once per page load.
export interface SiteConfig {
  /** Voluntary-support Stripe Payment Link. Unlocks nothing. */
  support_url: string | null;
  turnstile_site_key: string | null;
}

const EMPTY: SiteConfig = { support_url: null, turnstile_site_key: null };
let cached: Promise<SiteConfig> | null = null;

function load(): Promise<SiteConfig> {
  if (!cached) {
    // A failed or non-OK response (e.g. a 429) is not cached, so the next
    // component that asks retries instead of keeping signup broken (review R18).
    cached = fetch('/api/config')
      .then((r) => {
        if (!r.ok) { cached = null; return EMPTY; }
        return r.json();
      })
      .catch(() => { cached = null; return EMPTY; });
  }
  return cached;
}

export function useSiteConfig(): SiteConfig {
  const [cfg, setCfg] = useState<SiteConfig>(EMPTY);
  useEffect(() => {
    let alive = true;
    load().then((c) => { if (alive) setCfg(c); });
    return () => { alive = false; };
  }, []);
  return cfg;
}
