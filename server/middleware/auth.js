import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '../db.js';

// Load env explicitly — ESM imports are hoisted so server/index.js's
// dotenv.config runs after this module evaluates. Idempotent if env was
// already loaded by a parent module.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Developer .env only: never under test, never in production (review R12).
if (process.env.NODE_ENV !== 'test' && process.env.NODE_ENV !== 'production') {
  dotenv.config({ path: path.resolve(__dirname, '../../.env') });
}

const SECRET = process.env.JWT_SECRET;
if (!SECRET) {
  // Fail fast — don't ever boot the server without a real secret.
  throw new Error('JWT_SECRET is not set in env');
}

const TOKEN_TTL = '7d';

// `tv` is the user's token_version at signing time. Bumping
// users.token_version (password change, admin reset) revokes every token
// signed before it.
export function signToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, tv: user.token_version ?? 0 },
    SECRET,
    { expiresIn: TOKEN_TTL }
  );
}

// Bearer tokens only. The legacy `lumpylp_token` cookie path was removed:
// nothing sets it any more, and accepting it would be CSRF surface.
function readToken(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice('Bearer '.length).trim() : null;
}

// Signature and expiry only; requireAuth adds the DB check.
export function verifyJWT(req, _res, next) {
  const token = readToken(req);
  if (!token) return next();
  try {
    const payload = jwt.verify(token, SECRET);
    req.user = { id: payload.id, username: payload.username, tv: payload.tv ?? 0 };
  } catch {
    // Invalid/expired token — leave req.user undefined; downstream
    // requireAuth will reject if needed.
  }
  next();
}

// requireAuth: a valid JWT whose user still exists and whose token_version
// matches. Every feature is free, so there is no payment check. Sets
// req.user.role from the DB for requireAdmin.
export function requireAuth(req, res, next) {
  verifyJWT(req, res, async () => {
    try {
      if (!req.user) return res.status(401).json({ error: 'auth required' });
      const rows = await query(
        `SELECT role, token_version FROM users WHERE id = ? LIMIT 1`,
        [req.user.id]
      );
      if (!rows.length || Number(rows[0].token_version) !== Number(req.user.tv)) {
        return res.status(401).json({ error: 'auth required' });
      }
      req.user.role = rows[0].role;
      next();
    } catch (err) { next(err); }
  });
}

// requireAdmin: run after requireAuth. The role comes from the DB on every
// request (requireAuth), never from the token, so promotion and demotion take
// effect immediately.
export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'admin only' });
  next();
}

// optionalAuth: like verifyJWT, but a revoked token is treated as anonymous.
export function optionalAuth(req, res, next) {
  verifyJWT(req, res, async () => {
    if (!req.user) return next();
    try {
      const rows = await query(`SELECT token_version FROM users WHERE id = ? LIMIT 1`, [req.user.id]);
      if (!rows.length || Number(rows[0].token_version) !== Number(req.user.tv)) req.user = undefined;
      next();
    } catch (err) { next(err); }
  });
}
