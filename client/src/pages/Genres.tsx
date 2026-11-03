import { useGenres } from '../hooks/useTracks';
import { PageHeader, SectionTitle } from '../components/PageHeader';

interface Props {
  onGenreSelect: (g: string) => void;
}

export function Genres({ onGenreSelect }: Props) {
  const genres = useGenres();
  return (
    <div className="flex-1 overflow-y-auto">
      <PageHeader>
        <SectionTitle label="genres" />
        <p className="text-xs text-body-dim mt-1 uppercase tracking-wider">
          {genres.length} genres
        </p>
      </PageHeader>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2 p-6">
        {genres.map((g) => (
          <button
            key={g.id}
            onClick={() => onGenreSelect(g.name)}
            className="group border border-border bg-bg hover:border-accent
                       hover:bg-accent/5 px-4 py-6 text-left transition-colors"
          >
            <div className="text-sm uppercase tracking-wider text-body group-hover:text-accent-bright break-words">
              {g.name}
            </div>
            <div className="text-xs sm:text-[10px] text-body-very-dim mt-1 uppercase tracking-wider">
              {g.track_count} tracks
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
