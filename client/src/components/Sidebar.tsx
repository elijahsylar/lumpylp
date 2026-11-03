import { useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { useGenres } from '../hooks/useTracks';
import { SectionTitle } from './PageHeader';
import { useAuth } from '../lib/auth';
import { api } from '../lib/api';
import { LumpFormModal } from './LumpFormModal';
import { useSiteConfig } from '../lib/config';
import type { UserLump } from '../types/lump';

interface Props {
  selectedGenre: string | null;
  onGenreSelect: (g: string | null) => void;
  /** Mobile drawer state. Ignored at md+ where sidebar is permanent. */
  open?: boolean;
  onClose?: () => void;
}

const NAV = [
  { to: '/', label: 'Home' },
  { to: '/search', label: 'Search' },
  { to: '/top', label: 'Top of the Top' },
  { to: '/discover', label: 'Discover' },
  { to: '/genres', label: 'Genres' },
  { to: '/artists', label: 'Artists' },
];

export function Sidebar({ selectedGenre, onGenreSelect, open = false, onClose }: Props) {
  const genres = useGenres();
  const { user, logout } = useAuth();
  const location = useLocation();
  const [lumps, setLumps] = useState<UserLump[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const { support_url: supportUrl } = useSiteConfig();

  // Refetch lumps when login state or path changes (so navigation back from
  // /lumps after creating one keeps the sidebar fresh).
  useEffect(() => {
    if (!user) { setLumps([]); return; }
    api<{ lumps: UserLump[] }>('/api/lumps')
      .then((d) => setLumps(d.lumps || []))
      .catch(() => { /* ignore */ });
  }, [user, location.pathname]);

  // Close drawer on Escape (mobile only — at md+ the drawer doesn't exist).
  useEffect(() => {
    if (!open || !onClose) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const onLumpCreated = (l: UserLump) => {
    setLumps((prev) => [{ ...l, track_count: l.track_count ?? 0 }, ...prev]);
  };

  // Close drawer on any nav-link tap (mobile). NavLinks are everywhere
  // throughout the sidebar; intercepting at the wrapper avoids duplicating
  // onClick on each one.
  const onLinkClick = () => {
    if (open && onClose) onClose();
  };

  return (
    <>
      {/* Backdrop — mobile only, only when open */}
      {open && (
        <div
          className="md:hidden fixed inset-0 z-30 bg-black/70"
          onClick={onClose}
          aria-hidden="true"
        />
      )}
    <aside
      id="sidebar"
      aria-label="sidebar"
      onClick={(e) => {
        // Close drawer when a link inside is tapped (mobile).
        const target = e.target as HTMLElement;
        if (target.closest('a')) onLinkClick();
      }}
      className={`flex flex-col bg-bg border-border w-60 shrink-0 border-r overflow-hidden min-h-0
                  max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-40
                  max-md:w-[min(20rem,92vw)]
                  max-md:pt-safe-t max-md:pb-safe-b max-md:pl-safe-l
                  max-md:transition-transform max-md:duration-200
                  ${open ? 'max-md:translate-x-0' : 'max-md:-translate-x-full'}
                  `}>
      <div className="px-5 py-3 md:py-6 border-b border-accent-dim bg-bg shrink-0">
        <img
          src="/lumpylp-logo.png"
          alt="LumpyLP"
          className="w-full max-w-[84px] md:max-w-[140px] mx-auto mb-2 md:mb-3 select-none"
          draggable={false}
        />
        <h1 className="text-2xl md:text-[32px] leading-none font-display tracking-[-0.02em] text-center">
          <span className="text-white">Lumpy</span>
          <span className="text-accent-bright">LP</span>
        </h1>
        <p className="text-xs sm:text-[11px] md:text-[10px] mt-2 md:mt-3 uppercase tracking-[0.25em] font-mono text-accent-dim text-center">
          free underground
        </p>
      </div>

      {/* Scrollable middle. Without this, the navigation block gets clipped
          when the viewport is short (e.g. logo + lumps + 7 NAV items +
          genres header + footer don't fit), hiding Artists
          behind the player. */}
      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col">

      <div className="px-5 py-3 border-b border-accent-dim bg-bg">
        {user ? (
          <div className="flex flex-col items-start gap-1">
            <span className="text-xs sm:text-[11px] text-accent uppercase tracking-[0.25em] font-mono truncate w-full">
              {user.username}
            </span>
            <button
              onClick={logout}
              className="flex items-center min-h-[44px] md:min-h-[24px] text-xs md:text-[9px] text-accent-dim uppercase tracking-[0.25em] hover:text-accent-bright transition-colors"
            >
              log out
            </button>
            <NavLink
              to="/settings"
              className="flex items-center min-h-[44px] md:min-h-[24px] text-xs md:text-[9px] text-accent-dim uppercase tracking-[0.25em] hover:text-accent-bright transition-colors"
            >
              settings
            </NavLink>
          </div>
        ) : (
          <NavLink
            to="/login"
            className="flex items-center min-h-[44px] md:min-h-0 text-sm md:text-[11px] uppercase tracking-[0.25em] text-accent-bright hover:underline"
          >
            log in / sign up
          </NavLink>
        )}
      </div>

      {user && (
        <>
          <div className="px-5 pt-4 pb-2 flex items-center justify-between bg-bg">
            <SectionTitle label="your lumps" size="sm" />
            <button
              onClick={() => setCreateOpen(true)}
              title="new lump"
              aria-label="new lump"
              className="min-w-[44px] min-h-[44px] md:min-w-[24px] md:min-h-[24px] flex items-center justify-center text-accent-dim hover:text-accent-bright transition-colors"
            >
              <Plus size={14} strokeWidth={2} />
            </button>
          </div>
          <div className="flex flex-col pb-2 bg-bg">
            {lumps.length === 0 && (
              <span className="px-5 text-xs sm:text-[10px] text-body-very-dim uppercase tracking-[0.2em]">
                none yet
              </span>
            )}
            {lumps.slice(0, 5).map((l) => (
              <NavLink
                key={l.id}
                to={`/lumps/${l.id}`}
                className={({ isActive }) =>
                  `flex items-center justify-between min-h-[44px] md:min-h-0 pl-5 pr-3 py-1 text-sm md:text-xs border-l-2 transition-colors ${
                    isActive
                      ? 'text-accent-bright border-accent bg-accent/5'
                      : 'text-body-dim border-transparent hover:text-accent hover:border-accent/40'
                  }`
                }
              >
                <span className="truncate">{l.name}</span>
                <span className="text-body-very-dim tabular-nums shrink-0 ml-2">{l.track_count}</span>
              </NavLink>
            ))}
            {lumps.length > 5 && (
              <NavLink
                to="/lumps"
                className="flex items-center min-h-[44px] md:min-h-0 px-5 py-1 text-xs md:text-[10px] uppercase tracking-[0.2em] text-accent-dim hover:text-accent-bright"
              >
                view all ({lumps.length})
              </NavLink>
            )}
            {lumps.length > 0 && lumps.length <= 5 && (
              <NavLink
                to="/lumps"
                className="flex items-center min-h-[44px] md:min-h-0 px-5 py-1 text-xs md:text-[10px] uppercase tracking-[0.2em] text-accent-dim hover:text-accent-bright"
              >
                view all
              </NavLink>
            )}
          </div>
        </>
      )}

      <div className="px-5 pt-4 pb-2 border-t border-accent-dim bg-bg">
        <SectionTitle label="navigation" size="sm" />
      </div>
      <nav aria-label="main" className="flex flex-col pb-3 bg-bg">
        {NAV.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.to === '/'}
            className={({ isActive }) =>
              `flex items-center min-h-[44px] md:min-h-0 pl-5 pr-4 py-2 text-sm uppercase tracking-wider border-l-2 transition-colors ${
                isActive
                  ? 'text-accent-bright border-accent bg-accent/5'
                  : 'text-body border-transparent hover:text-accent hover:bg-accent/5 hover:border-accent/40'
              }`
            }
          >
            {n.label}
          </NavLink>
        ))}
      </nav>

      <div className="px-5 pt-4 pb-2 border-t border-accent-dim mt-2 bg-bg">
        <SectionTitle label="genres" size="sm" />
      </div>
      <nav aria-label="genres" className="pb-4 bg-bg">
        <button
          onClick={() => onGenreSelect(null)}
          className={`w-full flex items-center min-h-[44px] md:min-h-0 text-left pl-5 pr-3 py-1 text-sm md:text-xs border-l-2 transition-colors ${
            !selectedGenre
              ? 'text-accent-bright border-accent bg-accent/5'
              : 'text-body-dim border-transparent hover:text-accent hover:border-accent/40'
          }`}
        >
          all
        </button>
        {genres.map((g) => (
          <button
            key={g.id}
            onClick={() => onGenreSelect(g.name)}
            className={`w-full flex items-center justify-between min-h-[44px] md:min-h-0 pl-5 pr-3 py-1 text-sm md:text-xs border-l-2 transition-colors ${
              selectedGenre === g.name
                ? 'text-accent-bright border-accent bg-accent/5'
                : 'text-body-dim border-transparent hover:text-accent hover:border-accent/40'
            }`}
          >
            <span className="truncate uppercase tracking-wider">{g.name}</span>
            <span className="text-body-very-dim tabular-nums">{g.track_count}</span>
          </button>
        ))}
      </nav>

      </div>

      <div className="px-5 py-2 border-t border-accent-dim shrink-0 flex flex-col bg-bg">
        <NavLink
          to="/about"
          className="flex items-center min-h-[44px] md:min-h-[24px] text-xs md:text-[10px] uppercase tracking-[0.25em] text-accent-dim hover:text-accent-bright transition-colors"
        >
          about
        </NavLink>
        <NavLink
          to="/accessibility"
          className="flex items-center min-h-[44px] md:min-h-[24px] text-xs md:text-[10px] uppercase tracking-[0.25em] text-accent-dim hover:text-accent-bright transition-colors"
        >
          accessibility
        </NavLink>
        {supportUrl && (
          // Voluntary support (a Stripe Payment Link). It unlocks nothing.
          <a
            href={supportUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center min-h-[44px] md:min-h-[24px] text-xs md:text-[10px] uppercase tracking-[0.25em] text-accent-dim hover:text-accent-bright transition-colors"
          >
            support lumpylp
          </a>
        )}
      </div>

      <LumpFormModal
        open={createOpen}
        mode="create"
        onClose={() => setCreateOpen(false)}
        onSaved={onLumpCreated}
      />
    </aside>
    </>
  );
}
