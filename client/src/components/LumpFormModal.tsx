import { useEffect, useState, type FormEvent } from 'react';
import { AlertCircle } from 'lucide-react';
import { Modal } from './Modal';
import { api } from '../lib/api';
import type { UserLump } from '../types/lump';

type Mode = 'create' | 'edit';

interface Props {
  open: boolean;
  mode: Mode;
  lump?: UserLump;
  onClose: () => void;
  onSaved: (lump: UserLump) => void;
}

const inputCls =
  'w-full h-9 bg-bg border border-accent-dim focus:border-accent outline-none ' +
  'font-mono text-sm px-3 text-body placeholder:text-body-very-dim transition-colors';

export function LumpFormModal({ open, mode, lump, onClose, onSaved }: Props) {
  const [name, setName] = useState(lump?.name ?? '');
  const [description, setDescription] = useState(lump?.description ?? '');
  const [isPublic, setIsPublic] = useState(!!lump?.is_public);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Reset form when opening or switching lumps.
  useEffect(() => {
    if (open) {
      setName(lump?.name ?? '');
      setDescription(lump?.description ?? '');
      setIsPublic(!!lump?.is_public);
      setError(null);
    }
  }, [open, lump]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const body = {
        name: name.trim(),
        description: description.trim() || null,
        is_public: isPublic,
      };
      const res = mode === 'create'
        ? await api<{ lump: UserLump }>('/api/lumps', { method: 'POST', json: body })
        : await api<{ lump: UserLump }>(`/api/lumps/${lump!.id}`, { method: 'PATCH', json: body });
      onSaved(res.lump);
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={mode === 'create' ? 'new lump' : 'edit lump'}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1">
          <span className="text-xs sm:text-[10px] uppercase tracking-[0.25em] text-accent-dim">name</span>
          <input
            type="text"
            value={name}
            autoFocus
            maxLength={100}
            onChange={(e) => setName(e.target.value)}
            className={inputCls}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs sm:text-[10px] uppercase tracking-[0.25em] text-accent-dim">description (optional)</span>
          <textarea
            value={description}
            maxLength={500}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            className={inputCls.replace('h-9', 'min-h-[72px] py-2')}
          />
        </label>
        <label className="flex items-center gap-2 text-xs uppercase tracking-[0.2em] text-accent-dim cursor-pointer">
          <input
            type="checkbox"
            checked={isPublic}
            onChange={(e) => setIsPublic(e.target.checked)}
            className="accent-accent"
          />
          public — anyone with the link can play this lump
        </label>

        <div className="flex gap-2 justify-end pt-2">
          <button
            type="button"
            onClick={onClose}
            className="h-9 px-4 border border-accent-dim text-accent-dim uppercase text-xs sm:text-[10px] tracking-[0.25em] hover:text-accent hover:border-accent transition-colors"
          >
            cancel
          </button>
          <button
            type="submit"
            disabled={busy || !name.trim()}
            className="h-9 px-4 border border-accent text-accent uppercase text-xs sm:text-[10px] tracking-[0.25em] hover:border-accent-bright hover:text-accent-bright disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {busy ? '…' : mode === 'create' ? 'create lump' : 'save changes'}
          </button>
        </div>

        {error && (
          <div
            role="alert"
            aria-live="assertive"
            className="flex items-center gap-2 text-red-500 text-xs uppercase tracking-wider"
          >
            <AlertCircle size={14} aria-hidden="true" />
            <span>{error}</span>
          </div>
        )}
      </form>
    </Modal>
  );
}
