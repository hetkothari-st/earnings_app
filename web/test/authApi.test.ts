import { afterEach, describe, expect, test, vi } from 'vitest';
import { apiFetch, fetchMe, login, logout, UNAUTHORIZED_EVENT } from '../src/api';

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => { vi.unstubAllGlobals(); });

describe('apiFetch', () => {
  test('announces a 401 so the app can return to the login page', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(401, { error: 'Not signed in' })));
    const seen = vi.fn();
    window.addEventListener(UNAUTHORIZED_EVENT, seen);
    const res = await apiFetch('/api/earnings');
    window.removeEventListener(UNAUTHORIZED_EVENT, seen);
    expect(res.status).toBe(401);
    expect(seen).toHaveBeenCalledTimes(1);
  });

  test('other statuses pass through quietly', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, {})));
    const seen = vi.fn();
    window.addEventListener(UNAUTHORIZED_EVENT, seen);
    await apiFetch('/api/status');
    window.removeEventListener(UNAUTHORIZED_EVENT, seen);
    expect(seen).not.toHaveBeenCalled();
  });
});

describe('session calls', () => {
  test('fetchMe returns the user or null', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { id: '1A' })));
    expect(await fetchMe()).toEqual({ id: '1A' });
    vi.stubGlobal('fetch', vi.fn(async () => json(401, { error: 'Not signed in' })));
    expect(await fetchMe()).toBeNull();
  });

  test('login posts JSON and returns null on success, the server message on failure', async () => {
    const f = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', f);
    expect(await login('1a', '00000000')).toBeNull();
    expect(f).toHaveBeenCalledWith('/api/login', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ id: '1a', password: '00000000' }),
    }));
    vi.stubGlobal('fetch', vi.fn(async () => json(429, { error: 'Too many attempts, try again in 9 minutes' })));
    expect(await login('1A', 'x')).toBe('Too many attempts, try again in 9 minutes');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
    expect(await login('1A', 'x')).toBe('Could not reach the server. Try again.');
  });

  test('logout posts to /api/logout', async () => {
    const f = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', f);
    await logout();
    expect(f).toHaveBeenCalledWith('/api/logout', expect.objectContaining({ method: 'POST' }));
  });
});
