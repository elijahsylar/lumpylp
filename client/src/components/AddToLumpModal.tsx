import { useEffect, useMemo, useState } from 'react';
import { Plus, Check, AlertCircle } from 'lucide-react';
import { Modal } from './Modal';
import { api } from '../lib/api';
import type { UserLump } from '../types/lump';
import type { Track } from '../types/track';

interface Props {
  open: boolean;
  track: Track | null;
  onClose: () => void;
}

interface AddResp {
  lump_track: { id: number; lump_id?: number; track_id: number; position: number };
  already_in: boolean;
}

const inputCls =
  'w-full h-9 bg-bg border border-accent-dim focus:border-accent outline-none ' +
  'font-mono text-sm px-3 text-body placeholder:text-body-very-dim transition-colors';

export function AddToLumpModal({ open, track, onClose }: Props) {
  const [lumps, setLumps] = useState<UserLump[]>([]);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [alreadyIn, setAlreadyIn] = useState<Set<number>>(new Set());

  useEffect(() => {
    if (!open) return;
    setFilter('');
    setError(null);
    setConfirmation(null);
    setNewName('');
    // TODO: real fix is server-driven per-(lump, track) membership — the
    // /api/lumps response should include `contains_track` for the current
    // track so we can pre-populate this set with actual membership.
    setAlreadyIn(new Set());
    setLoading(true);
    api<{ lumps: UserLump[] }>('/api/lumps')
      .then((d) => setLumps(d.lumps || []))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'failed to load'))
      .finally(() => setLoading(false));
  }, [open]);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return lumps;
    return lumps.filter((l) => l.name.toLowerCase().includes(q));
  }, [lumps, filter]);

  const lumpIt = async (lumpId: number, lumpName: string) => {
    if (!track) return;
    setError(null);
    try {
      const res = await api<AddResp>(`/api/lumps/${lumpId}/tracks`, {
        method: 'POST',
        json: { track_id: track.id },
      });
      setAlreadyIn((prev) => new Set(prev).add(lumpId));
      setConfirmation(res.already_in ? `already in "${lumpName}"` : `lumped into "${lumpName}"`);
      setLumps((ls) =>
        ls.map((l) =>
          l.id === lumpId ? { ...l, track_count: l.track_count + (res.already_in ? 0 : 1) } : l
        )
      );
      setTimeout(onClose, 800);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'failed');
    }
  };

  const createAndAdd = async () => {
    if (!track) return;
    const name = newName.trim();
    if (!name) return;
    setError(null);
    setCreating(true);
    try {
      const created = await api<{ lump: UserLump }>('/api/lumps', {
        method: 'POST',
        json: { name },
      });
      await api<AddResp>(`/api/lumps/${created.lump.id}/tracks`, {
        method: 'POST',
        json: { track_id: track.id },
      });
      setConfirmation(`lumped into "${created.lump.name}"`);
      setTimeout(onClose, 800);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'failed');
    } finally {
      setCreating(false);
    }
  };

  if (!track) return null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`lump '${track.title.length > 60 ? track.title.slice(0, 57) + '…' : track.title}' into…`}
    >
      <input
        type="search"
        aria-label="search your lumps"
        placeholder="search your lumps…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        className={`${inputCls} mb-3`}
      />

      <div className="max-h-[340px] overflow-y-auto border border-accent-dim/60 divide-y divide-accent-dim/30">
        {loading && <div className="px-3 py-4 text-body-very-dim text-xs uppercase tracking-wider">loading…</div>}
        {!loading && visible.length === 0 && (
          <div className="px-3 py-4 text-body-very-dim text-xs uppercase tracking-wider">
            {lumps.length === 0 ? 'no lumps yet — create one below' : 'no lumps match'}
          </div>
        )}
        {visible.map((l) => {
          const wasAdded = alreadyIn.has(l.id);
          return (
            <button
              key={l.id}
              onClick={() => lumpIt(l.id, l.name)}
              disabled={wasAdded}
              className="w-full flex items-center justify-between px-3 py-2 text-left hover:bg-accent/5 transition-colors disabled:cursor-default"
            >
              <span className="truncate text-sm text-body">{l.name}</span>
              {wasAdded ? (
                <span className="flex items-center gap-1 text-xs sm:text-[10px] uppercase tracking-[0.25em] text-accent-bright">
                  <Check size={12} />
                  lumped
                </span>
              ) : (
                <span className="text-xs sm:text-[10px] uppercase tracking-[0.25em] text-accent-dim">
                  {l.track_count} tracks
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="border-t border-accent-dim/60 mt-4 pt-4 flex items-center gap-2">
        <input
          type="text"
          aria-label="new lump name"
          placeholder="+ new lump name"
          value={newName}
          maxLength={100}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') createAndAdd(); }}
          className={inputCls}
        />
        <button
          onClick={createAndAdd}
          disabled={!newName.trim() || creating}
          className="shrink-0 h-9 px-3 flex items-center gap-1 border border-accent text-accent uppercase text-xs sm:text-[10px] tracking-[0.25em] hover:border-accent-bright hover:text-accent-bright disabled:opacity-40 transition-colors"
        >
          <Plus size={12} />
          {creating ? '…' : 'create + add'}
        </button>
      </div>

      {error && (
        <div
          role="alert"
          aria-live="assertive"
          className="mt-3 flex items-center gap-2 text-red-500 text-xs uppercase tracking-wider"
        >
          <AlertCircle size={14} aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}
      {confirmation && (
        <div
          role="status"
          aria-live="polite"
          className="mt-3 flex items-center gap-2 text-accent-bright text-xs uppercase tracking-wider"
        >
          <Check size={14} aria-hidden="true" />
          <span>{confirmation}</span>
        </div>
      )}
    </Modal>
  );
}
