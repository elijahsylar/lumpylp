// Rate limits (relaunch item 4). In-memory: the API is one process, and a
// restart resetting the counters is acceptable. Limits can be lowered or raised
// per name with RATE_LIMITS='{"login": 20}' (tests use small values).
//
// Client IP: Express reads it from X-Forwarded-For only for proxies it trusts
// (app.set('trust proxy', TRUST_PROXY || 'loopback')). On the server, nginx
// must set X-Forwarded-For from CF-Connecting-IP for Cloudflare source ranges
// only; without that every client looks like 127.0.0.1 and the IP-keyed
// limits become global.
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';

const MIN = 60 * 1000;
export const DEFAULT_LIMITS = {
  login:         { windowMs: 15 * MIN, max: 10 },   // per IP
  loginFailures: { windowMs: 15 * MIN, max: 5 },    // per IP + username, failures only
  signup:        { windowMs: 60 * MIN, max: 5 },    // per IP
  password:      { windowMs: 60 * MIN, max: 5 },    // per user (change; a future reset reuses it)
  lumpWrites:    { windowMs: 10 * MIN, max: 60 },   // per user
  votes:         { windowMs: 10 * MIN, max: 120 },  // per user
  search:        { windowMs: 1 * MIN,  max: 60 },   // per IP
  stream:        { windowMs: 1 * MIN,  max: 120 },  // per IP
  discover:      { windowMs: 1 * MIN,  max: 20 },   // per IP (can trigger geocoding)
  api:           { windowMs: 1 * MIN,  max: 300 },  // per IP, everything under /api
};

function configured(name) {
  let overrides = {};
  try { overrides = JSON.parse(process.env.RATE_LIMITS || '{}'); } catch { /* ignore bad JSON */ }
  const base = DEFAULT_LIMITS[name];
  const o = overrides[name];
  return typeof o === 'number' ? { ...base, max: o } : { ...base, ...(o || {}) };
}

const ipKey = (req) => ipKeyGenerator(req.ip || '');
const userKey = (req) => (req.user?.id ? `u:${req.user.id}` : `ip:${ipKey(req)}`);

function make(name, opts = {}) {
  const { windowMs, max } = configured(name);
  return rateLimit({
    windowMs,
    limit: max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: ipKey,
    message: { error: 'too many requests, slow down' },
    ...opts,
    handler: (req, res, _next, options) => {
      // Seconds until this client's window resets (falls back to the window).
      const reset = req.rateLimit?.resetTime;
      const secs = reset ? Math.ceil((reset.getTime() - Date.now()) / 1000) : Math.ceil(options.windowMs / 1000);
      res.setHeader('Retry-After', String(Math.max(1, secs)));
      res.status(429).json(options.message);
    },
  });
}

// Built on first use, so a test (one process per file) can set RATE_LIMITS
// before the app is created.
export function buildLimiters() {
  return {
    login: make('login'),
    loginFailures: make('loginFailures', {
      keyGenerator: (req) => `${ipKey(req)}|${String(req.body?.emailOrUsername || '').trim().toLowerCase()}`,
      skipSuccessfulRequests: true,
    }),
    signup: make('signup'),
    password: make('password', { keyGenerator: userKey }),
    lumpWrites: make('lumpWrites', { keyGenerator: userKey }),
    votes: make('votes', { keyGenerator: userKey }),
    search: make('search'),
    stream: make('stream'),
    discover: make('discover'),
    api: make('api'),
  };
}

let shared = null;
// One shared set per process; route modules and app.js all use it.
export function limiters() {
  if (!shared) shared = buildLimiters();
  return shared;
}
