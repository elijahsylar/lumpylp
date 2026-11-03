import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';

const TOKEN_KEY = 'lumpylp_token';

import type { ThemeName } from './theme';

export interface User {
  id: number;
  username: string;
  email: string;
  theme?: ThemeName;
}

interface AuthCtx {
  user: User | null;
  token: string | null;
  loading: boolean;
  login: (emailOrUsername: string, password: string) => Promise<void>;
  signup: (fields: { email: string; username: string; password: string; turnstile_token: string }) => Promise<void>;
  /** Replace the stored token, e.g. after a password change revoked the old one. */
  replaceToken: (token: string) => void;
  logout: () => void;
  /** Locally update the user's theme — used by the settings page after a
   *  successful PATCH so the AuthContext stays in sync. */
  updateTheme: (theme: ThemeName) => void;
}

const AuthContext = createContext<AuthCtx | null>(null);

export function useAuth(): AuthCtx {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>');
  return ctx;
}

export function getStoredToken(): string | null {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}

function storeToken(t: string | null) {
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* SSR / storage disabled — ignore */ }
}

async function apiPostJson<T>(url: string, body: unknown, token?: string | null): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data && typeof data.error === 'string') ? data.error : `request failed (${res.status})`;
    throw new Error(msg);
  }
  return data as T;
}

interface AuthResponse {
  token: string;
  user: User;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() => getStoredToken());
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  // /me is the single source of truth for "are we signed in?". A 401
  // here just means anonymous — the site is publicly browseable, so we
  // simply leave the user state cleared and let route-level UI decide
  // whether to prompt for login. (Account-gated API calls return 401
  // and the SPA surfaces those at the action site.)
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch('/api/auth/me', {
      credentials: 'include',
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    })
      .then(async (res) => {
        if (cancelled) return;
        if (res.status === 401) {
          storeToken(null);
          setToken(null);
          setUser(null);
          return;
        }
        if (!res.ok) throw new Error('me failed');
        const data = await res.json();
        setUser(data.user || null);
      })
      .catch(() => {
        // Transient network error — leave state alone.
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [token]);

  const login = useCallback(async (emailOrUsername: string, password: string) => {
    const data = await apiPostJson<AuthResponse>('/api/auth/login', { emailOrUsername, password });
    storeToken(data.token);
    setToken(data.token);
    setUser(data.user);
  }, []);

  const signup = useCallback(async (fields: { email: string; username: string; password: string; turnstile_token: string }) => {
    const data = await apiPostJson<AuthResponse>('/api/auth/signup', fields);
    storeToken(data.token);
    setToken(data.token);
    setUser(data.user);
  }, []);

  const replaceToken = useCallback((t: string) => {
    storeToken(t);
    setToken(t);
  }, []);

  const logout = useCallback(() => {
    // Drops the JWT client-side and clears the legacy soft-launch
    // cookie server-side.
    fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }).catch(() => {});
    storeToken(null);
    setToken(null);
    setUser(null);
  }, []);

  const updateTheme = useCallback((theme: ThemeName) => {
    setUser((u) => (u ? { ...u, theme } : u));
  }, []);

  return (
    <AuthContext.Provider value={{ user, token, loading, login, signup, replaceToken, logout, updateTheme }}>
      {children}
    </AuthContext.Provider>
  );
}
