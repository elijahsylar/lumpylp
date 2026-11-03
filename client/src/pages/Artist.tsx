import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Play, MapPin } from 'lucide-react';
import { useTracks } from '../hooks/useTracks';
import { TrackList } from '../components/TrackList';
import type { ShuffleSource } from '../hooks/usePlayer';
import { PageHeader, SectionTitle } from '../components/PageHeader';
import { decodeEntities } from '../lib/text';
import { usePlayer } from '../hooks/usePlayer';
import { displayCity, displayCountry } from '../lib/locationDisplay';

// Smart-display profile location: title-cased city + canonical country name
// (handles US-state codes like "TX" → "Texas, USA" and dedupes "FR"/"France").
// locationSource disambiguates 2-char codes that collide between US state
// postal codes and ISO-2 country codes (DE, CA, GA, etc.).
function formatProfileLocation(
  city: string | null,
  country: string | null,
  locationSource?: string | null,
  lat?: number | null,
  lng?: number | null
): string {
  const c = displayCity(city);
  const k = displayCountry(country, locationSource, {
    lat: lat ?? undefined,
    lng: lng ?? undefined,
  });
  if (c && k) return `${c}, ${k.name}`;
  if (c) return c;
  if (k) return k.name;
  return '';
}

export function Artist() {
  const params = useParams();
  const name = decodeURIComponent(params.name || '');
  const player = usePlayer();
  const { tracks, total, loading, hasMore, loadMore } = useTracks({ artist: name });
  const [artistRow, setArtistRow] = useState<{ city: string | null; country: string | null; location_source: string | null; lat: number | null; lng: number | null } | null>(null);

  // Catalog location lookup — works for any source in the artists table.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/artists/by-name/${encodeURIComponent(name)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!cancelled) setArtistRow(d?.artist ? {
        city: d.artist.city,
        country: d.artist.country,
        location_source: d.artist.location_source,
        lat: d.artist.lat == null ? null : Number(d.artist.lat),
        lng: d.artist.lng == null ? null : Number(d.artist.lng),
      } : null); })
      .catch(() => { if (!cancelled) setArtistRow(null); });
    return () => { cancelled = true; };
  }, [name]);

  // Phase 18.0: filter-source shuffle pool for this artist. Toggle shuffle
  // after click-to-play (or play-all) and the engine refills upcoming from
  // /api/tracks/shuffle?artist=<name> instead of shuffling the loaded subset.
  // Guarded against the brief window during navigation where useParams hasn't
  // resolved name yet — load() falls back to { kind: 'array' } on undefined.
  const shuffleSource: ShuffleSource | undefined = name
    ? { kind: 'filter', artist: name }
    : undefined;

  const onPlayAll = () => {
    if (!tracks.length) return;
    // Plays the loaded queue in linear order. If the user toggles shuffle
    // after this, the filter-source pool kicks in and draws from the full
    // catalog via the refill effect.
    player.load(tracks[0], tracks, shuffleSource);
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <PageHeader>
        <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-3 md:gap-4">
          <div className="min-w-0">
            <SectionTitle label={decodeEntities(name) || 'artist'} />
            {artistRow && (artistRow.city || artistRow.country) && (
              <div className="flex items-center gap-1 text-xs sm:text-[10px] uppercase tracking-[0.25em] text-body-dim mt-1">
                <MapPin size={10} aria-hidden="true" />
                <span className="break-words">{formatProfileLocation(artistRow.city, artistRow.country, artistRow.location_source, artistRow.lat, artistRow.lng)}</span>
              </div>
            )}
            <p className="text-xs text-body-dim mt-1 uppercase tracking-wider bg-bg">
              {total.toLocaleString()} tracks
              {tracks.length > 0 && tracks.length < total && (
                <span className="text-body-very-dim"> · {tracks.length} loaded</span>
              )}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={onPlayAll}
              disabled={!tracks.length}
              className="shrink-0 h-11 sm:h-9 px-4 flex items-center gap-2 border border-accent-dim
                         text-accent uppercase text-xs sm:text-[10px] tracking-[0.25em]
                         hover:border-accent-bright hover:text-accent-bright
                         disabled:opacity-40 disabled:cursor-not-allowed
                         transition-colors"
            >
              <Play size={14} strokeWidth={1.75} />
              play all
            </button>
          </div>
        </div>
      </PageHeader>

      <section className="px-4 sm:px-6 pb-6 bg-bg">
        {tracks.length === 0 && !loading ? (
          <div className="border border-accent-dim p-4 sm:p-6 text-body-very-dim text-sm uppercase tracking-wider">
            no tracks found for this artist
          </div>
        ) : (
          <div className="border border-accent-dim p-3">
            <TrackList
              tracks={tracks}
              loading={loading}
              hasMore={hasMore}
              loadMore={loadMore}
              shuffleSource={shuffleSource}
              hideArtist
            />
          </div>
        )}
      </section>
    </div>
  );
}
