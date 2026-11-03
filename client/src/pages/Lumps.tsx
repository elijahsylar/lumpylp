import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus, Lock, Globe, AlertCircle } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { api } from '../lib/api';
import { PageHeader, SectionTitle } from '../components/PageHeader';
import { LumpFormModal } from '../components/LumpFormModal';
import type { UserLump } from '../types/lump';

export function Lumps() {
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const [lumps, setLumps] = useState<UserLump[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      navigate('/login?redirect=' + encodeURIComponent('/lumps'), { replace: true });
      return;
    }
    setLoading(true);
    api<{ lumps: UserLump[] }>('/api/lumps')
      .then((d) => setLumps(d.lumps || []))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'failed'))
      .finally(() => setLoading(false));
  }, [user, authLoading, navigate]);

  const onCreated = (lump: UserLump) => {
    setLumps((prev) => [{ ...lump, track_count: lump.track_count ?? 0 }, ...prev]);
  };

  if (!user) return null;

  return (
    <div className="flex-1 overflow-y-auto">
      <PageHeader>
        <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-3 md:gap-4">
          <div>
            <SectionTitle label="your lumps" />
            <p className="text-xs text-body-dim mt-1 uppercase tracking-wider">
              {lumps.length} {lumps.length === 1 ? 'lump' : 'lumps'}
            </p>
          </div>
          <button
            onClick={() => setCreateOpen(true)}
            className="shrink-0 h-11 sm:h-9 px-4 flex items-center gap-2 border border-accent text-accent uppercase text-xs sm:text-[10px] tracking-[0.25em] hover:border-accent-bright hover:text-accent-bright transition-colors"
          >
            <Plus size={14} strokeWidth={1.75} />
            new lump
          </button>
        </div>
      </PageHeader>

      <section className="px-4 sm:px-6 pb-6 bg-bg">
        {error && (
          <div
            role="alert"
            aria-live="assertive"
            className="flex items-center gap-2 text-red-500 text-xs uppercase tracking-wider mb-3"
          >
            <AlertCircle size={14} aria-hidden="true" />
            <span>{error}</span>
          </div>
        )}

        {loading ? (
          <div className="px-2 py-8 text-body-very-dim text-sm uppercase tracking-wider">loading…</div>
        ) : lumps.length === 0 ? (
          <div className="border border-accent-dim p-8 flex flex-col items-center text-center gap-3">
            <div className="text-lg uppercase tracking-[0.2em] text-accent">no lumps yet</div>
            <p className="text-sm text-body-dim">
              lump tracks together to build your own collections
            </p>
            <button
              onClick={() => setCreateOpen(true)}
              className="mt-2 h-11 sm:h-9 px-4 flex items-center gap-2 border border-accent text-accent uppercase text-xs sm:text-[10px] tracking-[0.25em] hover:border-accent-bright hover:text-accent-bright transition-colors"
            >
              <Plus size={14} strokeWidth={1.75} />
              create your first lump
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {lumps.map((l) => (
              <Link
                key={l.id}
                to={`/lumps/${l.id}`}
                className="group block border border-accent-dim hover:border-accent-bright hover:bg-accent/5 px-4 py-3 transition-colors"
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="text-base text-white break-words line-clamp-2 group-hover:text-accent-bright">
                    {l.name}
                  </span>
                  <span className="shrink-0 text-accent-dim group-hover:text-accent-bright" title={l.is_public ? 'public' : 'private'}>
                    {l.is_public ? <Globe size={14} /> : <Lock size={14} />}
                  </span>
                </div>
                {l.description && (
                  <p className="text-xs sm:text-[11px] text-accent-dim mt-1 line-clamp-2">{l.description}</p>
                )}
                <div className="text-xs sm:text-[10px] uppercase tracking-[0.2em] text-body-very-dim mt-2">
                  {l.track_count} {l.track_count === 1 ? 'track' : 'tracks'}
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      <LumpFormModal
        open={createOpen}
        mode="create"
        onClose={() => setCreateOpen(false)}
        onSaved={onCreated}
      />
    </div>
  );
}
