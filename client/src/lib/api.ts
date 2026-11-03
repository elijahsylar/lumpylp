import { getStoredToken } from './auth';

/** Error thrown by api() for non-2xx responses. */
export type ApiError = Error & { status: number; data: unknown };

interface ApiOpts extends RequestInit {
  json?: unknown;
}

export async function api<T = unknown>(path: string, opts: ApiOpts = {}): Promise<T> {
  const { json, headers, ...rest } = opts;
  const token = getStoredToken();
  const finalHeaders: Record<string, string> = {
    ...(headers as Record<string, string> | undefined),
  };
  if (json !== undefined) finalHeaders['Content-Type'] = 'application/json';
  if (token) finalHeaders['Authorization'] = `Bearer ${token}`;

  const res = await fetch(path, {
    ...rest,
    credentials: 'include',
    headers: finalHeaders,
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(
      (data && typeof data.error === 'string') ? data.error : `request failed (${res.status})`
    ) as ApiError;
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data as T;
}
