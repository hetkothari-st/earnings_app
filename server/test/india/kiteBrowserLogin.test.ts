import { describe, expect, test } from 'vitest';
import { buildServer } from '../../src/api/server.js';
import { createSession, ensureAuthSchema } from '../../src/auth/store.js';
import { openDb } from '../../src/db/repo.js';
import {
  clearSession, completeBrowserLogin, ensureSession, getSession, kiteStatus, startBrowserLogin,
} from '../../src/india/sources/kiteLogin.js';

const creds = { apiKey: 'key1', apiSecret: 'sec', userId: 'AB1234', password: 'pw', totpSecret: 'JBSWY3DPEHPK3PXP' };
const NOW = Date.parse('2026-10-22T05:00:00Z');
const tokenFetch = (async () => new Response(JSON.stringify({ data: { access_token: 'acc' } }))) as unknown as typeof fetch;
const stateOf = (url: string) => new URLSearchParams(new URL(url).searchParams.get('redirect_params')!).get('state')!;

describe('Kite browser login (backup when the automatic login fails)', () => {
  test('the Zerodha URL carries the api key and a one-time state', () => {
    const url = new URL(startBrowserLogin(creds, NOW));
    expect(url.origin + url.pathname).toBe('https://kite.zerodha.com/connect/login');
    expect(url.searchParams.get('api_key')).toBe('key1');
    expect(stateOf(url.toString())).toMatch(/^[0-9a-f]{32}$/);
  });

  test('a started login completes once; the same state is refused the second time', async () => {
    clearSession();
    const state = stateOf(startBrowserLogin(creds, NOW));
    expect(await completeBrowserLogin(creds, 'reqTok123', state, tokenFetch, NOW + 1000)).toBe(true);
    expect(getSession()?.accessToken).toBe('acc');
    clearSession();
    expect(await completeBrowserLogin(creds, 'reqTok123', state, tokenFetch, NOW + 2000)).toBe(false);
    expect(getSession()).toBeNull();
  });

  test('an unknown or expired state is refused', async () => {
    clearSession();
    expect(await completeBrowserLogin(creds, 'reqTok123', 'nope', tokenFetch, NOW)).toBe(false);
    const state = stateOf(startBrowserLogin(creds, NOW));
    expect(await completeBrowserLogin(creds, 'reqTok123', state, tokenFetch, NOW + 11 * 60_000)).toBe(false);
    expect(getSession()).toBeNull();
  });

  test("the automatic login reports Zerodha's reason (CAPTCHA) and never the password", async () => {
    const captcha = (async () => new Response(JSON.stringify({ status: 'error', message: 'Invalid CAPTCHA values.' }), { status: 400 })) as unknown as typeof fetch;
    await ensureSession(creds, { force: true, fetchImpl: captcha });
    const err = kiteStatus().lastError!;
    expect(err).toContain('HTTP 400');
    expect(err).toContain('Invalid CAPTCHA values. Use');
    expect(err).not.toContain('pw');
  });
});

describe('Kite browser login routes', () => {
  function setup(isAdmin: 0 | 1) {
    const db = openDb(':memory:');
    ensureAuthSchema(db);
    db.prepare('INSERT INTO users (id, password_hash, created_at, is_admin) VALUES (?, ?, ?, ?)').run('1A', 'x', '2026-10-01T00:00:00Z', isAdmin);
    const done: [string, string][] = [];
    const app = buildServer(db, {
      requireAuth: true, now: () => NOW,
      india: { kiteBrowserStart: () => 'https://kite.zerodha.com/connect/login?v=3', kiteBrowserComplete: async (t, s) => { done.push([t, s]); return s === 'good'; } },
    });
    const cookie = `session=${createSession(db, '1A', NOW).token}`;
    return { app, cookie, done };
  }

  test('admins only', async () => {
    const { app, cookie, done } = setup(0);
    expect((await app.inject({ method: 'POST', url: '/api/admin/kite/browser-login', headers: { cookie } })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/admin/kite/callback?status=success&request_token=t&state=good', headers: { cookie } })).statusCode).toBe(403);
    expect(done).toEqual([]);
  });

  test('start gives the URL; callback exchanges and sends the admin back to the admin page', async () => {
    const { app, cookie, done } = setup(1);
    expect((await app.inject({ method: 'POST', url: '/api/admin/kite/browser-login', headers: { cookie } })).json()).toEqual({ url: 'https://kite.zerodha.com/connect/login?v=3' });
    const ok = await app.inject({ url: '/api/admin/kite/callback?status=success&request_token=t&state=good', headers: { cookie } });
    expect([ok.statusCode, ok.headers.location]).toEqual([302, '/admin?kite=ok']);
    const bad = await app.inject({ url: '/api/admin/kite/callback?status=success&request_token=t&state=bad', headers: { cookie } });
    expect(bad.headers.location).toBe('/admin?kite=error');
    const cancelled = await app.inject({ url: '/api/admin/kite/callback?status=cancelled', headers: { cookie } });
    expect(cancelled.headers.location).toBe('/admin?kite=error');
    expect(done).toEqual([['t', 'good'], ['t', 'bad']]);
  });
});
