import { beforeAll, beforeEach, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/api/server.js';
import { ensureAuthSchema, listUsers, setAdmin, setUser } from '../../src/auth/store.js';
import { type Db, listRange, openDb, upsertCalendarRow } from '../../src/db/repo.js';

let template: Db;
let db: Db;
let app: FastifyInstance;
let clock: number;

// Hashing is deliberately slow, so create the accounts once and copy the rows into each fresh DB.
beforeAll(async () => {
  template = openDb(':memory:');
  ensureAuthSchema(template);
  await setUser(template, '1A', '00000000', '2026-10-15T00:00:00Z');
  await setUser(template, '2A', '00000000', '2026-10-15T00:00:00Z');
});

beforeEach(() => {
  db = openDb(':memory:');
  ensureAuthSchema(db);
  const insert = db.prepare('INSERT INTO users (id, password_hash, created_at) VALUES (?, ?, ?)');
  for (const u of template.prepare('SELECT * FROM users').all() as { id: string; password_hash: string; created_at: string }[]) {
    insert.run(u.id, u.password_hash, u.created_at);
  }
  clock = Date.parse('2026-10-15T12:00:00Z');
  app = buildServer(db, { requireAuth: true, now: () => clock });
});

const login = (id: string, password: string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url: '/api/login', payload: { id, password }, headers });

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie'];
  return String(Array.isArray(raw) ? raw[0] : raw);
}
const sessionHeader = (res: { headers: Record<string, unknown> }) => ({ cookie: cookieOf(res).split(';')[0]! });

describe('login', () => {
  test('correct credentials: 204 and a hardened session cookie', async () => {
    const res = await login('1A', '00000000');
    expect(res.statusCode).toBe(204);
    const c = cookieOf(res);
    expect(c).toMatch(/^session=[A-Za-z0-9_-]{43};/);
    expect(c).toContain('HttpOnly');
    expect(c).toContain('SameSite=Lax');
    expect(c).toContain('Path=/');
    expect(c).toContain('Max-Age=2592000');
    expect(c).not.toContain('Secure');
  });

  test('cookie is Secure when the request came over HTTPS', async () => {
    const res = await login('1A', '00000000', { 'x-forwarded-proto': 'https' });
    expect(cookieOf(res)).toContain('Secure');
  });

  test('user ID is case-insensitive', async () => {
    const res = await login('1a', '00000000');
    expect(res.statusCode).toBe(204);
    const me = await app.inject({ url: '/api/me', headers: sessionHeader(res) });
    expect(me.json()).toEqual({ id: '1A', isAdmin: false });
  });

  test('wrong password, unknown user and malformed bodies all give the same generic 401', async () => {
    for (const res of [
      await login('1A', 'wrong'),
      await login('99Z', '00000000'),
      await app.inject({ method: 'POST', url: '/api/login', payload: { id: 1 } }),
      await app.inject({ method: 'POST', url: '/api/login', payload: {} }),
    ]) {
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'Wrong user ID or password' });
      expect(res.headers['set-cookie']).toBeUndefined();
    }
  });

  test('5 failures for one ID within 15 minutes lock that ID with 429, even with the right password', async () => {
    for (let i = 0; i < 5; i++) {
      expect((await login('1A', 'bad', { 'x-forwarded-for': `9.9.9.${i}` })).statusCode).toBe(401);
    }
    const res = await login('1a', '00000000');
    expect(res.statusCode).toBe(429);
    expect(res.json()).toEqual({ error: 'Too many attempts, try again in 15 minutes' });
    expect((await login('2A', '00000000')).statusCode).toBe(204);
    clock += 15 * 60_000;
    expect((await login('1A', '00000000')).statusCode).toBe(204);
  });

  test('5 failures from one IP lock that IP for every ID', async () => {
    for (let i = 0; i < 5; i++) await login(`${i}Q`, 'bad');
    clock += 6 * 60_000;
    const res = await login('2A', '00000000');
    expect(res.statusCode).toBe(429);
    expect(res.json()).toEqual({ error: 'Too many attempts, try again in 9 minutes' });
  });
});

describe('roles and last sign-in', () => {
  test('/api/me reports whether the user is an admin', async () => {
    setAdmin(db, '2A', true);
    const a = sessionHeader(await login('1A', '00000000'));
    const b = sessionHeader(await login('2A', '00000000'));
    expect((await app.inject({ url: '/api/me', headers: a })).json()).toEqual({ id: '1A', isAdmin: false });
    expect((await app.inject({ url: '/api/me', headers: b })).json()).toEqual({ id: '2A', isAdmin: true });
  });

  test('a successful sign-in records the time; a failed one does not', async () => {
    await login('1A', 'wrong');
    expect(listUsers(db).find((u) => u.id === '1A')!.lastLoginAt).toBeNull();
    await login('1A', '00000000');
    expect(listUsers(db).find((u) => u.id === '1A')!.lastLoginAt).toBe('2026-10-15T12:00:00.000Z');
  });
});

describe('session', () => {
  test('/api/me is 401 without a session', async () => {
    const res = await app.inject({ url: '/api/me' });
    expect(res.statusCode).toBe(401);
  });

  test('tampered or expired cookies are rejected', async () => {
    const res = await login('1A', '00000000');
    expect((await app.inject({ url: '/api/me', headers: { cookie: 'session=forged' } })).statusCode).toBe(401);
    clock += 30 * 24 * 3600 * 1000 + 1;
    expect((await app.inject({ url: '/api/me', headers: sessionHeader(res) })).statusCode).toBe(401);
  });

  test('cookie is found among other cookies', async () => {
    const res = await login('1A', '00000000');
    const cookie = `theme=dark; ${sessionHeader(res).cookie}; other=x%20y`;
    expect((await app.inject({ url: '/api/me', headers: { cookie } })).json()).toEqual({ id: '1A', isAdmin: false });
  });

  test('logout revokes the session and clears the cookie', async () => {
    const res = await login('1A', '00000000');
    const out = await app.inject({ method: 'POST', url: '/api/logout', headers: sessionHeader(res) });
    expect(out.statusCode).toBe(204);
    expect(cookieOf(out)).toMatch(/^session=; .*Max-Age=0/);
    expect((await app.inject({ url: '/api/me', headers: sessionHeader(res) })).statusCode).toBe(401);
  });
});

describe('protected routes', () => {
  test('data routes need a session when requireAuth is on', async () => {
    for (const url of ['/api/status', '/api/markets', '/api/earnings?from=2026-10-15&to=2026-10-15', '/api/earnings/1', '/api/expanded', '/API/status']) {
      const res = await app.inject({ url });
      expect(res.statusCode, url).toBe(401);
    }
    const res = await login('1A', '00000000');
    expect((await app.inject({ url: '/api/status', headers: sessionHeader(res) })).statusCode).toBe(200);
  });

  test('without requireAuth, data routes stay open but the expanded list still needs a user', async () => {
    const open = buildServer(db);
    expect((await open.inject({ url: '/api/status' })).statusCode).toBe(200);
    expect((await open.inject({ url: '/api/expanded' })).statusCode).toBe(401);
  });
});

describe('expanded list', () => {
  test('per-user GET and PUT', async () => {
    const a = sessionHeader(await login('1A', '00000000'));
    const b = sessionHeader(await login('2A', '00000000'));
    expect((await app.inject({ url: '/api/expanded', headers: a })).json()).toEqual({ symbols: [] });
    const put = await app.inject({ method: 'PUT', url: '/api/expanded', headers: a, payload: { symbols: ['TSM', 'BRK.B', 'TSM'] } });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ symbols: ['TSM', 'BRK.B'] });
    expect((await app.inject({ url: '/api/expanded', headers: a })).json()).toEqual({ symbols: ['TSM', 'BRK.B'] });
    expect((await app.inject({ url: '/api/expanded', headers: b })).json()).toEqual({ symbols: [] });
  });

  test('PUT validates the payload', async () => {
    const a = sessionHeader(await login('1A', '00000000'));
    for (const payload of [
      {}, { symbols: 'TSM' }, { symbols: [1] }, { symbols: ['A'.repeat(25)] }, { symbols: [''] },
      { symbols: Array.from({ length: 2001 }, (_, i) => `S${i}`) },
    ]) {
      const res = await app.inject({ method: 'PUT', url: '/api/expanded', headers: a, payload });
      expect(res.statusCode).toBe(400);
    }
    const ok = await app.inject({ method: 'PUT', url: '/api/expanded', headers: a, payload: { symbols: Array.from({ length: 2000 }, (_, i) => `S${i}`) } });
    expect(ok.statusCode).toBe(200);
  });
});

describe('notes routes', () => {
  const addReport = () => {
    upsertCalendarRow(db, { symbol: 'SCHW', name: 'Charles Schwab', reportDate: '2026-10-15', fiscalQuarter: 'Sep/2026', timing: 'BMO',
      marketCap: 1, epsEstimate: null, noOfEsts: null, epsActual: null, epsSurprisePct: null, lastYearEps: null, lastYearReportDate: null },
      '2026-10-15T00:00:00Z', '2026-10-15');
    return listRange(db, { from: '2026-10-15', to: '2026-10-15', minCap: null, q: null })[0]!.id;
  };
  test('save, list and clear a note for the signed-in user only', async () => {
    const id = addReport();
    const one = sessionHeader(await login('1A', '00000000'));
    const two = sessionHeader(await login('2A', '00000000'));
    const put = await app.inject({ method: 'PUT', url: `/api/notes/${id}`, payload: { text: 'watch NIM' }, headers: one });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ reportId: id, text: 'watch NIM', deleteAt: '2026-10-16T13:30:00.000Z' });
    expect((await app.inject({ method: 'GET', url: '/api/notes', headers: one })).json().notes).toHaveLength(1);
    expect((await app.inject({ method: 'GET', url: '/api/notes', headers: two })).json().notes).toEqual([]);
    const cleared = await app.inject({ method: 'PUT', url: `/api/notes/${id}`, payload: { text: '' }, headers: one });
    expect(cleared.statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/api/notes', headers: one })).json().notes).toEqual([]);
  });
  test('unknown report 404, too long 400, no session 401', async () => {
    const id = addReport();
    const one = sessionHeader(await login('1A', '00000000'));
    expect((await app.inject({ method: 'PUT', url: '/api/notes/99999', payload: { text: 'x' }, headers: one })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PUT', url: `/api/notes/${id}`, payload: { text: 'x'.repeat(5001) }, headers: one })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/notes' })).statusCode).toBe(401);
  });
});
