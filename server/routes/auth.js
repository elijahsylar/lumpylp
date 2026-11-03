import { Router } from 'express';
import bcrypt from 'bcrypt';
import { z } from 'zod';
import { query } from '../db.js';
import { signToken, requireAuth } from '../middleware/auth.js';
import { limiters } from '../lib/rateLimits.js';
import { verifyTurnstile, turnstileConfigured } from '../lib/turnstile.js';

const router = Router();

const BCRYPT_COST = 12;
// bcrypt only reads the first 72 bytes of a password; longer ones would be
// silently truncated, so they're rejected instead.
const MAX_PASSWORD_BYTES = 72;

const password = (msg) => z.string()
  .min(8, msg)
  .refine((s) => Buffer.byteLength(s, 'utf8') <= MAX_PASSWORD_BYTES, 'password must be at most 72 bytes');

const SignupSchema = z.object({
  email:    z.string().trim().toLowerCase().email().max(255),
  username: z.string().trim().min(3).max(30).regex(/^[a-zA-Z0-9_-]+$/, 'invalid characters'),
  password: password('password must be at least 8 characters'),
  turnstile_token: z.string().min(1, 'verification required').max(2048),
});

const LoginSchema = z.object({
  emailOrUsername: z.string().trim().min(1),
  password:        z.string().min(1),
});

const ChangePasswordSchema = z.object({
  current_password: z.string().min(1),
  new_password:     password('new password must be at least 8 characters'),
});

// Whitelist of valid theme names. Mirrors client/src/lib/theme.ts.
const VALID_THEMES = new Set(['underground', 'amber', 'mono', 'light', 'highcontrast']);

function userPayload(row) {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    theme: VALID_THEMES.has(row.theme) ? row.theme : 'underground',
  };
}

// POST /api/auth/signup — free account. Cloudflare Turnstile must confirm the
// token before anything is written; no email verification (owner decision 1).
// A taken email and a taken username get the same 409, so the response does
// not reveal which one exists.
router.post('/signup', limiters().signup, async (req, res, next) => {
  try {
    if (!turnstileConfigured()) {
      return res.status(503).json({ error: 'signup temporarily unavailable' });
    }
    const parsed = SignupSchema.safeParse(req.body || {});
    if (!parsed.success) {
      const issue = parsed.error.issues?.[0];
      return res.status(400).json({ error: issue?.message || 'invalid input' });
    }
    const { email, username, password: pw, turnstile_token } = parsed.data;

    if (!(await verifyTurnstile(turnstile_token, req.ip))) {
      return res.status(403).json({ error: 'verification failed, please try again' });
    }

    const taken = await query(
      `SELECT id FROM users WHERE email = ? OR username = ? LIMIT 1`,
      [email, username]
    );
    if (taken.length) return res.status(409).json({ error: 'email or username already in use' });

    const password_hash = await bcrypt.hash(pw, BCRYPT_COST);
    let result;
    try {
      result = await query(
        `INSERT INTO users (email, username, password_hash) VALUES (?, ?, ?)`,
        [email, username, password_hash]
      );
    } catch (err) {
      if (err?.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ error: 'email or username already in use' });
      }
      throw err;
    }
    const rows = await query(
      `SELECT id, email, username, theme, token_version FROM users WHERE id = ?`,
      [result.insertId]
    );
    res.status(201).json({ token: signToken(rows[0]), user: userPayload(rows[0]) });
  } catch (err) { next(err); }
});

router.post('/login', limiters().login, limiters().loginFailures, async (req, res, next) => {
  try {
    const parsed = LoginSchema.safeParse(req.body || {});
    if (!parsed.success) {
      // Same opaque error as bad credentials — don't leak field-level info.
      return res.status(401).json({ error: 'invalid credentials' });
    }
    const { emailOrUsername, password: pw } = parsed.data;

    const ident = emailOrUsername.toLowerCase();
    const rows = await query(
      `SELECT id, email, username, password_hash, theme, token_version
       FROM users
       WHERE email = ? OR username = ?
       LIMIT 1`,
      [ident, emailOrUsername] // username is case-sensitive per the regex; email already lowercased
    );
    const user = rows[0];

    // Always run bcrypt.compare (even when user not found) to keep timing
    // similar between "no such user" and "wrong password" paths.
    const ok = user
      ? await bcrypt.compare(pw, user.password_hash)
      : await bcrypt.compare(pw, '$2b$12$invalidsaltinvalidsaltinvalidsaltinvalidsa');

    if (!user || !ok) {
      return res.status(401).json({ error: 'invalid credentials' });
    }

    res.json({ token: signToken(user), user: userPayload(user) });
  } catch (err) { next(err); }
});

router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const rows = await query(
      `SELECT id, username, email, theme FROM users WHERE id = ?`,
      [req.user.id]
    );
    if (!rows.length) return res.status(401).json({ error: 'auth required' });
    res.json({ user: userPayload(rows[0]) });
  } catch (err) { next(err); }
});

// PATCH /api/auth/me/theme — update the active theme. Server-side
// whitelist: invalid values 400; unknown themes never reach the DB.
router.patch('/me/theme', requireAuth, async (req, res, next) => {
  try {
    const theme = String(req.body?.theme || '');
    if (!VALID_THEMES.has(theme)) {
      return res.status(400).json({ error: 'invalid theme' });
    }
    await query(`UPDATE users SET theme = ? WHERE id = ?`, [theme, req.user.id]);
    res.json({ theme });
  } catch (err) { next(err); }
});

// PATCH /api/auth/me/password — change own password. Rate-limited per user.
// Bumps token_version, which signs out every other session; the response
// carries a fresh token for this one.
router.patch('/me/password', requireAuth, limiters().password, async (req, res, next) => {
  try {
    const parsed = ChangePasswordSchema.safeParse(req.body || {});
    if (!parsed.success) {
      const issue = parsed.error.issues?.[0];
      return res.status(400).json({ error: issue?.message || 'invalid input' });
    }
    const { current_password, new_password } = parsed.data;

    if (new_password === current_password) {
      return res.status(400).json({ error: 'new password must differ from current password' });
    }

    const rows = await query(
      `SELECT password_hash FROM users WHERE id = ? LIMIT 1`,
      [req.user.id]
    );
    if (!rows.length) return res.status(401).json({ error: 'auth required' });

    const ok = await bcrypt.compare(current_password, rows[0].password_hash);
    if (!ok) return res.status(401).json({ error: 'current password incorrect' });

    const new_hash = await bcrypt.hash(new_password, BCRYPT_COST);
    await query(
      `UPDATE users SET password_hash = ?, token_version = token_version + 1, updated_at = NOW() WHERE id = ?`,
      [new_hash, req.user.id]
    );
    const fresh = await query(`SELECT id, username, token_version FROM users WHERE id = ?`, [req.user.id]);
    res.json({ ok: true, token: signToken(fresh[0]) });
  } catch (err) { next(err); }
});

router.post('/logout', (_req, res) => {
  // JWT logout is client-side (drop the token). Also clear the legacy
  // lumpylp_token cookie in case an old soft-launch session still has one.
  res.clearCookie('lumpylp_token', { path: '/', sameSite: 'lax', secure: true, httpOnly: true });
  res.json({ ok: true });
});

export default router;
