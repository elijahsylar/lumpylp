import { Link } from 'react-router-dom';
import { PageHeader, SectionTitle } from '../components/PageHeader';

/**
 * Catch-all for unmatched routes. Without this the router rendered nothing
 * at all for an unknown URL — a completely blank page with no explanation,
 * which reads as a crash.
 *
 * Uses the same PageHeader/theme tokens as every other page, so it inherits
 * whichever theme is active.
 */
export function NotFound() {
  return (
    <div className="flex-1 overflow-y-auto">
      <PageHeader>
        <SectionTitle label="404" />
        <p className="text-xs text-body-dim mt-1 uppercase tracking-wider">
          that page isn&rsquo;t here
        </p>
      </PageHeader>

      <section className="px-4 sm:px-6 pb-6 bg-bg">
        <div className="border border-accent-dim p-4 sm:p-6">
          <p className="text-body text-sm">
            No page matches this address. It may have been renamed, or the
            link that brought you here may be out of date.
          </p>
          <nav className="mt-5 flex flex-wrap gap-x-6 gap-y-2 text-sm">
            <Link to="/" className="text-accent hover:text-accent-bright underline">
              back to home
            </Link>
            <Link to="/search" className="text-accent hover:text-accent-bright underline">
              search the catalog
            </Link>
            <Link to="/genres" className="text-accent hover:text-accent-bright underline">
              browse genres
            </Link>
          </nav>
        </div>
      </section>
    </div>
  );
}
