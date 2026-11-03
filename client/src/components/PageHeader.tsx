import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useCatalogTotal } from '../hooks/useCatalogTotal';
import { useAuth } from '../lib/auth';
import { api } from '../lib/api';
import { announce } from '../lib/announce';
import {
  THEMES,
  applyTheme,
  setStoredTheme,
  getStoredTheme,
  isValidTheme,
  type ThemeName,
} from '../lib/theme';

function formatClock(d: Date): string {
  const dow = d.toLocaleString('en-US', { weekday: 'short' }).toUpperCase();
  const mon = d.toLocaleString('en-US', { month: 'short' }).toUpperCase();
  const day = d.getDate();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const tz =
    d.toLocaleString('en-US', { timeZoneName: 'short' }).split(' ').pop() || '';
  return `${dow}, ${mon} ${day} :: ${hh}:${mm}:${ss} ${tz}`;
}

function Clock() {
  const [t, setT] = useState(() => formatClock(new Date()));
  useEffect(() => {
    const id = setInterval(() => setT(formatClock(new Date())), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <span className="text-xs sm:text-[10px] text-accent-dim tabular-nums tracking-wider whitespace-nowrap">
      {t}
    </span>
  );
}

// Compact theme switcher — one dot per theme, available to everyone. The
// full picker with descriptions and previews stays on /settings. Anonymous
// visitors get localStorage persistence; signed-in users also sync the
// choice to their account so it follows them across devices.
function ThemeSwitcher() {
  const { user, updateTheme } = useAuth();

  // Seed from the DOM, not from auth state: the inline script in index.html
  // applies the stored theme pre-paint, so <html data-theme> is already
  // correct by the time this mounts.
  const [active, setActive] = useState<ThemeName>(() => {
    const attr =
      typeof document !== 'undefined'
        ? document.documentElement.getAttribute('data-theme')
        : null;
    return isValidTheme(attr) ? attr : getStoredTheme();
  });

  // ThemeSync re-applies the theme once /api/auth/me resolves, which lands
  // after this mounts and may differ from localStorage (a signed-in user on
  // a new device). Watch the attribute rather than duplicating that logic.
  useEffect(() => {
    const el = document.documentElement;
    const obs = new MutationObserver(() => {
      const attr = el.getAttribute('data-theme');
      if (isValidTheme(attr)) setActive(attr);
    });
    obs.observe(el, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, []);

  const onPick = (name: ThemeName) => {
    if (name === active) return;
    // localStorage is the source of truth for this control: apply straight
    // away and don't roll back if the server sync fails — the choice still
    // holds on this device, and /settings resyncs on next load.
    applyTheme(name);
    setStoredTheme(name);
    setActive(name);
    announce(`theme changed to ${THEMES.find((t) => t.name === name)?.label || name}`);
    if (user) {
      updateTheme(name);
      api('/api/auth/me/theme', { method: 'PATCH', json: { theme: name } }).catch(() => {
        /* local choice stands */
      });
    }
  };

  return (
    <div
      role="radiogroup"
      aria-label="theme"
      className="flex items-center gap-0 sm:gap-1.5"
    >
      {/* Spacing lives on the label, not the container gap — raising the
          gap would also push the dots apart from each other. mr-1.5 plus
          the container's 6px reads as a 12px separation. */}
      <span className="hidden sm:block mr-1.5 text-[10px] uppercase tracking-[0.2em] text-accent-dim">
        Choose your style.
      </span>
      {THEMES.map((t) => {
        const on = t.name === active;
        return (
          <button
            key={t.name}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={t.label}
            title={t.label}
            onClick={() => onPick(t.name)}
            // 36x36 hit area on touch, collapsing to the bare dot at sm+
            // where a mouse makes the padding unnecessary. Sized directly
            // rather than via .tap-target: five adjacent overlays would
            // overlap and steal each other's taps. Height is auto at sm+ so
            // the pip below the dot isn't clipped.
            className="w-9 h-9 sm:w-3 sm:h-auto flex flex-col items-center justify-center gap-1 shrink-0"
          >
            <span
              aria-hidden="true"
              className="block w-3 h-3 rounded-full border border-accent-dim"
              style={{ background: t.swatches.accent }}
            />
            {/* Active indicator. A ring failed on underground/highcontrast —
                a green ring on a green dot is invisible. The pip sits below
                the dot in the theme's own accent-bright, so it reads against
                the header background rather than against the swatch. Always
                rendered (transparent when inactive) so every button reserves
                the same height and the dots stay on one line. */}
            <span
              aria-hidden="true"
              className={`block w-1 h-0.5 ${on ? 'bg-accent-bright' : 'bg-transparent'}`}
            />
          </button>
        );
      })}
    </div>
  );
}

function SearchBar() {
  const navigate = useNavigate();
  const location = useLocation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [pulse, setPulse] = useState(false);
  const catalogTotal = useCatalogTotal();

  // Initial value pulled from URL ?q= so refreshing /search keeps the term.
  const initial = new URLSearchParams(location.search).get('q') || '';
  const [q, setQ] = useState(initial);

  // Debounced navigate when user types. Replace history when already on
  // /search so back-button still leaves the search rather than walking
  // through every keystroke.
  useEffect(() => {
    if (!q.trim()) return;
    const id = setTimeout(() => {
      const path = `/search?q=${encodeURIComponent(q)}`;
      navigate(path, { replace: location.pathname === '/search' });
    }, 300);
    return () => clearTimeout(id);
    // Intentionally only react to user edits (`q`), not to URL changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  // Sync from URL when navigating between pages (e.g., user clicks a sidebar
  // link that changes pathname). Clears the box when leaving /search.
  useEffect(() => {
    if (location.pathname !== '/search') {
      if (q) setQ('');
      return;
    }
    const urlQ = new URLSearchParams(location.search).get('q') || '';
    if (urlQ !== q) setQ(urlQ);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname, location.search]);

  // Cmd/Ctrl+K → focus + brief border pulse.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
        setPulse(true);
        setTimeout(() => setPulse(false), 200);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="mt-3 flex items-center gap-2">
      <input
        ref={inputRef}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        type="search"
        aria-label="search tracks"
        placeholder={
          catalogTotal === null
            ? 'search the catalog…  ⌘K'
            : `search ${catalogTotal.toLocaleString()} tracks…  ⌘K`
        }
        className={`flex-1 h-11 sm:h-9 bg-bg border outline-none font-mono text-base sm:text-sm
                    px-3 text-body placeholder:text-body-very-dim
                    transition-colors duration-150
                    ${pulse
                      ? 'border-accent-bright'
                      : 'border-accent-dim focus:border-accent'}`}
      />
    </div>
  );
}

export function PageHeader({ children }: { children: ReactNode }) {
  return (
    <header
      className="px-4 md:px-6 pt-3 md:pt-5 pb-3 md:pb-5 border-b border-accent-dim mb-3 md:mb-4 bg-bg
                 max-md:pt-[calc(0.75rem+env(safe-area-inset-top))]
                 max-md:pl-[calc(3.75rem+env(safe-area-inset-left))]
                 max-md:pr-[calc(1rem+env(safe-area-inset-right))]"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">{children}</div>
        <div className="flex items-center gap-2 sm:gap-3 shrink-0">
          <ThemeSwitcher />
          {/* Separator — only meaningful once the clock is showing. */}
          <div className="hidden sm:block w-px h-4 bg-accent-dim" aria-hidden="true" />
          {/* Hide the clock on narrow screens — saves space and the date is
              available via OS chrome anyway. */}
          <div className="hidden sm:block"><Clock /></div>
        </div>
      </div>
      <SearchBar />
    </header>
  );
}

// Section title — uppercase accent, wider tracking. No prefixes, just the label.
export function SectionTitle({
  label,
  size = 'lg',
}: {
  label: string;
  size?: 'lg' | 'md' | 'sm';
}) {
  // Mobile floors each step one size up — 10px section labels are the
  // single most common unreadable element on a phone. `break-words` stops
  // long labels (an artist name, a search term) from forcing overflow;
  // headings wrap rather than truncate.
  const sz =
    size === 'lg'
      ? 'text-lg'
      : size === 'md'
        ? 'text-sm md:text-xs'
        : 'text-xs md:text-[10px]';
  return (
    <h2 className={`${sz} uppercase tracking-[0.2em] font-medium text-accent break-words`}>
      {label}
    </h2>
  );
}
