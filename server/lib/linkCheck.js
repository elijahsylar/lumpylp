// Link checking for the dead-link sweep, the only code allowed to mark a
// track dead (relaunch item 5). Pure classification plus one write helper.
//
// Outcomes:
//   alive   - a 2xx after following up to 5 redirects
//   dead    - a definite "not there": 404/410 or any other 4xx except 429,
//             a 3xx without a Location, a redirect loop, DNS failure,
//             connection refused
//   unknown - anything that may be temporary: 429, 5xx, timeouts, other
//             network errors (after retries). Never changes the verdict.

const UA = 'LumpyLP link checker (https://lumpylp.com)';
const REDIRECT_CAP = 5;

// Per-source request headers. ccMixter refuses requests without its own site
// as the Referer (anti-leech); the stream proxy sends the same header, so a
// check without it would call live tracks dead.
export function requestHeadersFor(source) {
  return source === 'ccmixter' ? { Referer: 'https://ccmixter.org/' } : {};
}

async function once(url, { source, timeoutMs, fetchImpl, method = 'HEAD', hops = 0 }) {
  if (hops > REDIRECT_CAP) return { kind: 'final', state: 'dead', code: 310 };
  let res;
  try {
    res = await fetchImpl(url, {
      method,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'User-Agent': UA, ...requestHeadersFor(source), ...(method === 'GET' ? { Range: 'bytes=0-0' } : {}) },
    });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return { kind: 'retry', code: 0 };
    const code = err.cause?.code || err.code;
    if (code === 'ENOTFOUND') return { kind: 'final', state: 'dead', code: -1 };
    if (code === 'ECONNREFUSED') return { kind: 'final', state: 'dead', code: -2 };
    return { kind: 'retry', code: -3 };
  }
  try { await res.body?.cancel?.(); } catch { /* already closed */ }
  const s = res.status;
  // Some hosts refuse HEAD (405, or 400/401/403/501) but serve GET; check
  // those with a 1-byte ranged GET before calling anything dead (review R20).
  if (method === 'HEAD' && [400, 401, 403, 405, 501].includes(s)) {
    return once(url, { source, timeoutMs, fetchImpl, method: 'GET', hops });
  }
  if (s >= 300 && s < 400) {
    const loc = res.headers.get('location');
    if (!loc) return { kind: 'final', state: 'dead', code: s };
    return once(new URL(loc, url).toString(), { source, timeoutMs, fetchImpl, method: 'HEAD', hops: hops + 1 });
  }
  if (s >= 200 && s < 300) return { kind: 'final', state: 'alive', code: s };
  if (s === 429 || s >= 500) return { kind: 'retry', code: s };
  return { kind: 'final', state: 'dead', code: s };
}

/** Check one URL. Returns { state: 'alive'|'dead'|'unknown', code }. */
export async function checkUrl(url, { source = null, timeoutMs = 10_000, retries = 3, retryDelayMs = 2000, fetchImpl = fetch } = {}) {
  let last = { kind: 'retry', code: -99 };
  for (let attempt = 0; attempt < retries; attempt++) {
    last = await once(url, { source, timeoutMs, fetchImpl });
    if (last.kind === 'final') return { state: last.state, code: last.code };
    if (attempt < retries - 1) await new Promise((r) => setTimeout(r, retryDelayMs * (attempt + 1)));
  }
  return { state: 'unknown', code: last.code };
}

/**
 * Store a check result. The only writer of is_dead / dead_marked_at:
 *   dead    -> is_dead=1, dead_marked_at kept or set now, dead_reason sweep_<code>
 *   alive   -> is_dead=0, dead_marked_at and dead_reason cleared (revive)
 *   unknown -> only dead_checked_at and dead_status_code=-99; verdict unchanged
 */
export async function recordCheck(query, trackId, { state, code }) {
  if (state === 'dead') {
    return query(
      `UPDATE tracks SET is_dead = 1, dead_marked_at = COALESCE(dead_marked_at, NOW()),
              dead_reason = ?, dead_checked_at = NOW(), dead_status_code = ? WHERE id = ?`,
      [`sweep_${code}`, code, trackId]
    );
  }
  if (state === 'alive') {
    return query(
      `UPDATE tracks SET is_dead = 0, dead_marked_at = NULL, dead_reason = NULL,
              dead_checked_at = NOW(), dead_status_code = ? WHERE id = ?`,
      [code, trackId]
    );
  }
  return query(`UPDATE tracks SET dead_checked_at = NOW(), dead_status_code = -99 WHERE id = ?`, [trackId]);
}
