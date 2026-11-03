import { useEffect, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { AddToLumpModal } from './AddToLumpModal';
import type { Track } from '../types/track';

interface Props {
  track: Track;
  size?: 'sm' | 'md';
}

export function AddToLumpButton({ track, size = 'sm' }: Props) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [hint, setHint] = useState(false);
  const hintTimer = useRef<number | null>(null);

  useEffect(() => () => {
    if (hintTimer.current) window.clearTimeout(hintTimer.current);
  }, []);

  const onClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!user) {
      setHint(true);
      if (hintTimer.current) window.clearTimeout(hintTimer.current);
      hintTimer.current = window.setTimeout(() => setHint(false), 2200);
      return;
    }
    setOpen(true);
  };

  const iconSize = size === 'md' ? 16 : 14;

  return (
    <div className="relative" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        onClick={onClick}
        title={user ? 'add to a lump' : 'log in to add to a lump'}
        aria-label="add to a lump"
        className="flex items-center justify-center w-11 h-11 sm:w-7 sm:h-7 border border-accent-dim text-accent-dim hover:border-accent-bright hover:text-accent-bright transition-colors"
      >
        <Plus size={iconSize} strokeWidth={2} />
      </button>
      {hint && (
        <div className="absolute z-10 -right-2 top-full mt-1 whitespace-nowrap border border-accent-bright bg-bg px-2 py-1 text-xs sm:text-[9px] uppercase tracking-[0.2em] text-accent-bright">
          <Link to="/login" className="hover:underline">log in to add to a lump</Link>
        </div>
      )}
      <AddToLumpModal open={open} track={track} onClose={() => setOpen(false)} />
    </div>
  );
}
