import { useCallback, useState, type FormEvent } from 'react';
import { useNavigate, NavLink, useSearchParams } from 'react-router-dom';
import { AlertCircle } from 'lucide-react';
import { z } from 'zod';
import { useAuth } from '../lib/auth';
import { useSiteConfig } from '../lib/config';
import { safeRedirect } from '../lib/redirect';
import { Turnstile } from '../components/Turnstile';
import { PageHeader, SectionTitle } from '../components/PageHeader';

type Tab = 'login' | 'signup';

const SignupForm = z.object({
  email:    z.string().trim().toLowerCase().email('valid email required').max(255),
  username: z.string().trim().min(3, 'username must be at least 3 chars').max(30, 'username too long').regex(/^[a-zA-Z0-9_-]+$/, 'username: letters, numbers, _ or - only'),
  password: z.string().min(8, 'password must be at least 8 chars')
    .refine((s) => new TextEncoder().encode(s).length <= 72, 'password must be at most 72 bytes'),
});

const LoginForm = z.object({
  emailOrUsername: z.string().trim().min(1, 'required'),
  password:        z.string().min(1, 'required'),
});

export function Login() {
  const [params] = useSearchParams();
  const [tab, setTab] = useState<Tab>('login');
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [confirm, setConfirm] = useState('');
  const [emailOrUsername, setEmailOrUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  // Turnstile tokens are single-use: after any failed signup the widget is
  // remounted for a fresh token (review R6).
  const [turnstileKey, setTurnstileKey] = useState(0);
  const onTurnstileToken = useCallback((t: string | null) => setTurnstileToken(t), []);
  const { turnstile_site_key: siteKey } = useSiteConfig();
  const auth = useAuth();
  const navigate = useNavigate();

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      if (tab === 'login') {
        const parsed = LoginForm.safeParse({ emailOrUsername, password });
        if (!parsed.success) throw new Error(parsed.error.issues[0]?.message || 'invalid input');
        await auth.login(parsed.data.emailOrUsername, parsed.data.password);
        // Gated pages send users here as /login?redirect=/lumps. Only
        // same-origin paths are honoured (lib/redirect.ts).
        navigate(safeRedirect(params.get('redirect')));
      } else {
        if (password !== confirm) throw new Error('passwords do not match');
        const parsed = SignupForm.safeParse({ email, username, password });
        if (!parsed.success) throw new Error(parsed.error.issues[0]?.message || 'invalid input');
        if (!turnstileToken) throw new Error('please complete the verification');
        // Free account: the server verifies the Turnstile token, creates the
        // user and signs them in.
        await auth.signup({ ...parsed.data, turnstile_token: turnstileToken });
        navigate('/');
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'something went wrong');
      setBusy(false);
      if (tab === 'signup') {
        setTurnstileToken(null);
        setTurnstileKey((k) => k + 1);
      }
    }
  };

  const tabBtn = (t: Tab, label: string) => (
    <button
      type="button"
      onClick={() => { setTab(t); setError(null); }}
      className={`flex-1 h-11 sm:h-9 text-xs sm:text-[10px] uppercase tracking-[0.25em] border transition-colors ${
        tab === t
          ? 'bg-accent text-bg border-accent'
          : 'border-accent-dim text-accent hover:border-accent-bright hover:text-accent-bright'
      }`}
    >
      {label}
    </button>
  );

  // text-base (16px) below sm: is deliberate — iOS Safari zooms the whole
  // page when a focused input's font-size is under 16px.
  const inputCls = `w-full h-11 sm:h-9 bg-bg border border-accent-dim focus:border-accent
                    outline-none font-mono text-base sm:text-sm px-3 text-body
                    placeholder:text-body-very-dim transition-colors`;

  return (
    <div className="flex-1 overflow-y-auto">
      <PageHeader>
        <SectionTitle label={tab === 'login' ? 'log in' : 'sign up'} />
        <p className="text-xs text-body-dim mt-1 uppercase tracking-wider">
          lump up the music you love. lump down the noise.
        </p>
      </PageHeader>

      <section className="px-4 sm:px-6 pb-6 max-w-md mx-auto w-full bg-bg">
        <div className="flex gap-2 mb-5">
          {tabBtn('login', 'log in')}
          {tabBtn('signup', 'sign up')}
        </div>

        <form onSubmit={onSubmit} className="border border-accent-dim p-5 flex flex-col gap-4">
          {tab === 'login' ? (
            <>
              <label className="flex flex-col gap-1">
                <span className="text-xs sm:text-[10px] text-accent-dim uppercase tracking-[0.25em]">email or username</span>
                <input
                  type="text"
                  autoComplete="username"
                  autoFocus
                  value={emailOrUsername}
                  onChange={(e) => setEmailOrUsername(e.target.value)}
                  className={inputCls}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs sm:text-[10px] text-accent-dim uppercase tracking-[0.25em]">password</span>
                <input
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className={inputCls}
                />
              </label>
            </>
          ) : (
            <>
              <label className="flex flex-col gap-1">
                <span className="text-xs sm:text-[10px] text-accent-dim uppercase tracking-[0.25em]">email</span>
                <input
                  type="email"
                  autoComplete="email"
                  autoFocus
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className={inputCls}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs sm:text-[10px] text-accent-dim uppercase tracking-[0.25em]">username</span>
                <input
                  type="text"
                  autoComplete="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className={inputCls}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs sm:text-[10px] text-accent-dim uppercase tracking-[0.25em]">password (min 8)</span>
                <input
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className={inputCls}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs sm:text-[10px] text-accent-dim uppercase tracking-[0.25em]">confirm password</span>
                <input
                  type="password"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  className={inputCls}
                />
              </label>
            </>
          )}

          {tab === 'signup' && siteKey && (
            <Turnstile key={turnstileKey} siteKey={siteKey} onToken={onTurnstileToken} />
          )}

          <button
            type="submit"
            disabled={busy}
            className="h-11 sm:h-9 px-4 border border-accent text-accent uppercase text-xs sm:text-[10px] tracking-[0.25em]
                       hover:border-accent-bright hover:text-accent-bright
                       disabled:opacity-40 disabled:cursor-not-allowed
                       transition-colors"
          >
            {busy ? '…' : tab === 'login' ? 'log in' : 'create account'}
          </button>

          {tab === 'signup' && (
            <div className="text-xs sm:text-[10px] text-body-dim leading-relaxed">
              <p>
                Accounts are free. They&rsquo;re for lumping and playlists;
                listening never needs one.
              </p>
            </div>
          )}

          {error && (
            <div
              role="alert"
              aria-live="assertive"
              className="flex items-center gap-2 text-red-500 text-xs uppercase tracking-wider"
            >
              <AlertCircle size={14} aria-hidden="true" />
              <span>{error}</span>
            </div>
          )}
        </form>

        <p className="mt-4 text-center">
          <NavLink
            to="/about"
            className="inline-flex items-center justify-center min-h-[44px] md:min-h-[24px] px-2 text-xs sm:text-[10px] uppercase tracking-[0.25em] text-accent-dim hover:text-accent-bright transition-colors"
          >
            what is lumpylp?
          </NavLink>
        </p>
      </section>
    </div>
  );
}
