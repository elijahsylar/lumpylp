import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, AlertCircle } from 'lucide-react';
import { PageHeader, SectionTitle } from '../components/PageHeader';
import { useAuth } from '../lib/auth';
import { api } from '../lib/api';
import { announce } from '../lib/announce';
import {
  THEMES,
  applyTheme,
  setStoredTheme,
  type ThemeName,
} from '../lib/theme';

export function Settings() {
  const { user, loading: authLoading, updateTheme, replaceToken } = useAuth();
  const navigate = useNavigate();
  const [busyTheme, setBusyTheme] = useState<ThemeName | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [currentPwd, setCurrentPwd] = useState('');
  const [newPwd, setNewPwd] = useState('');
  const [confirmPwd, setConfirmPwd] = useState('');
  const [pwdSubmitting, setPwdSubmitting] = useState(false);
  // Distinguish field-level vs general so we can attach via aria-describedby.
  const [pwdCurrentError, setPwdCurrentError] = useState<string | null>(null);
  const [pwdNewError, setPwdNewError] = useState<string | null>(null);
  const [pwdGeneralError, setPwdGeneralError] = useState<string | null>(null);
  const [pwdSuccess, setPwdSuccess] = useState(false);

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      navigate('/login?redirect=' + encodeURIComponent('/settings'), { replace: true });
    }
  }, [user, authLoading, navigate]);

  if (!user) return null;

  const current: ThemeName = (user.theme as ThemeName) || 'underground';

  const onChangePassword = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (pwdSubmitting) return;

    setPwdCurrentError(null);
    setPwdNewError(null);
    setPwdGeneralError(null);
    setPwdSuccess(false);

    if (!currentPwd || !newPwd || !confirmPwd) {
      setPwdGeneralError('all fields are required');
      return;
    }
    if (newPwd.length < 8) {
      setPwdNewError('new password must be at least 8 characters');
      return;
    }
    if (newPwd !== confirmPwd) {
      setPwdNewError('new password and confirmation do not match');
      return;
    }
    if (newPwd === currentPwd) {
      setPwdNewError('new password must differ from current password');
      return;
    }

    setPwdSubmitting(true);
    try {
      // The server revokes every existing token on a password change and
      // returns a fresh one for this session.
      const res = await api<{ ok: boolean; token?: string }>('/api/auth/me/password', {
        method: 'PATCH',
        json: { current_password: currentPwd, new_password: newPwd },
      });
      if (res.token) replaceToken(res.token);
      setCurrentPwd('');
      setNewPwd('');
      setConfirmPwd('');
      setPwdSuccess(true);
      announce('password updated');
      // Auto-clear the success banner after a few seconds.
      window.setTimeout(() => setPwdSuccess(false), 3000);
    } catch (err: unknown) {
      const status = (err as { status?: number })?.status;
      const msg = err instanceof Error ? err.message : 'failed to update password';
      if (status === 401) {
        setPwdCurrentError('current password is incorrect');
      } else if (status === 429) {
        setPwdGeneralError('too many attempts. try again in an hour.');
      } else if (status === 400) {
        setPwdGeneralError(msg);
      } else {
        setPwdGeneralError(msg);
      }
    } finally {
      setPwdSubmitting(false);
    }
  };

  const onPick = async (name: ThemeName) => {
    if (name === current || busyTheme) return;
    setError(null);
    setBusyTheme(name);
    // Optimistic: apply and persist locally first so the change feels instant.
    applyTheme(name);
    setStoredTheme(name);
    updateTheme(name);
    try {
      await api('/api/auth/me/theme', { method: 'PATCH', json: { theme: name } });
      announce(`theme changed to ${THEMES.find((t) => t.name === name)?.label || name}`);
    } catch (err: unknown) {
      // Roll back on failure.
      applyTheme(current);
      setStoredTheme(current);
      updateTheme(current);
      setError(err instanceof Error ? err.message : 'failed to save theme');
    } finally {
      setBusyTheme(null);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <PageHeader>
        <SectionTitle label="settings" />
        <p className="text-xs text-body-dim mt-1 uppercase tracking-wider">
          preferences for {user.username}
        </p>
      </PageHeader>

      <section className="px-4 sm:px-6 pb-10 max-w-3xl mx-auto bg-bg" aria-label="settings">
        <h3 className="text-accent uppercase tracking-[0.2em] text-xs mt-6 mb-4">
          appearance
        </h3>
        <p className="text-sm text-body-dim mb-5 leading-relaxed">
          Pick a theme. All five meet WCAG 2.2 AA contrast — readable for
          everyone. Your choice syncs across devices.
        </p>

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

        <div
          role="radiogroup"
          aria-label="theme"
          className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3"
        >
          {THEMES.map((t) => {
            const active = t.name === current;
            const busy = busyTheme === t.name;
            return (
              <button
                key={t.name}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => onPick(t.name)}
                disabled={busy}
                className={`text-left bg-bg p-4 transition-colors flex flex-col gap-3
                            ${active
                              ? 'border-2 border-accent-bright bg-accent/5'
                              : 'border border-accent-dim hover:border-accent-bright'
                            }
                            disabled:opacity-60 disabled:cursor-wait`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm uppercase tracking-[0.2em] text-white">
                    {t.label}
                  </span>
                  {active && (
                    <span
                      aria-hidden="true"
                      className="flex items-center gap-1 text-xs sm:text-[10px] uppercase tracking-[0.25em] text-accent-bright"
                    >
                      <Check size={12} strokeWidth={2.5} />
                      current
                    </span>
                  )}
                </div>
                <p className="text-xs text-body-dim leading-relaxed">{t.description}</p>
                <div
                  className="flex h-8 border border-accent-dim/60"
                  aria-hidden="true"
                >
                  <span className="flex-1" style={{ background: t.swatches.bg }} />
                  <span className="flex-1" style={{ background: t.swatches.body }} />
                  <span className="flex-1" style={{ background: t.swatches.accent }} />
                  <span className="flex-1" style={{ background: t.swatches.bright }} />
                </div>
              </button>
            );
          })}
        </div>

        <p className="text-xs sm:text-[10px] text-body-very-dim mt-6 uppercase tracking-[0.2em]">
          all themes verified against WCAG 2.2 AA · 4.5:1 text · 3:1 ui
        </p>

        <h3 className="text-accent uppercase tracking-[0.2em] text-xs mt-10 mb-4">
          change password
        </h3>
        <p className="text-sm text-body-dim mb-5 leading-relaxed">
          You'll stay signed in on this device. Other devices keep their session
          until they sign out.
        </p>

        <form
          onSubmit={onChangePassword}
          className="flex flex-col gap-4 max-w-md"
          aria-label="change password"
          noValidate
        >
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="pwd-current"
              className="text-xs sm:text-[10px] uppercase tracking-[0.25em] text-body-dim"
            >
              current password
            </label>
            <input
              id="pwd-current"
              type="password"
              autoComplete="current-password"
              value={currentPwd}
              onChange={(e) => setCurrentPwd(e.target.value)}
              disabled={pwdSubmitting}
              aria-invalid={pwdCurrentError ? true : undefined}
              aria-describedby={pwdCurrentError ? 'pwd-current-error' : undefined}
              className="bg-bg border border-accent-dim focus:border-accent-bright focus:outline-none px-3 py-2 text-sm text-white disabled:opacity-60"
            />
            {pwdCurrentError && (
              <p
                id="pwd-current-error"
                className="text-xs text-red-500 uppercase tracking-wider flex items-center gap-1.5"
              >
                <AlertCircle size={12} aria-hidden="true" />
                <span>{pwdCurrentError}</span>
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="pwd-new"
              className="text-xs sm:text-[10px] uppercase tracking-[0.25em] text-body-dim"
            >
              new password
            </label>
            <input
              id="pwd-new"
              type="password"
              autoComplete="new-password"
              minLength={8}
              value={newPwd}
              onChange={(e) => setNewPwd(e.target.value)}
              disabled={pwdSubmitting}
              aria-invalid={pwdNewError ? true : undefined}
              aria-describedby={pwdNewError ? 'pwd-new-error' : 'pwd-new-hint'}
              className="bg-bg border border-accent-dim focus:border-accent-bright focus:outline-none px-3 py-2 text-sm text-white disabled:opacity-60"
            />
            <p id="pwd-new-hint" className="text-xs sm:text-[10px] text-body-very-dim uppercase tracking-[0.2em]">
              minimum 8 characters
            </p>
            {pwdNewError && (
              <p
                id="pwd-new-error"
                className="text-xs text-red-500 uppercase tracking-wider flex items-center gap-1.5"
              >
                <AlertCircle size={12} aria-hidden="true" />
                <span>{pwdNewError}</span>
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="pwd-confirm"
              className="text-xs sm:text-[10px] uppercase tracking-[0.25em] text-body-dim"
            >
              confirm new password
            </label>
            <input
              id="pwd-confirm"
              type="password"
              autoComplete="new-password"
              value={confirmPwd}
              onChange={(e) => setConfirmPwd(e.target.value)}
              disabled={pwdSubmitting}
              className="bg-bg border border-accent-dim focus:border-accent-bright focus:outline-none px-3 py-2 text-sm text-white disabled:opacity-60"
            />
          </div>

          {pwdGeneralError && (
            <p
              role="alert"
              aria-live="assertive"
              className="text-xs text-red-500 uppercase tracking-wider flex items-center gap-1.5"
            >
              <AlertCircle size={12} aria-hidden="true" />
              <span>{pwdGeneralError}</span>
            </p>
          )}

          <div aria-live="polite" className="min-h-[1rem]">
            {pwdSuccess && (
              <p className="text-xs text-accent-bright uppercase tracking-wider flex items-center gap-1.5">
                <Check size={12} aria-hidden="true" />
                <span>password updated</span>
              </p>
            )}
          </div>

          <button
            type="submit"
            disabled={pwdSubmitting}
            className="self-start bg-bg border border-accent-bright text-accent-bright text-xs uppercase tracking-[0.25em] px-5 py-2 hover:bg-accent/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-bright disabled:opacity-60 disabled:cursor-wait"
          >
            {pwdSubmitting ? 'updating…' : 'update password'}
          </button>
        </form>
      </section>
    </div>
  );
}
