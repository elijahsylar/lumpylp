import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Play, Shuffle, Pencil, Trash2, Lock, Globe, GripVertical, X, Search as SearchIcon } from 'lucide-react';
import {
  DndContext, PointerSensor, TouchSensor, KeyboardSensor, useSensor, useSensors, closestCenter,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, useSortable, arrayMove, verticalListSortingStrategy, sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

import type { Track } from '../types/track';
import type { LumpDetail, UserLump } from '../types/lump';
import { api } from '../lib/api';
import { usePlayer } from '../hooks/usePlayer';
import { useAuth } from '../lib/auth';
import { PageHeader, SectionTitle } from '../components/PageHeader';
import { LumpButtons } from '../components/LumpButtons';
import { LumpFormModal } from '../components/LumpFormModal';
import { Modal } from '../components/Modal';

function fmtDuration(s: number | null) {
  if (!s) return '--:--';
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60).toString().padStart(2, '0');
  return `${m}:${r}`;
}

function shuffleArr<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

interface RowProps {
  track: Track;
  index: number;
  isOwner: boolean;
  onPlay: (track: Track) => void;
  onRemove: (trackId: number) => void;
}

function TrackRow({ track, index, isOwner, onPlay, onRemove }: RowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: track.id,
  });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      onClick={() => onPlay(track)}
      className={`grid ${
        isOwner
          ? 'grid-cols-[1.5rem_2rem_1fr_3rem_2rem] md:grid-cols-[1.5rem_2rem_1fr_1fr_8rem_4rem_3.5rem_2rem]'
          : 'grid-cols-[2.5rem_1fr_3rem] md:grid-cols-[2.5rem_1fr_1fr_8rem_4rem_3.5rem]'
      }
                  gap-3 px-3 py-2.5 items-center cursor-pointer text-sm
                  border-l-2 border-b border-accent-dim/30 transition-colors
                  ${isDragging ? 'bg-accent-dim/20 border-l-accent-bright' : 'border-l-transparent text-body hover:border-l-accent hover:bg-accent-dim/15'}`}
    >
      {isOwner && (
        <button
          type="button"
          {...listeners}
          {...attributes}
          onClick={(e) => e.stopPropagation()}
          aria-label={`drag to reorder ${track.title}`}
          style={{ touchAction: 'none' }}
          className="min-w-[44px] min-h-[44px] md:min-w-[24px] md:min-h-[24px] flex items-center justify-center cursor-grab active:cursor-grabbing text-accent-dim hover:text-accent bg-transparent"
        >
          <GripVertical size={14} />
        </button>
      )}
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onPlay(track); }}
        aria-label={`play ${track.title} by ${track.artist_name}, track ${String(index + 1).padStart(2, '0')}`}
        className="text-xs tabular-nums text-left bg-transparent text-accent-dim"
      >
        {String(index + 1).padStart(2, '0')}
      </button>
      <span className="min-w-0 flex flex-col md:flex-row md:items-center md:gap-2">
        <span className="truncate">{track.title}</span>
        <span className="md:hidden truncate text-xs text-accent-dim">
          {track.artist_name}
        </span>
      </span>
      <span className="hidden md:block truncate text-accent-dim">{track.artist_name}</span>
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
      {isOwner && (
        <button
          onClick={(e) => { e.stopPropagation(); onRemove(track.id); }}
          title="remove from this lump"
          aria-label={`remove ${track.title} from this lump`}
          className="min-w-[44px] min-h-[44px] md:min-w-[24px] md:min-h-[24px] flex items-center justify-center text-accent-dim hover:text-red-500 transition-colors"
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
}

export function Lump() {
  const params = useParams();
  const navigate = useNavigate();
  const player = usePlayer();
  const { user } = useAuth();
  const id = params.id;

  const [data, setData] = useState<LumpDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    // Touch needs press-and-hold: with only PointerSensor's distance
    // constraint the browser treats the first move as a scroll and the
    // drag never activates. `tolerance` lets the finger wobble during
    // the hold without cancelling.
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const load = () => {
    setLoading(true);
    api<LumpDetail>(`/api/lumps/${id}`)
      .then((d) => { setData(d); setNotFound(false); })
      .catch((e: { status?: number }) => {
        if (e?.status === 404) setNotFound(true);
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (!id) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, user]);

  if (loading && !data) {
    return (
      <div className="flex-1 overflow-y-auto">
        <PageHeader>
          <SectionTitle label="loading…" />
        </PageHeader>
      </div>
    );
  }

  if (notFound || !data) {
    return (
      <div className="flex-1 overflow-y-auto">
        <PageHeader>
          <SectionTitle label="lump not found" />
          <p className="text-xs text-body-dim mt-1 uppercase tracking-wider">
            this lump may be private or deleted
          </p>
        </PageHeader>
      </div>
    );
  }

  const { lump, tracks, is_owner } = data;

  const onPlayTrack = (track: Track) => {
    const idx = tracks.findIndex((t) => t.id === track.id);
    if (idx < 0) return;
    player.load(track, tracks);
  };

  // Start at the first playable track: load() ignores a dead one, so a dead
  // first track used to make these buttons do nothing.
  const onPlayAll = () => {
    const first = tracks.find((t) => t.playable);
    if (first) player.load(first, tracks);
  };

  const onShuffle = () => {
    const shuffled = shuffleArr(tracks);
    const first = shuffled.find((t) => t.playable);
    if (first) player.load(first, shuffled);
  };

  const onRemove = async (trackId: number) => {
    const idx = tracks.findIndex((t) => t.id === trackId);
    if (idx < 0) return;
    const removed = tracks[idx];
    // Functional updates: with several removals in flight, each one changes
    // (and on failure restores) only its own track, and the count with it.
    setData((d) => d && {
      ...d,
      tracks: d.tracks.filter((t) => t.id !== trackId),
      lump: { ...d.lump, track_count: d.lump.track_count - 1 },
    });
    try {
      await api(`/api/lumps/${id}/tracks/${trackId}`, { method: 'DELETE' });
    } catch {
      setData((d) => {
        if (!d || d.tracks.some((t) => t.id === trackId)) return d;
        const at = Math.min(idx, d.tracks.length);
        return {
          ...d,
          tracks: [...d.tracks.slice(0, at), removed, ...d.tracks.slice(at)],
          lump: { ...d.lump, track_count: d.lump.track_count + 1 },
        };
      });
    }
  };

  const onDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIdx = tracks.findIndex((t) => t.id === active.id);
    const newIdx = tracks.findIndex((t) => t.id === over.id);
    if (oldIdx < 0 || newIdx < 0) return;
    const next = arrayMove(tracks, oldIdx, newIdx);
    setData({ ...data, tracks: next });
    try {
      await api(`/api/lumps/${id}/tracks/reorder`, {
        method: 'PATCH',
        json: { track_ids: next.map((t) => t.id) },
      });
    } catch {
      setData({ ...data, tracks }); // revert
    }
  };

  const onDelete = async () => {
    try {
      await api(`/api/lumps/${id}`, { method: 'DELETE' });
      navigate('/lumps', { replace: true });
    } catch {
      setConfirmDelete(false);
    }
  };

  const onEdited = (saved: UserLump) => {
    setData({ ...data, lump: { ...saved, track_count: lump.track_count, owner_username: lump.owner_username } });
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <PageHeader>
        <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-3 md:gap-4">
          <div className="min-w-0">
            <h2 className="text-lg uppercase tracking-[0.2em] font-medium text-accent flex items-center gap-2">
              <span>{lump.name}</span>
              <span className="text-accent-dim/70" title={lump.is_public ? 'public' : 'private'}>
                {lump.is_public ? <Globe size={14} /> : <Lock size={14} />}
              </span>
            </h2>
            {lump.description && (
              <p className="text-sm text-body-dim mt-1">{lump.description}</p>
            )}
            <p className="text-xs sm:text-[10px] text-body-very-dim mt-2 uppercase tracking-[0.2em]">
              {lump.track_count} {lump.track_count === 1 ? 'track' : 'tracks'}
              {!is_owner && lump.owner_username && (
                <span className="text-accent-dim"> · shared by {lump.owner_username}</span>
              )}
            </p>
          </div>
        </div>
      </PageHeader>

      <section className="px-4 sm:px-6 pb-6 bg-bg">
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <button
            onClick={onPlayAll}
            disabled={!tracks.length}
            className="h-11 sm:h-9 px-4 flex items-center gap-2 border border-accent-dim text-accent uppercase text-xs sm:text-[10px] tracking-[0.25em] hover:border-accent-bright hover:text-accent-bright disabled:opacity-40 transition-colors"
          >
            <Play size={14} strokeWidth={1.75} />
            play all
          </button>
          <button
            onClick={onShuffle}
            disabled={!tracks.length}
            className="h-11 sm:h-9 px-4 flex items-center gap-2 border border-accent-dim text-accent uppercase text-xs sm:text-[10px] tracking-[0.25em] hover:border-accent-bright hover:text-accent-bright disabled:opacity-40 transition-colors"
          >
            <Shuffle size={14} strokeWidth={1.75} />
            shuffle
          </button>
          {is_owner ? (
            <>
              <button
                onClick={() => setEditOpen(true)}
                className="h-11 sm:h-9 px-4 flex items-center gap-2 border border-accent-dim text-accent-dim uppercase text-xs sm:text-[10px] tracking-[0.25em] hover:text-accent hover:border-accent transition-colors"
              >
                <Pencil size={14} strokeWidth={1.75} />
                edit
              </button>
              <button
                onClick={() => setConfirmDelete(true)}
                className="h-11 sm:h-9 px-4 flex items-center gap-2 border border-accent-dim text-accent-dim uppercase text-xs sm:text-[10px] tracking-[0.25em] hover:text-red-500 hover:border-red-500 transition-colors"
              >
                <Trash2 size={14} strokeWidth={1.75} />
                delete
              </button>
            </>
          ) : (
            <span className="ml-auto text-xs sm:text-[10px] uppercase tracking-[0.25em] text-accent-dim">
              shared by {lump.owner_username}
            </span>
          )}
        </div>

        {tracks.length === 0 ? (
          <div className="border border-accent-dim p-8 flex flex-col items-center text-center gap-3">
            <div className="text-lg uppercase tracking-[0.2em] text-accent">this lump is empty</div>
            <p className="text-sm text-body-dim">
              find tracks via search, genres, or artists, then click lump it
            </p>
            <button
              onClick={() => navigate('/search')}
              className="mt-2 h-11 sm:h-9 px-4 flex items-center gap-2 border border-accent text-accent uppercase text-xs sm:text-[10px] tracking-[0.25em] hover:border-accent-bright hover:text-accent-bright transition-colors"
            >
              <SearchIcon size={14} strokeWidth={1.75} />
              go to search
            </button>
          </div>
        ) : (
          <div className="border border-accent-dim p-3">
            <div className={`hidden md:grid ${is_owner ? 'grid-cols-[1.5rem_2rem_1fr_1fr_8rem_4rem_3.5rem_2rem]' : 'grid-cols-[2.5rem_1fr_1fr_8rem_4rem_3.5rem]'}
                            gap-3 px-3 py-2 bg-bg border-b border-accent-dim text-xs sm:text-[10px] uppercase tracking-[0.2em] text-body-very-dim`}>
              {is_owner && <span />}
              <span>#</span>
              <span>Title</span>
              <span>Artist</span>
              <span>Genre</span>
              <span className="text-right">Time</span>
              <span className="text-center">Lumps</span>
              {is_owner && <span />}
            </div>
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
              <SortableContext items={tracks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
                {tracks.map((t, i) => (
                  <TrackRow key={t.id} track={t} index={i} isOwner={is_owner} onPlay={onPlayTrack} onRemove={onRemove} />
                ))}
              </SortableContext>
            </DndContext>
          </div>
        )}
      </section>

      {is_owner && (
        <LumpFormModal
          open={editOpen}
          mode="edit"
          lump={lump}
          onClose={() => setEditOpen(false)}
          onSaved={onEdited}
        />
      )}

      <Modal open={confirmDelete} onClose={() => setConfirmDelete(false)} title="delete this lump?">
        <p className="text-sm text-body-dim">
          this can't be undone. {lump.track_count} tracks will be removed from "{lump.name}".
        </p>
        <div className="flex gap-2 justify-end mt-5">
          <button
            onClick={() => setConfirmDelete(false)}
            className="h-9 px-4 border border-accent-dim text-accent-dim uppercase text-xs sm:text-[10px] tracking-[0.25em] hover:text-accent hover:border-accent transition-colors"
          >
            cancel
          </button>
          <button
            onClick={onDelete}
            className="h-9 px-4 border border-red-500 text-red-500 uppercase text-xs sm:text-[10px] tracking-[0.25em] hover:bg-red-500 hover:text-bg transition-colors"
          >
            delete forever
          </button>
        </div>
      </Modal>
    </div>
  );
}
