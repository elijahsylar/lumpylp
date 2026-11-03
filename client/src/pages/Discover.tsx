import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertCircle, Info, MapPin, Shuffle } from 'lucide-react';
import type { Track } from '../types/track';
import { TrackList } from '../components/TrackList';
import { PageHeader, SectionTitle } from '../components/PageHeader';
import { decodeEntities } from '../lib/text';
import { displayCity, displayCountry } from '../lib/locationDisplay';
import { announce } from '../lib/announce';
import { useNavigate } from 'react-router-dom';
import { usePlayer } from '../hooks/usePlayer';

type Lens = 'local';
const LENSES: { value: Lens; label: string; available: boolean }[] = [
  { value: 'local', label: 'local', available: true },
];

const RADII = [25, 50, 100, 250] as const;
type Radius = (typeof RADII)[number];

interface ArtistResult {
  id: number;
  name: string;
  source: string;
  city: string | null;
  country: string | null;
  location_source: string | null;
  lat: number | null;
  lng: number | null;
  distance_miles: number;
  track_count: number;
  top_genres: string[];
}

interface DiscoverCitiesResponse {
  query: string;
  resolved: { display_name: string; lat: number; lng: number };
  radius_miles: number;
  artist_count: number;
  artists: ArtistResult[];
  track_count: number;
  total_tracks: number;
  tracks: (Track & {
    artist_city: string | null;
    artist_country: string | null;
    artist_distance_miles: number;
  })[];
}

interface TopCity {
  city: string;
  country: string | null;
  location_source: string | null;
  lat: number;
  lng: number;
  artist_count: number;
  sample_artists: string[];
}

function formatLocation(
  city: string | null,
  country: string | null,
  locationSource?: string | null,
  lat?: number | null,
  lng?: number | null
): string {
  const cityDisp = displayCity(city);
  const countryDisp = displayCountry(country, locationSource, {
    lat: lat ?? undefined,
    lng: lng ?? undefined,
  });
  if (cityDisp && countryDisp) return `${cityDisp}, ${countryDisp.name}`;
  if (cityDisp) return cityDisp;
  if (countryDisp) return countryDisp.name;
  return '';
}

export function Discover() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const player = usePlayer();
  const lens: Lens = (params.get('lens') as Lens) || 'local';
  const cityQuery = params.get('city') || '';
  const radiusFromUrl = parseInt(params.get('radius') || '', 10);
  const radius: Radius = (RADII as readonly number[]).includes(radiusFromUrl)
    ? (radiusFromUrl as Radius)
    : 50;

  // Search-state response
  const [data, setData] = useState<DiscoverCitiesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // "Shuffle all in {city}" button state.
  // shuffleLoading: between click and first-batch fetch resolving.
  // shuffleInfoOpen: tooltip toggle for the (i) icon — controlled so it
  // works on touch devices (CSS :hover alone wouldn't).
  const [shuffleLoading, setShuffleLoading] = useState(false);
  const [shuffleInfoOpen, setShuffleInfoOpen] = useState(false);

  // Default-state top-cities
  const [topCities, setTopCities] = useState<TopCity[] | null>(null);
  const [topLoading, setTopLoading] = useState(false);

  // Search input state — controlled, debounced commit on Enter / button
  const [inputValue, setInputValue] = useState(cityQuery);
  useEffect(() => { setInputValue(cityQuery); }, [cityQuery]);

  const reqIdRef = useRef(0);

  // Fetch results when city/radius in URL changes
  useEffect(() => {
    if (!cityQuery) {
      setData(null);
      setError(null);
      return;
    }
    const myReq = ++reqIdRef.current;
    setLoading(true);
    setError(null);
    const sp = new URLSearchParams({ q: cityQuery, radius: String(radius) });
    fetch(`/api/discover/cities?${sp.toString()}`)
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (reqIdRef.current !== myReq) return;
        if (!r.ok) {
          setError(body.error || 'Could not find that city. Try "City, State" or "City, Country".');
          setData(null);
        } else {
          setData(body);
          announce(
            `${body.artist_count} artists within ${body.radius_miles} miles of ${body.resolved.display_name}`
          );
        }
      })
      .catch(() => {
        if (reqIdRef.current !== myReq) return;
        setError('Could not load results. Try again.');
      })
      .finally(() => {
        if (reqIdRef.current === myReq) setLoading(false);
      });
  }, [cityQuery, radius]);

  // Fetch top cities for the empty state
  useEffect(() => {
    if (cityQuery) return;
    if (topCities !== null) return;
    setTopLoading(true);
    fetch('/api/discover/top-cities')
      .then((r) => r.json())
      .then((d) => setTopCities(d.cities || []))
      .catch(() => setTopCities([]))
      .finally(() => setTopLoading(false));
  }, [cityQuery, topCities]);

  const submit = (q: string) => {
    const trimmed = q.trim();
    if (!trimmed) return;
    const np = new URLSearchParams();
    np.set('lens', 'local');
    np.set('city', trimmed);
    if (radius !== 50) np.set('radius', String(radius));
    setParams(np, { replace: false });
  };

  const onShuffleAll = async () => {
    if (!data || data.artist_count === 0 || shuffleLoading) return;
    const { lat, lng } = data.resolved;
    const r = data.radius_miles;
    setShuffleLoading(true);
    try {
      const sp = new URLSearchParams({
        n: '50',
        lat: String(lat),
        lng: String(lng),
        radius: String(r),
      });
      const res = await fetch(`/api/tracks/shuffle?${sp.toString()}`);
      if (!res.ok) throw new Error(`shuffle ${res.status}`);
      const body = await res.json();
      const batch: Track[] = body.tracks || [];
      if (!batch.length) return;
      // Force shuffle mode so the refill effect fires once upcoming runs low.
      // The pre-fetched batch is already server-randomized, so playing them
      // linearly while we wait for refill is effectively shuffled.
      player.setPlayMode('shuffle');
      player.load(batch[0], batch, { kind: 'location', lat, lng, radius: r });
      announce(`shuffling ${data.total_tracks} tracks in ${data.resolved.display_name}`);
    } catch {
      // Surface inline next to the button. Keeps errors local.
      setError('Could not start shuffle. Try again.');
    } finally {
      setShuffleLoading(false);
    }
  };

  const setRadius = (r: Radius) => {
    const np = new URLSearchParams(params);
    np.set('lens', 'local');
    if (cityQuery) np.set('city', cityQuery);
    if (r !== 50) np.set('radius', String(r));
    else np.delete('radius');
    setParams(np, { replace: true });
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <PageHeader>
        <SectionTitle label="discover" />
        <p className="text-xs text-body-dim mt-1 uppercase tracking-wider">
          find music through different lenses
        </p>
      </PageHeader>

      <section className="px-4 sm:px-6 pb-10 bg-bg" aria-label="discover">
        {/* Lens tabs */}
        <div role="tablist" aria-label="discovery lens" className="flex flex-wrap gap-2 mb-6">
          {LENSES.map((l) => (
            <button
              key={l.value}
              role="tab"
              aria-selected={lens === l.value}
              disabled={!l.available}
              className={`h-11 sm:h-7 px-4 sm:px-3 text-xs sm:text-[10px] uppercase tracking-[0.2em] border transition-colors ${
                lens === l.value
                  ? 'bg-accent text-bg border-accent'
                  : 'border-accent-dim text-accent hover:border-accent-bright hover:text-accent-bright'
              }`}
            >
              {l.label}
            </button>
          ))}
          <span className="text-xs sm:text-[10px] uppercase tracking-[0.2em] text-body-very-dim self-center ml-2">
            more lenses coming soon
          </span>
        </div>

        {/* Search input */}
        <form
          className="flex flex-col sm:flex-row gap-2 mb-6"
          onSubmit={(e) => { e.preventDefault(); submit(inputValue); }}
        >
          <label className="flex-1 flex flex-col gap-1">
            <span className="sr-only">city or place</span>
            <input
              type="search"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              placeholder='try "Portland, OR" or "Berlin" or "Tokyo, Japan"'
              aria-label="search by city"
              className="h-11 sm:h-10 px-3 bg-bg border border-accent-dim focus:border-accent
                         outline-none font-mono text-sm text-body
                         placeholder:text-body-very-dim transition-colors"
            />
          </label>
          <button
            type="submit"
            className="h-11 sm:h-10 px-5 border border-accent text-accent uppercase text-xs sm:text-[10px] tracking-[0.25em]
                       hover:border-accent-bright hover:text-accent-bright transition-colors"
          >
            browse
          </button>
        </form>

        {/* Search-state */}
        {cityQuery && (
          <>
            {error && (
              <div
                role="alert"
                aria-live="assertive"
                className="mb-4 flex items-center gap-2 text-red-500 text-xs uppercase tracking-wider"
              >
                <AlertCircle size={14} aria-hidden="true" />
                <span>{error}</span>
              </div>
            )}
            {loading && !data && (
              <p
                role="status"
                aria-live="polite"
                className="text-body-dim text-sm py-6"
              >
                searching…
              </p>
            )}
            {data && (
              <>
                <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 mb-3">
                  <h3 className="text-accent uppercase tracking-[0.2em] text-xs">
                    {data.artist_count} {data.artist_count === 1 ? 'artist' : 'artists'} within {data.radius_miles} miles of {data.resolved.display_name}
                  </h3>

                  {data.artist_count > 0 && data.total_tracks > 0 && (
                    <div className="flex items-center gap-2 flex-wrap">
                      <button
                        type="button"
                        onClick={onShuffleAll}
                        disabled={shuffleLoading}
                        className="flex items-center gap-2 h-11 sm:h-8 px-3 border border-accent text-accent
                                   uppercase text-xs sm:text-[10px] tracking-[0.25em]
                                   hover:border-accent-bright hover:text-accent-bright
                                   disabled:opacity-50 disabled:cursor-wait transition-colors"
                      >
                        <Shuffle size={12} aria-hidden="true" />
                        <span>
                          {shuffleLoading
                            ? 'loading…'
                            : `shuffle all in ${cityQuery || 'nearby'}`}
                        </span>
                        <span className="text-body-dim normal-case tracking-normal">
                          — {data.total_tracks.toLocaleString()} {data.total_tracks === 1 ? 'track' : 'tracks'}
                        </span>
                      </button>

                      <div className="relative">
                        <button
                          type="button"
                          onClick={() => setShuffleInfoOpen((v) => !v)}
                          onMouseEnter={() => setShuffleInfoOpen(true)}
                          onMouseLeave={() => setShuffleInfoOpen(false)}
                          aria-label="about location shuffle coverage"
                          aria-expanded={shuffleInfoOpen}
                          className="flex items-center justify-center w-11 h-11 sm:w-7 sm:h-7 border border-accent-dim
                                     text-accent-dim hover:border-accent hover:text-accent
                                     transition-colors"
                        >
                          <Info size={12} aria-hidden="true" />
                        </button>
                        {shuffleInfoOpen && (
                          <div
                            role="tooltip"
                            className="absolute right-0 top-9 z-10 w-64 border border-accent-dim
                                       bg-bg p-3 text-xs sm:text-[11px] text-body-dim leading-snug shadow-lg"
                          >
                            Limited to artists with location data
                            (~41% of catalog).
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>

                {/* Radius selector */}
                <div className="flex flex-wrap gap-2 mb-6" role="group" aria-label="search radius">
                  {RADII.map((r) => (
                    <button
                      key={r}
                      onClick={() => setRadius(r)}
                      aria-pressed={radius === r}
                      className={`h-11 sm:h-7 px-4 sm:px-3 text-xs sm:text-[10px] uppercase tracking-[0.2em] border transition-colors ${
                        radius === r
                          ? 'bg-accent text-bg border-accent'
                          : 'border-accent-dim text-accent hover:border-accent-bright hover:text-accent-bright'
                      }`}
                    >
                      within {r} mi
                    </button>
                  ))}
                </div>

                {data.artist_count === 0 ? (
                  <div className="border border-accent-dim p-4 sm:p-6 text-body-dim text-sm">
                    No LumpyLP artists found within {data.radius_miles} miles of{' '}
                    {data.resolved.display_name} yet. Be the first — encourage local
                    artists to sign up.
                  </div>
                ) : (
                  <>
                    {/* ARTISTS */}
                    <h4 className="text-accent uppercase tracking-[0.2em] text-xs sm:text-[11px] mb-3">artists</h4>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 mb-8">
                      {data.artists.map((a) => (
                        <button
                          key={`${a.source}:${a.id}`}
                          type="button"
                          onClick={() => navigate(`/artists/${encodeURIComponent(a.name)}`)}
                          className="group text-left border border-accent-dim bg-bg hover:border-accent-bright
                                     hover:bg-accent/5 px-4 py-3 transition-colors"
                        >
                          <div className="flex items-start justify-between gap-2 mb-1">
                            <span className="text-sm text-white break-words line-clamp-2 group-hover:text-accent-bright">
                              {decodeEntities(a.name)}
                            </span>
                            <span className="shrink-0 text-xs sm:text-[9px] uppercase tracking-[0.2em] text-accent-dim border border-accent-dim/60 px-1.5 py-0.5">
                              {a.distance_miles} mi
                            </span>
                          </div>
                          <div className="text-xs sm:text-[11px] text-body-dim flex items-center gap-1">
                            <MapPin size={10} aria-hidden="true" />
                            <span className="truncate">
                              {formatLocation(a.city, a.country, a.location_source, a.lat, a.lng) || '(no location)'}
                            </span>
                          </div>
                          {a.top_genres.length > 0 && (
                            <div className="text-xs sm:text-[10px] text-body-very-dim uppercase tracking-[0.18em] mt-1 break-words">
                              {a.top_genres.join(' · ')}
                            </div>
                          )}
                          <div className="text-xs sm:text-[10px] text-body-very-dim uppercase tracking-[0.18em] mt-1">
                            {a.track_count} {a.track_count === 1 ? 'track' : 'tracks'}
                          </div>
                        </button>
                      ))}
                    </div>

                    {/* TRACKS */}
                    <h4 className="text-accent uppercase tracking-[0.2em] text-xs sm:text-[11px] mb-3">
                      top of the heap
                    </h4>
                    <div className="border border-accent-dim p-3">
                      <TrackList tracks={data.tracks as Track[]} loading={false} countMode="lumps" />
                    </div>
                  </>
                )}
              </>
            )}
          </>
        )}

        {/* Default state — top cities preview */}
        {!cityQuery && (
          <>
            <h3 className="text-accent uppercase tracking-[0.2em] text-xs mb-4">browse by city</h3>
            {topLoading && (
              <p role="status" aria-live="polite" className="text-body-dim text-sm py-6">
                loading cities…
              </p>
            )}
            {topCities && topCities.length > 0 && (
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-3">
                {topCities.map((c, i) => {
                  const cityDisp = displayCity(c.city) || '?';
                  const countryDisp = displayCountry(c.country, c.location_source, { lat: c.lat, lng: c.lng });
                  return (
                    <button
                      key={`${c.lat.toFixed(2)}_${c.lng.toFixed(2)}_${i}`}
                      type="button"
                      onClick={() => submit(`${cityDisp}${countryDisp ? ', ' + countryDisp.name : ''}`)}
                      className="group text-left border border-accent-dim bg-bg hover:border-accent-bright
                                 hover:bg-accent/5 p-4 transition-colors"
                    >
                      <div className="text-sm text-white break-words line-clamp-2 group-hover:text-accent-bright">
                        {cityDisp}
                      </div>
                      {countryDisp && (
                        <div className="text-xs sm:text-[10px] uppercase tracking-[0.2em] text-accent-dim mt-0.5 break-words">
                          {countryDisp.name}
                        </div>
                      )}
                      <div className="text-xs sm:text-[10px] uppercase tracking-[0.2em] text-body-dim mt-2">
                        {c.artist_count} {c.artist_count === 1 ? 'artist' : 'artists'}
                      </div>
                      {c.sample_artists.length > 0 && (
                        <div className="text-xs sm:text-[10px] text-body-very-dim mt-2 line-clamp-2">
                          {c.sample_artists.map(decodeEntities).join(' · ')}
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
