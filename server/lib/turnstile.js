// Cloudflare Turnstile verification for signup (owner decision 1).
// The site key is public (served by /api/config); the secret stays on the
// server. Without a secret, signup is refused (fail closed).
const DEFAULT_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export function turnstileConfigured() {
  return !!process.env.TURNSTILE_SECRET_KEY;
}

// Returns true only when Cloudflare confirms the token.
export async function verifyTurnstile(token, remoteip) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret || !token || typeof token !== 'string' || token.length > 2048) return false;
  const body = new URLSearchParams({ secret, response: token });
  if (remoteip) body.set('remoteip', remoteip);
  try {
    const res = await fetch(process.env.TURNSTILE_VERIFY_URL || DEFAULT_VERIFY_URL, {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return false;
    const data = await res.json();
    return data?.success === true;
  } catch {
    return false;
  }
}
