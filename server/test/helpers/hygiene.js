// Repo hygiene rules: no env files, keys or database dumps tracked in git,
// no live secret-shaped strings in tracked text, and .env.example values must
// be placeholders. Pure functions so tests can feed planted inputs.
export const FORBIDDEN_PATH_RULES = [
  [/(^|\/)\.env($|\.)(?!example$)/, 'env file'],
  [/\.(pem|key|crt|p12|pfx)$/i, 'key or certificate'],
  [/\.(sql\.gz|dump|bak)$/i, 'dump or backup'],
  [/(^|\/)[^/]*backup[^/]*\.(sql|env|json)$/i, 'backup file'],
];

export function forbiddenTrackedPaths(paths) {
  const bad = [];
  for (const p of paths) {
    // Migrations and the schema snapshot are the only SQL allowed in git.
    if (/\.sql$/i.test(p) && !/^server\/(migrations|db)\/[^/]+\.sql$/.test(p)) bad.push([p, 'sql file outside migrations/db']);
    for (const [re, why] of FORBIDDEN_PATH_RULES) if (re.test(p)) bad.push([p, why]);
  }
  return bad;
}

export const SECRET_PATTERNS = [
  [/\b(sk|rk)_live_[A-Za-z0-9]{10,}/, 'Stripe live secret key'],
  [/\bwhsec_[A-Za-z0-9]{16,}/, 'Stripe webhook secret'],
  [/-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/, 'private key'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key id'],
];

export function secretHits(text) {
  return SECRET_PATTERNS.filter(([re]) => re.test(text)).map(([, why]) => why);
}

// Keys whose example value may be a real-looking non-secret default.
const NON_SECRET_KEYS = new Set(['NODE_ENV', 'PORT', 'HOST', 'DB_HOST', 'DB_PORT', 'DB_NAME', 'PUBLIC_URL',
  'FMA_API_BASE', 'DB_SSL_REJECT_UNAUTHORIZED', 'AUDIUS_APP_NAME', 'SUPPORT_URL', 'TRUST_PROXY']);
const PLACEHOLDER = /^(|<[^>]*>|REPLACE_ME.*|change-?me|example.*|x+)$/i;

// Returns the KEY names whose value is not an obvious placeholder.
export function nonPlaceholderKeys(envExampleText) {
  const out = [];
  for (const line of envExampleText.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || NON_SECRET_KEYS.has(m[1])) continue;
    const v = m[2].replace(/^["']|["']$/g, '');
    if (!PLACEHOLDER.test(v)) out.push(m[1]);
  }
  return out;
}
