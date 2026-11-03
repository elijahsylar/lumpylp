import { useEffect, useRef, useState } from 'react';
import { ArrowBigUp, ArrowBigDown } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { api } from '../lib/api';
import { announce } from '../lib/announce';

interface Props {
  trackId: number;
  upvotes?: number;
  downvotes?: number;
  userVote?: 1 | -1 | 0 | null;
  size?: 'sm' | 'md';
  /** Optional callback so a parent can bubble vote changes (e.g. update list state) */
  onVoteChange?: (next: { upvotes: number; downvotes: number; user_vote: 1 | -1 | 0 }) => void;
}

interface VoteResponse {
  track_id: number;
  upvotes: number;
  downvotes: number;
  net_lumps: number;
  user_vote: 1 | -1 | 0;
}

function formatNet(n: number): string {
  if (n === 0) return '0';
  return n > 0 ? `+${n}` : String(n);
}

export function LumpButtons({
  trackId, upvotes = 0, downvotes = 0, userVote = 0, size = 'sm', onVoteChange,
}: Props) {
  const { user } = useAuth();
  const [up, setUp] = useState(upvotes);
  const [down, setDown] = useState(downvotes);
  const [vote, setVote] = useState<1 | -1 | 0>((userVote || 0) as 1 | -1 | 0);
  const [showLoginHint, setShowLoginHint] = useState(false);
  const [busy, setBusy] = useState(false);
  const hintTimerRef = useRef<number | null>(null);

  // Sync from props when the parent passes a different track or fresh totals.
  useEffect(() => { setUp(upvotes); }, [upvotes, trackId]);
  useEffect(() => { setDown(downvotes); }, [downvotes, trackId]);
  useEffect(() => { setVote((userVote || 0) as 1 | -1 | 0); }, [userVote, trackId]);

  const flashHint = () => {
    setShowLoginHint(true);
    if (hintTimerRef.current) window.clearTimeout(hintTimerRef.current);
    hintTimerRef.current = window.setTimeout(() => setShowLoginHint(false), 2200);
  };
  useEffect(() => () => {
    if (hintTimerRef.current) window.clearTimeout(hintTimerRef.current);
  }, []);

  const cast = async (target: 1 | -1) => {
    if (!user) {
      flashHint();
      return;
    }
    if (busy) return;

    // Optimistic prediction of the new state — server confirms.
    const before = { up, down, vote };
    let nextVote: 1 | -1 | 0 = target;
    if (vote === target) nextVote = 0; // toggle off
    let nextUp = up, nextDown = down;
    // remove old contribution
    if (vote === 1) nextUp -= 1;
    if (vote === -1) nextDown -= 1;
    // add new contribution
    if (nextVote === 1) nextUp += 1;
    if (nextVote === -1) nextDown += 1;

    setUp(nextUp); setDown(nextDown); setVote(nextVote);
    setBusy(true);
    try {
      const res = await api<VoteResponse>(`/api/tracks/${trackId}/vote`, {
        method: 'POST',
        json: { direction: vote === target ? 0 : target },
      });
      setUp(res.upvotes);
      setDown(res.downvotes);
      setVote(res.user_vote);
      onVoteChange?.({ upvotes: res.upvotes, downvotes: res.downvotes, user_vote: res.user_vote });
      announce(
        res.user_vote === 1 ? 'lumped up' :
        res.user_vote === -1 ? 'lumped down' :
        'vote removed'
      );
    } catch {
      // Revert on failure.
      setUp(before.up); setDown(before.down); setVote(before.vote);
    } finally {
      setBusy(false);
    }
  };

  const iconSize = size === 'md' ? 22 : 18;
  const net = up - down;

  // Color classes — green for up, red-500 for down (the only allowed non-green
  // color in this app, used as the "warning / negative" signal).
  const upClass = vote === 1
    ? 'text-accent-bright'
    : 'text-accent-dim hover:text-accent';
  const downClass = vote === -1
    ? 'text-red-500'
    : 'text-accent-dim hover:text-red-500';
  const netClass = vote === 1
    ? 'text-accent-bright'
    : vote === -1
      ? 'text-red-500'
      : 'text-body-very-dim';

  // Horizontal below sm: two stacked 44px targets would be taller than the
  // list row itself. From sm: up the original vertical stack returns.
  return (
    <div
      className="relative flex flex-row sm:flex-col items-center select-none gap-1 sm:gap-0"
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        onClick={() => cast(1)}
        disabled={busy}
        title={user ? 'lump up' : 'log in to vote'}
        aria-label="lump up"
        aria-pressed={vote === 1}
        className={`min-w-[44px] min-h-[44px] sm:min-w-[24px] sm:min-h-[24px] flex items-center justify-center transition-colors ${upClass}`}
      >
        <ArrowBigUp size={iconSize} strokeWidth={1.5} fill={vote === 1 ? 'currentColor' : 'none'} />
      </button>
      <output
        aria-label={`${formatNet(net)} net lumps`}
        className={`text-xs sm:text-[10px] tabular-nums tracking-wider leading-none mx-0.5 sm:mx-0 sm:my-0.5 ${netClass}`}
      >
        {formatNet(net)}
      </output>
      <button
        type="button"
        onClick={() => cast(-1)}
        disabled={busy}
        title={user ? 'lump down' : 'log in to vote'}
        aria-label="lump down"
        aria-pressed={vote === -1}
        className={`min-w-[44px] min-h-[44px] sm:min-w-[24px] sm:min-h-[24px] flex items-center justify-center transition-colors ${downClass}`}
      >
        <ArrowBigDown size={iconSize} strokeWidth={1.5} fill={vote === -1 ? 'currentColor' : 'none'} />
      </button>
      {showLoginHint && (
        <div
          className="absolute z-10 -right-2 top-full mt-1 whitespace-nowrap
                     border border-accent-bright bg-bg px-2 py-1 text-xs sm:text-[9px] uppercase
                     tracking-[0.2em] text-accent-bright"
        >
          <Link to="/login" className="hover:underline">log in to vote</Link>
        </div>
      )}
    </div>
  );
}
