import { apiFetch, fetchMe, type KiteStatusDto } from './api';

/** Admin user management. Mirrors the rules in server/src/auth (IDs stored uppercase, 1-64 chars). */

export interface AdminUser {
  id: string;
  isAdmin: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

export const MIN_PASSWORD = 8;
export const MAX_PASSWORD = 128;
export const MAX_BULK = 200;
const ID_PATTERN = /^[A-Z0-9_.@-]{1,64}$/;

export type Result<T> = { ok: true; data: T } | { ok: false; error: string };

/** The signed-in user with their role, or null when there is no valid session. */
export async function fetchAccount(): Promise<{ id: string; isAdmin: boolean } | null> {
  const me = await fetchMe();
  return me ? { id: me.id, isAdmin: (me as { isAdmin?: unknown }).isAdmin === true } : null;
}

export const normalizeId = (raw: string) => raw.trim().toUpperCase();
export const validId = (raw: string) => ID_PATTERN.test(normalizeId(raw));

export function passwordProblem(p: string): string | null {
  if (p.length < MIN_PASSWORD) return `Password needs at least ${MIN_PASSWORD} characters`;
  if (p.length > MAX_PASSWORD) return `Password can be at most ${MAX_PASSWORD} characters`;
  return null;
}

/** The IDs a bulk create makes: prefix + n + suffix for count numbers from start. */
export function bulkIds(prefix: string, start: number, count: number, suffix = ''): string[] {
  return Array.from({ length: count }, (_, i) => normalizeId(`${prefix}${start + i}${suffix}`));
}

/** e.g. "11A … 15A (5 users)", or null when the inputs would be rejected. */
export function bulkPreview(prefix: string, start: number, count: number, suffix = ''): string | null {
  if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(count) || count < 1 || count > MAX_BULK) return null;
  const ids = bulkIds(prefix, start, count, suffix);
  if (!ids.every((id) => ID_PATTERN.test(id))) return null;
  const range = count === 1 ? ids[0] : `${ids[0]} … ${ids[count - 1]}`;
  return `${range} (${count} user${count === 1 ? '' : 's'})`;
}

async function send<T>(url: string, method: string, body?: unknown): Promise<Result<T>> {
  let res: Response;
  try {
    res = await apiFetch(url, {
      method,
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
  } catch {
    return { ok: false, error: 'Could not reach the server' };
  }
  if (res.ok) return { ok: true, data: (res.status === 204 ? undefined : await res.json()) as T };
  let error = `Server returned ${res.status}`;
  try {
    const parsed = (await res.json()) as { error?: unknown };
    if (typeof parsed.error === 'string') error = parsed.error;
  } catch { /* not JSON */ }
  return { ok: false, error };
}

const userUrl = (id: string) => `/api/admin/users/${encodeURIComponent(id)}`;

export const listUsers = () => send<AdminUser[]>('/api/admin/users', 'GET');

export const createUser = (u: { id: string; password: string; isAdmin: boolean }) =>
  send<AdminUser>('/api/admin/users', 'POST', u);

export const createUsersBulk = (b: { prefix: string; start: number; count: number; suffix: string; password: string }) =>
  send<AdminUser[]>('/api/admin/users/bulk', 'POST', b);

export const updateUser = (id: string, change: { password?: string; newId?: string; isAdmin?: boolean }) =>
  send<AdminUser>(userUrl(id), 'PATCH', change);

export const deleteUser = (id: string) => send<undefined>(userUrl(id), 'DELETE');

export async function fetchKiteStatus(): Promise<Result<KiteStatusDto>> {
  const res = await apiFetch('/api/admin/kite');
  if (!res.ok) return { ok: false, error: `Server returned ${res.status}` };
  return { ok: true, data: (await res.json()) as KiteStatusDto };
}

export async function kiteLoginNow(): Promise<Result<KiteStatusDto>> {
  const res = await apiFetch('/api/admin/kite/login', { method: 'POST' });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: body.error ?? `Server returned ${res.status}` };
  }
  return { ok: true, data: (await res.json()) as KiteStatusDto };
}
