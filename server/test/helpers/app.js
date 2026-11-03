// Start the real Express app (server/app.js) on an ephemeral port against
// the local test database, and a tiny fetch wrapper for requests.
import './env.js';

export async function startApp() {
  const { createApp } = await import('../../app.js');
  const app = await createApp();
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    async close() {
      await new Promise((r) => server.close(r));
      const { pool } = await import('../../db.js');
      await pool.end();
    },
  };
}

export async function req(base, path, { method = 'GET', token, json, headers = {}, redirect = 'manual' } = {}) {
  const h = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  if (json !== undefined) h['content-type'] = 'application/json';
  const res = await fetch(base + path, {
    method, headers: h, redirect,
    body: json !== undefined ? JSON.stringify(json) : undefined,
  });
  const text = await res.text();
  let body = text;
  try { body = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { status: res.status, headers: res.headers, body };
}
