import type { Track } from '../types/track';
import { usePlayer } from '../hooks/usePlayer';
import type { ShuffleSource } from '../hooks/usePlayer';
import { LumpButtons } from './LumpButtons';
import { AddToLumpButton } from './AddToLumpButton';
import { decodeEntities } from '../lib/text';

interface Props {
  track: Track;
  queue: Track[];
  index: number;
  /** When 'lumps', the # column shows the net_lumps score instead of the row number. */
  countMode?: 'index' | 'lumps';
  /** Optional. When provided, toggling shuffle sources next-up tracks from
   *  the server-side filter pool instead of shuffling `queue` in place. */
  shuffleSource?: ShuffleSource;
  /** Hides the artist column. Set on the artist detail page, where every
   *  row would otherwise repeat the name already in the page title. */
  hideArtist?: boolean;
}

const DUMPED_THRESHOLD = -5;

function fmtDuration(s: number | null) {
  if (!s) return '--:--';
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60).toString().padStart(2, '0');
  return `${m}:${r}`;
}

function fmtNet(n: number) {
  if (n === 0) return '0';
  return n > 0 ? `+${n}` : String(n);
}

function netClass(n: number) {
  if (n > 0) return 'text-accent-bright';
  if (n < 0) return 'text-red-500';
  return 'text-body-very-dim';
}

export function TrackCard({ track, queue, index, countMode = 'index', shuffleSource, hideArtist }: Props) {
  const player = usePlayer();
  const isCurrent = player.current?.id === track.id;
  // Some ingesters stored HTML entities un-decoded; fix at display time.
  const title = decodeEntities(track.title);
  const artistName = decodeEntities(track.artist_name);
  const net = track.net_lumps ?? ((track.upvotes ?? 0) - (track.downvotes ?? 0));
  const isDumped = net <= DUMPED_THRESHOLD;
  const isDead = track.available === false || !track.playable;

  const onClick = () => {
    if (isDead) return; // dead tracks aren't clickable
    player.load(track, queue, shuffleSource);
  };

  const playLabel = isDead
    ? `${title} is no longer available`
    : `play ${title} by ${artistName}`;

  return (
    <div
      onClick={onClick}
      title={isDead ? playLabel : undefined}
      className={`grid
                  grid-cols-[1fr_auto_auto]
                  md:grid-cols-[2.5rem_1fr_1fr_8rem_4rem_3.5rem_2.5rem]
                  gap-2 sm:gap-3 px-3 py-2 sm:py-2.5 items-center min-h-[3.5rem] md:min-h-0
                  text-sm border-l-2 border-b border-accent-dim/30 bg-bg
                  transition-colors
                  ${isDead
                    ? 'opacity-30 cursor-not-allowed border-l-transparent text-body'
                    : isCurrent
                      ? 'cursor-pointer border-l-accent-bright bg-accent/10'
                      : 'cursor-pointer border-l-transparent text-body hover:border-l-accent hover:bg-accent-dim/15'
                  }`}
    >
      {/* Row-number / score column. Hidden below md: it costs 2.5rem of a
          360px screen, and the whole row is already the play target there.
          The playing state is carried by the left border, the accent title,
          and the ▶ marker rendered inline with the title on mobile. */}
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onClick(); }}
        disabled={isDead}
        aria-label={playLabel}
        className={`hidden md:block text-xs tabular-nums text-left ${
          isCurrent
            ? 'text-accent-bright animate-pulse-soft'
            : countMode === 'lumps'
              ? netClass(net)
              : 'text-accent-dim'
        } disabled:cursor-not-allowed`}
      >
        {isCurrent
          ? '▶'
          : countMode === 'lumps'
            ? fmtNet(net)
            : String(index + 1).padStart(2, '0')}
      </button>
      <span className={`min-w-0 flex flex-col md:flex-row md:items-center md:gap-2 ${isCurrent ? 'text-accent-bright' : ''}`}>
        <span className="truncate flex items-center gap-2">
          {isCurrent && (
            <span
              aria-hidden="true"
              className="md:hidden shrink-0 text-accent-bright animate-pulse-soft"
            >
              ▶
            </span>
          )}
          <span className="truncate">{title}</span>
          {isDead && (
            <span className="shrink-0 text-xs sm:text-[9px] px-1.5 py-0.5 border border-body-very-dim text-body-very-dim uppercase tracking-[0.2em]">
              no longer available
            </span>
          )}
          {isDumped && !isDead && (
            <span className="shrink-0 text-xs sm:text-[9px] px-1.5 py-0.5 border border-red-500 text-red-500 uppercase tracking-[0.2em]">
              dumped
            </span>
          )}
        </span>
        {/* Mobile-only: artist shows below title in the same column. */}
        {!hideArtist && (
          <span className={`md:hidden truncate text-sm ${isCurrent ? 'text-accent' : 'text-accent-dim'}`}>
            {artistName}
          </span>
        )}
      </span>
      <span className={`hidden md:block truncate ${isCurrent ? 'text-accent' : 'text-accent-dim'}`}>
        {hideArtist ? '' : artistName}
      </span>
      <span className="hidden md:block truncate text-body-very-dim text-xs sm:text-[10px] uppercase tracking-wider">
        {track.genre || '—'}
      </span>
      <span className="hidden md:block text-right text-body-very-dim text-xs tabular-nums">
        {fmtDuration(track.duration_seconds)}
      </span>
      <div className="flex justify-center">
        <LumpButtons
          trackId={track.id}
          upvotes={track.upvotes ?? 0}
          downvotes={track.downvotes ?? 0}
          userVote={(track.user_vote ?? 0) as 1 | -1 | 0}
          size="sm"
        />
      </div>
      <div className="flex justify-center">
        <AddToLumpButton track={track} size="sm" />
      </div>
    </div>
  );
}
