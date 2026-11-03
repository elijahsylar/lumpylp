// Where to send the user after login (?redirect=...). Only same-origin paths
// are allowed: an absolute URL, a protocol-relative "//host", or a backslash
// (which browsers and react-router 6 normalise to "/", GHSA-wrjc-x8rr-h8h6)
// could send the user to another site. Anything doubtful goes home.
export function safeRedirect(target: string | null | undefined): string {
  if (!target || !target.startsWith('/') || target.startsWith('//')) return '/';
  let decoded = target;
  try { decoded = decodeURIComponent(target); } catch { return '/'; }
  if (/\\/.test(target) || /\\/.test(decoded)) return '/';
  for (let i = 0; i < decoded.length; i++) {
    const c = decoded.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return '/'; // control characters
  }
  if (decoded.startsWith('//')) return '/';
  return target;
}
