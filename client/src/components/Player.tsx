import { SkipBack, SkipForward, Play, Pause, ListOrdered, Shuffle } from 'lucide-react';
import { usePlayer } from '../hooks/usePlayer';
import { LumpButtons } from './LumpButtons';
import { AddToLumpButton } from './AddToLumpButton';
import { decodeEntities } from '../lib/text';
import type { Attribution } from '../types/track';

function fmt(s: number) {
  if (!isFinite(s) || s <= 0) return '0:00';
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60).toString().padStart(2, '0');
  return `${m}:${r}`;
}

// 44px below sm: (Apple HIG minimum), the original 36px from sm: up where
// a mouse pointer makes the smaller target fine and density matters more.
const BTN_BOX = 'w-11 h-11 sm:w-9 sm:h-9 flex items-center justify-center';

const sideBtn =
  BTN_BOX + ' border border-accent-dim text-accent ' +
  'hover:border-accent-bright hover:text-accent-bright transition-colors';

// Mode toggle (play-in-order / shuffle). Active state stacks three visual
// cues so it reads even in monochrome / colorblind modes:
//   1. Filled vs outline — solid bg-accent vs transparent
//   2. Inverted color — dark icon on green vs green icon on dark
//   3. Small dot indicator below the button
const modeBtn = (active: boolean) =>
  active
    ? 'relative ' + BTN_BOX + ' ' +
      'bg-accent border border-accent-bright text-bg ' +
      'transition-colors ' +
      "after:content-[''] after:absolute after:bottom-[-6px] after:left-1/2 " +
      "after:-translate-x-1/2 after:w-1 after:h-1 after:bg-accent-bright after:rounded-full"
    : BTN_BOX + ' ' +
      'border border-accent-dim text-accent-dim ' +
      'hover:border-accent hover:text-accent transition-colors ' +
      'disabled:opacity-40 disabled:cursor-not-allowed';

export function Player() {
  const p = usePlayer();
  const t = p.current;

  const playBtn = p.isPlaying
    ? BTN_BOX + ' border border-accent bg-accent text-bg transition-colors'
    : BTN_BOX + ' border border-accent-dim text-accent hover:border-accent-bright hover:text-accent-bright transition-colors';

  return (
    <footer
      aria-label="audio player"
      className="border-t border-accent/40 bg-bg px-3 sm:px-4 py-2 sm:py-3 md:py-4
                 pb-[calc(0.5rem+env(safe-area-inset-bottom))] sm:pb-[calc(0.75rem+env(safe-area-inset-bottom))]
                 pl-[calc(0.75rem+env(safe-area-inset-left))] pr-[calc(0.75rem+env(safe-area-inset-right))]
                 flex items-center gap-2 sm:gap-3 md:gap-4"
    >
      {/* Left — artwork + track info. Truncates aggressively on mobile.
          Mobile drops the artwork and shrinks the wrapper so the now-playing
          lump cluster + transport row fit a 390px viewport without overflow. */}
      <div className="min-w-0 flex-1 sm:flex-none sm:w-52 md:w-64 shrink sm:shrink-0 flex items-center gap-3">
        <div className="hidden md:flex w-10 h-10 border border-accent-dim bg-bg items-center justify-center text-accent text-xs sm:text-[10px] tracking-widest shrink-0 overflow-hidden">
          {t?.artwork_url ? (
            <img src={t.artwork_url} alt="" className="w-full h-full object-cover" />
          ) : (
            'LP'
          )}
        </div>
        <div className="min-w-0 flex flex-col justify-center leading-tight">
          <span className="truncate text-sm text-white">
            {t ? decodeEntities(t.title) : '— no track —'}
          </span>
          <span className="truncate text-xs text-accent">
            {t ? decodeEntities(t.artist_name) : ''}
          </span>
          {t && <Credit a={t.attribution} />}
        </div>
      </div>

      {/* Mobile lump cluster — visible below md, size sm to fit between the
          track info and transport. Desktop's md-size cluster below renders
          at md+ and is visually equivalent. Two blocks because LumpButtons
          and AddToLumpButton take `size` as a prop, not a Tailwind class,
          so we can't switch sizes responsively in one element. */}
      {t && (
        <div className="md:hidden flex shrink-0 items-center gap-1">
          <LumpButtons
            trackId={t.id}
            upvotes={t.upvotes ?? 0}
            downvotes={t.downvotes ?? 0}
            userVote={(t.user_vote ?? 0) as 1 | -1 | 0}
            size="sm"
          />
          <AddToLumpButton track={t} size="sm" />
        </div>
      )}

      {/* Desktop lump cluster — md+ only. */}
      {t && (
        <div className="hidden md:flex shrink-0 items-center gap-3">
          <LumpButtons
            trackId={t.id}
            upvotes={t.upvotes ?? 0}
            downvotes={t.downvotes ?? 0}
            userVote={(t.user_vote ?? 0) as 1 | -1 | 0}
            size="md"
          />
          <AddToLumpButton track={t} size="md" />
        </div>
      )}

      {/* Center — transport */}
      <div className="shrink-0 sm:flex-1 min-w-0 flex flex-col items-center gap-1 sm:gap-2">
        <div className="flex items-center gap-1 sm:gap-2">
          {/* Play-in-order toggle (Phase 7). Active = current mode. */}
          <button
            onClick={() => p.setPlayMode('order')}
            className={modeBtn(p.playMode === 'order')}
            aria-label="play in order"
            title="play in order"
            aria-pressed={p.playMode === 'order'}
          >
            <ListOrdered size={16} strokeWidth={1.75} />
          </button>
          <button onClick={p.prev} className={sideBtn} aria-label="prev">
            <SkipBack size={16} strokeWidth={1.75} />
          </button>
          <button
            onClick={p.toggle}
            className={playBtn}
            aria-label={p.isPlaying ? 'pause' : 'play'}
          >
            {p.isPlaying ? (
              <Pause size={16} strokeWidth={1.75} />
            ) : (
              <Play size={16} strokeWidth={1.75} />
            )}
          </button>
          <button onClick={p.next} className={sideBtn} aria-label="next">
            <SkipForward size={16} strokeWidth={1.75} />
          </button>
          {/* Shuffle toggle (Phase 7). Active = current mode. */}
          <button
            onClick={() => p.setPlayMode('shuffle')}
            disabled={p.queue.length <= 1}
            className={modeBtn(p.playMode === 'shuffle')}
            aria-label="shuffle"
            title="shuffle"
            aria-pressed={p.playMode === 'shuffle'}
          >
            <Shuffle size={16} strokeWidth={1.75} />
          </button>
        </div>
        <div className="w-full flex items-center gap-2 text-xs sm:text-[10px] text-accent-dim tabular-nums">
          <span className="hidden sm:inline">{fmt(p.progress)}</span>
          <input
            type="range"
            min={0}
            max={p.duration || 0}
            value={p.progress}
            onChange={(e) => p.seek(Number(e.target.value))}
            aria-label="seek"
            className="range-touch flex-1 min-w-0 accent-accent"
          />
          <span className="hidden sm:inline">{fmt(p.duration)}</span>
        </div>
      </div>

      {/* Right — volume. Hidden below md — mobile users use the system volume. */}
      <div className="hidden md:flex w-48 items-center gap-2 text-accent-dim text-xs sm:text-[10px] uppercase tracking-[0.25em]">
        <span>vol</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={p.volume}
          onChange={(e) => p.setVolume(Number(e.target.value))}
          aria-label="volume"
          className="range-touch flex-1 min-w-0 accent-accent"
        />
      </div>
    </footer>
  );
}

// Minimal credit line the licenses require: license (linked) and where the
// track comes from (linked). Unstyled on purpose; styling waits for the
// redesign. No modifications are made to the audio, so no change notice.
function Credit({ a }: { a: Attribution | null }) {
  if (!a) return null;
  return (
    <span className="truncate text-xs sm:text-[9px] text-accent-dim mt-0.5">
      {a.license_url ? (
        <a href={a.license_url} target="_blank" rel="noopener noreferrer license" className="underline">{a.license_name}</a>
      ) : (
        a.license_name
      )}
      {' · via '}
      {a.source_url ? (
        <a href={a.source_url} target="_blank" rel="noopener noreferrer" className="underline">{a.source_name}</a>
      ) : (
        a.source_name
      )}
    </span>
  );
}
