import type { EarningsResponse, StatusResponse } from '../../server/src/api/types';

/** Fired on window whenever an API call answers 401, so the app can show the login page. */
export const UNAUTHORIZED_EVENT = 'auth:unauthorized';

export async function apiFetch(url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, init);
  if (res.status === 401) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  return res;
}

export async function fetchEarnings(
  p: { from: string; to: string; minCap: number | null; q: string },
  signal: AbortSignal,
): Promise<EarningsResponse> {
  const qs = new URLSearchParams({ from: p.from, to: p.to });
  if (p.minCap != null) qs.set('minCap', String(p.minCap));
  if (p.q.trim()) qs.set('q', p.q.trim());
  const res = await apiFetch(`/api/earnings?${qs}`, { signal });
  if (!res.ok) throw new Error(`Server returned ${res.status}`);
  return res.json() as Promise<EarningsResponse>;
}

export async function fetchStatus(): Promise<StatusResponse> {
  const res = await apiFetch('/api/status');
  if (!res.ok) throw new Error(`Server returned ${res.status}`);
  return res.json() as Promise<StatusResponse>;
}

/** The signed-in user, or null when there is no valid session. */
export async function fetchMe(): Promise<{ id: string } | null> {
  const res = await fetch('/api/me');
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`Server returned ${res.status}`);
  return res.json() as Promise<{ id: string }>;
}

/** Returns null on success, otherwise a message to show the user. */
export async function login(id: string, password: string): Promise<string | null> {
  let res: Response;
  try {
    res = await fetch('/api/login', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, password }),
    });
  } catch {
    return 'Could not reach the server. Try again.';
  }
  if (res.ok) return null;
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === 'string') return body.error;
  } catch {
    // Fall through to a generic message.
  }
  return `Sign in failed (server returned ${res.status})`;
}

export async function logout(): Promise<void> {
  await fetch('/api/logout', { method: 'POST' });
}

export async function fetchHidden(signal?: AbortSignal): Promise<string[]> {
  const res = await apiFetch('/api/hidden', { signal });
  if (!res.ok) throw new Error(`Server returned ${res.status}`);
  return ((await res.json()) as { symbols: string[] }).symbols;
}

export async function saveHidden(symbols: string[]): Promise<void> {
  const res = await apiFetch('/api/hidden', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ symbols }),
  });
  if (!res.ok) throw new Error(`Server returned ${res.status}`);
}
