import { useEffect, useState } from 'react';
import { Routes, Route, useNavigate, useLocation } from 'react-router-dom';
import { Menu, X } from 'lucide-react';
import { Sidebar } from './components/Sidebar';
import { Player } from './components/Player';
import { PlayerContext, usePlayerEngine } from './hooks/usePlayer';
import { Home } from './pages/Home';
import { Discover } from './pages/Discover';
import { Genres } from './pages/Genres';
import { Artists } from './pages/Artists';
import { Artist } from './pages/Artist';
import { Search } from './pages/Search';
import { Login } from './pages/Login';
import { Lumps } from './pages/Lumps';
import { Lump } from './pages/Lump';
import { TopOfTheTop } from './pages/TopOfTheTop';
import { Accessibility } from './pages/Accessibility';
import { About } from './pages/About';
import { Settings } from './pages/Settings';
import { NotFound } from './pages/NotFound';
import { AuthProvider, useAuth } from './lib/auth';
import { applyTheme, setStoredTheme, isValidTheme, getStoredTheme } from './lib/theme';

// Syncs the active theme with the authenticated user. Logged-in users see
// their server-stored choice. Anonymous users keep whatever they picked via
// the header switcher (localStorage), falling back to the default only when
// nothing is stored. Lives inside AuthProvider so useAuth() works.
function ThemeSync() {
  const { user, loading } = useAuth();
  useEffect(() => {
    if (loading) return;
    const next = user?.theme && isValidTheme(user.theme) ? user.theme : getStoredTheme();
    applyTheme(next);
    setStoredTheme(next);
  }, [user, loading]);
  return null;
}

export default function App() {
  const player = usePlayerEngine();
  const [genre, setGenre] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  // Close the mobile drawer whenever the route changes.
  useEffect(() => { setSidebarOpen(false); }, [location.pathname]);

  const onGenreSelect = (g: string | null) => {
    setGenre(g);
    setSidebarOpen(false);
    navigate('/');
  };

  return (
    <AuthProvider>
      <ThemeSync />
      <PlayerContext.Provider value={player}>
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-[100]
                     focus:bg-accent focus:text-bg focus:px-3 focus:py-2
                     focus:text-xs focus:uppercase focus:tracking-[0.2em]"
        >
          skip to main content
        </a>
        {/* Mobile hamburger — fixed top-left, hidden at md+ */}
        <button
          type="button"
          onClick={() => setSidebarOpen((o) => !o)}
          aria-label={sidebarOpen ? 'close menu' : 'open menu'}
          aria-expanded={sidebarOpen}
          aria-controls="sidebar"
          className="md:hidden fixed z-50 w-11 h-11 flex items-center justify-center
                     top-[calc(0.5rem+env(safe-area-inset-top))]
                     left-[calc(0.5rem+env(safe-area-inset-left))]
                     border border-accent-dim bg-bg text-accent hover:border-accent-bright hover:text-accent-bright transition-colors"
        >
          {sidebarOpen ? <X size={18} strokeWidth={1.75} /> : <Menu size={18} strokeWidth={1.75} />}
        </button>
        <div className="h-full flex flex-col">
          <div className="flex-1 flex min-h-0">
            <Sidebar
              selectedGenre={genre}
              onGenreSelect={onGenreSelect}
              open={sidebarOpen}
              onClose={() => setSidebarOpen(false)}
            />
            <main id="main-content" tabIndex={-1} className="flex-1 flex flex-col min-w-0 bg-bg outline-none">
              <Routes>
                <Route path="/" element={<Home genre={genre} />} />
                <Route path="/search" element={<Search />} />
                <Route path="/discover" element={<Discover />} />
                <Route path="/genres" element={<Genres onGenreSelect={onGenreSelect} />} />
                <Route path="/artists" element={<Artists />} />
                <Route path="/artists/:name" element={<Artist />} />
                <Route path="/login" element={<Login />} />
                <Route path="/lumps" element={<Lumps />} />
                <Route path="/lumps/:id" element={<Lump />} />
                <Route path="/top" element={<TopOfTheTop />} />
                <Route path="/accessibility" element={<Accessibility />} />
                <Route path="/about" element={<About />} />
                <Route path="/settings" element={<Settings />} />
                {/* Catch-all — must stay last. Without it an unknown URL
                    rendered an empty <main> with no explanation. */}
                <Route path="*" element={<NotFound />} />
              </Routes>
            </main>
          </div>
          <Player />
        </div>
        {/* Polite live region for app-wide announcements (player track changes,
            vote confirmations). Errors use their own
            role="alert" containers at the source. */}
        <div id="aria-live-status" role="status" aria-live="polite" className="sr-only" />
      </PlayerContext.Provider>
    </AuthProvider>
  );
}
