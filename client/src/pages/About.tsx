import { NavLink } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';
import { useCatalogTotal, formatCatalogTotal } from '../hooks/useCatalogTotal';

export function About() {
  // Was a hardcoded "400,000+". Now the same number the rest of the UI
  // shows, so the About page can't drift away from the actual catalog.
  const catalogTotal = useCatalogTotal();

  return (
    <div className="flex-1 overflow-y-auto">
      <PageHeader>
        <h1 className="text-lg uppercase tracking-[0.2em] font-medium text-accent">
          about lumpylp
        </h1>
        <p className="text-xs text-body-dim mt-1 uppercase tracking-wider">
          a curated archive of free music from across the open internet
        </p>
      </PageHeader>

      <section className="px-4 sm:px-6 pb-16 max-w-2xl mx-auto bg-bg text-center" aria-label="about lumpylp">

        {/* IN DEVELOPMENT NOTE */}
        <p className="mt-6 text-xs sm:text-[10px] uppercase tracking-[0.25em] text-body-very-dim">
          LumpyLP is currently in active development. The catalog grows weekly. Some features may change.
        </p>

        {/* THE LEDE */}
        <div className="my-10 py-10 border-y border-accent-dim">
          <p className="text-xl text-accent-bright leading-relaxed">
            {formatCatalogTotal(catalogTotal)} tracks. Curated from open music archives.
          </p>
          <p className="text-xl text-accent-bright leading-relaxed mt-4">
            Free to stream and browse, no account required.
          </p>
          <p className="text-xl text-accent-bright leading-relaxed mt-4">
            A free account unlocks lumping and playlists.
          </p>
        </div>

        {/* WHAT IT IS */}
        <h2 className="text-accent uppercase tracking-[0.2em] text-xs mt-14 mb-4">
          what it is
        </h2>
        <div className="space-y-5 text-sm text-body leading-relaxed">
          <p>
            LumpyLP indexes music from open archives across the internet.
            Sources include Internet Archive collections (Live Music,
            Netlabels, Cylinders), Wikimedia Commons, ccMixter, Audius,
            Jamendo, the Library of Congress, Audionautix, and Incompetech.
            Each track displays its license. The catalog grows weekly.
          </p>
          <p>
            Browsing and streaming work without an account. Search, genre
            and artist views, geographic discovery, and the community heap
            are all open to anyone with a browser.
          </p>
        </div>

        {/* WHAT AN ACCOUNT UNLOCKS */}
        <h2 className="text-accent uppercase tracking-[0.2em] text-xs mt-14 mb-4">
          what an account unlocks
        </h2>
        <div className="space-y-5 text-sm text-body leading-relaxed">
          <p>
            Accounts are free. Nothing on LumpyLP is ever sold.
          </p>
          <ul className="list-none space-y-3">
            <li>
              <span className="text-accent-bright">Lumping and dumping</span> —
              vote tracks up or down. The most-lumped tracks rise into the
              heap; the most-dumped drop out.
            </li>
            <li>
              <span className="text-accent-bright">Personal playlists</span> —
              build and reorder your own lumps.
            </li>
          </ul>
        </div>

        {/* WHAT WE DON'T DO */}
        <h2 className="text-accent uppercase tracking-[0.2em] text-xs mt-14 mb-4">
          what we don't do
        </h2>
        <ul className="list-none space-y-3 text-sm text-body leading-relaxed">
          <li>Run ads.</li>
          <li>Track users or sell data, including listening history.</li>
          <li>Use AI to generate music or pick what you hear.</li>
          <li>Run a recommendation algorithm. The heap is community votes, nothing else.</li>
          <li>Charge for anything. Every feature is free.</li>
        </ul>

        {/* ACCESSIBILITY */}
        <h2 className="text-accent uppercase tracking-[0.2em] text-xs mt-14 mb-4">
          accessibility
        </h2>
        <div className="space-y-5 text-sm text-body leading-relaxed">
          <p>
            LumpyLP is built to WCAG 2.2 AA. Every page works with screen
            readers (NVDA, VoiceOver), keyboard-only navigation, and
            assistive tech. If something doesn't, that's a bug — file it
            and it gets fixed.
          </p>
          <p>
            <NavLink
              to="/accessibility"
              className="inline-flex items-center justify-center min-h-[44px] md:min-h-[24px] px-2 text-accent-bright underline hover:text-white transition-colors"
            >
              read the full accessibility statement →
            </NavLink>
          </p>
        </div>

        {/* WHO BUILT THIS */}
        <h2 className="text-accent uppercase tracking-[0.2em] text-xs mt-14 mb-4">
          who built this
        </h2>
        <div className="space-y-5 text-sm text-body leading-relaxed">
          <p>
            One person — Elijah Sylar. No startup, no investors, no exit
            strategy. Voluntary support covers the hosting bill; it
            unlocks nothing. The site keeps running as long as people keep
            listening.
          </p>
        </div>

      </section>
    </div>
  );
}
