import { beforeAll, beforeEach, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/api/server.js';
import { verifyPassword } from '../../src/auth/password.js';
import {
  createSession, ensureAuthSchema, getExpanded, getPasswordHash, isAdmin, listUsers, setExpanded, setUser,
} from '../../src/auth/store.js';
import { type Db, openDb } from '../../src/db/repo.js';
import { ensureNotesSchema } from '../../src/notes/store.js';

const PW = '00000000';
let template: Db;
let db: Db;
let app: FastifyInstance;
let clock: number;

// Hashing is deliberately slow, so create the accounts once and copy the rows into each fresh DB.
beforeAll(async () => {
  template = openDb(':memory:');
  ensureAuthSchema(template);
  for (const id of ['BOSS', '1A', '2A']) await setUser(template, id, PW, '2026-10-01T00:00:00Z');
  template.prepare("UPDATE users SET is_admin = 1 WHERE id = 'BOSS'").run();
});

beforeEach(() => {
  db = openDb(':memory:');
  ensureAuthSchema(db);
  const insert = db.prepare('INSERT INTO users (id, password_hash, created_at, is_admin) VALUES (?, ?, ?, ?)');
  for (const u of template.prepare('SELECT * FROM users').all() as { id: string; password_hash: string; created_at: string; is_admin: number }[]) {
    insert.run(u.id, u.password_hash, u.created_at, u.is_admin);
  }
  clock = Date.parse('2026-10-15T12:00:00Z');
  app = buildServer(db, { requireAuth: true, now: () => clock });
});

/** A session cookie header for the user, without going through the (rate-limited, slow) login route. */
const as = (id: string) => ({ cookie: `session=${createSession(db, id, clock).token}` });
const boss = () => as('BOSS');

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
const call = (method: Method, url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as object }) });

const sessionCount = (id: string) => (db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(id) as { n: number }).n;
const ids = () => listUsers(db).map((u) => u.id).sort();

const ENDPOINTS: [Method, string, unknown?][] = [
  ['GET', '/api/admin/users'],
  ['POST', '/api/admin/users', { id: 'NEW', password: PW }],
  ['POST', '/api/admin/users/bulk', { prefix: 'X', start: 1, count: 2, password: PW }],
  ['PATCH', '/api/admin/users/1A', { isAdmin: true }],
  ['DELETE', '/api/admin/users/1A'],
];

describe('access', () => {
  test('every admin endpoint is 401 without a session', async () => {
    for (const [method, url, payload] of ENDPOINTS) {
      const res = await call(method, url, {}, payload);
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  test('every admin endpoint is 401 without a session even when the rest of the API is open', async () => {
    app = buildServer(db, { now: () => clock });
    for (const [method, url, payload] of ENDPOINTS) {
      expect((await call(method, url, {}, payload)).statusCode, `${method} ${url}`).toBe(401);
    }
  });

  test('every admin endpoint is 403 for a signed-in non-admin, and changes nothing', async () => {
    const before = ids();
    for (const [method, url, payload] of ENDPOINTS) {
      const res = await call(method, url, as('2A'), payload);
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.json()).toEqual({ error: 'Admins only' });
    }
    expect(ids()).toEqual(before);
    expect(isAdmin(db, '1A')).toBe(false);
  });

  test('admin rights are checked on every request: revoked admins lose access at once', async () => {
    const h = boss();
    expect((await call('GET', '/api/admin/users', h)).statusCode).toBe(200);
    db.prepare("UPDATE users SET is_admin = 0 WHERE id = 'BOSS'").run();
    expect((await call('GET', '/api/admin/users', h)).statusCode).toBe(403);
  });
});

describe('GET /api/admin/users', () => {
  test('lists every user with role, created and last sign-in, never the password hash', async () => {
    db.prepare("UPDATE users SET last_login_at = '2026-10-14T09:00:00.000Z' WHERE id = '1A'").run();
    const res = await call('GET', '/api/admin/users', boss());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      { id: '1A', isAdmin: false, createdAt: '2026-10-01T00:00:00Z', lastLoginAt: '2026-10-14T09:00:00.000Z' },
      { id: '2A', isAdmin: false, createdAt: '2026-10-01T00:00:00Z', lastLoginAt: null },
      { id: 'BOSS', isAdmin: true, createdAt: '2026-10-01T00:00:00Z', lastLoginAt: null },
    ]);
    expect(res.body).not.toContain('scrypt');
  });
});

describe('POST /api/admin/users', () => {
  test('creates a user who can then sign in, ID case-insensitive', async () => {
    const res = await call('POST', '/api/admin/users', boss(), { id: ' Jane.Doe@Example.com ', password: 'correct horse' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ id: 'JANE.DOE@EXAMPLE.COM', isAdmin: false, createdAt: '2026-10-15T12:00:00.000Z', lastLoginAt: null });
    const login = await app.inject({ method: 'POST', url: '/api/login', payload: { id: 'jane.doe@example.com', password: 'correct horse' } });
    expect(login.statusCode).toBe(204);
  });

  test('can create an admin', async () => {
    const res = await call('POST', '/api/admin/users', boss(), { id: 'deputy', password: PW, isAdmin: true });
    expect(res.statusCode).toBe(201);
    expect(isAdmin(db, 'DEPUTY')).toBe(true);
  });

  test('409 when the ID already exists, in any case; the existing password is kept', async () => {
    const res = await call('POST', '/api/admin/users', boss(), { id: '1a', password: 'something-else' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'User 1A already exists' });
    expect(await verifyPassword(PW, getPasswordHash(db, '1A')!)).toBe(true);
  });

  test('400 with a plain message for bad input', async () => {
    const cases: [unknown, RegExp][] = [
      [{ password: PW }, /User ID/],
      [{ id: '', password: PW }, /User ID/],
      [{ id: 'a b', password: PW }, /User ID/],
      [{ id: 'a+b@x.com', password: PW }, /User ID/],
      [{ id: 'x'.repeat(65), password: PW }, /User ID/],
      [{ id: 7, password: PW }, /User ID/],
      [{ id: 'OK' }, /Password/],
      [{ id: 'OK', password: 'short12' }, /Password must be 8-128 characters/],
      [{ id: 'OK', password: 'x'.repeat(129) }, /Password must be 8-128 characters/],
      [{ id: 'OK', password: 12345678 }, /Password/],
      [{ id: 'OK', password: PW, isAdmin: 'yes' }, /isAdmin/],
    ];
    for (const [payload, message] of cases) {
      const res = await call('POST', '/api/admin/users', boss(), payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json().error).toMatch(message);
    }
    expect(ids()).toEqual(['1A', '2A', 'BOSS']);
  });

  test('accepts 64-character IDs and 8 and 128 character passwords', async () => {
    expect((await call('POST', '/api/admin/users', boss(), { id: 'Y'.repeat(64), password: '12345678' })).statusCode).toBe(201);
    expect((await call('POST', '/api/admin/users', boss(), { id: 'Z', password: 'p'.repeat(128) })).statusCode).toBe(201);
  });
});

describe('POST /api/admin/users/bulk', () => {
  test('creates prefix + n + suffix for count numbers from start, all able to sign in', async () => {
    const res = await call('POST', '/api/admin/users/bulk', boss(), { prefix: '', start: 11, count: 5, suffix: 'a', password: 'shared-pass' });
    expect(res.statusCode).toBe(201);
    expect(res.json().map((u: { id: string }) => u.id)).toEqual(['11A', '12A', '13A', '14A', '15A']);
    expect(ids()).toEqual(['11A', '12A', '13A', '14A', '15A', '1A', '2A', 'BOSS']);
    const login = await app.inject({ method: 'POST', url: '/api/login', payload: { id: '15a', password: 'shared-pass' } });
    expect(login.statusCode).toBe(204);
    expect(isAdmin(db, '11A')).toBe(false);
  });

  test('suffix is optional; prefix goes in front', async () => {
    const res = await call('POST', '/api/admin/users/bulk', boss(), { prefix: 'desk-', start: 1, count: 2, password: PW });
    expect(res.json().map((u: { id: string }) => u.id)).toEqual(['DESK-1', 'DESK-2']);
  });

  test('409 listing every ID that already exists, and nothing is created', async () => {
    const res = await call('POST', '/api/admin/users/bulk', boss(), { prefix: '', start: 0, count: 4, suffix: 'A', password: PW });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'These user IDs already exist: 1A, 2A', existing: ['1A', '2A'] });
    expect(ids()).toEqual(['1A', '2A', 'BOSS']);
  });

  test('400 for bad input; nothing is created', async () => {
    const ok = { prefix: 'u', start: 1, count: 3, suffix: '', password: PW };
    const cases: [unknown, RegExp][] = [
      [{ ...ok, count: 0 }, /count must be a whole number from 1 to 200/],
      [{ ...ok, count: 201 }, /count must be a whole number from 1 to 200/],
      [{ ...ok, count: 2.5 }, /count/],
      [{ ...ok, count: '3' }, /count/],
      [{ ...ok, start: -1 }, /start must be a whole number/],
      [{ ...ok, start: 1.5 }, /start/],
      [{ ...ok, start: undefined }, /start/],
      [{ ...ok, prefix: 5 }, /prefix/],
      [{ ...ok, suffix: 5 }, /suffix/],
      [{ ...ok, prefix: 'a b' }, /User ID/],
      [{ ...ok, prefix: 'x'.repeat(64) }, /User ID/],
      [{ ...ok, password: 'short' }, /Password must be 8-128 characters/],
    ];
    for (const [payload, message] of cases) {
      const res = await call('POST', '/api/admin/users/bulk', boss(), payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json().error).toMatch(message);
    }
    expect(ids()).toEqual(['1A', '2A', 'BOSS']);
  });
});

describe('PATCH /api/admin/users/:id', () => {
  test('changing the password lets the new one in, the old one out, and signs the user out everywhere', async () => {
    const old = as('1A');
    const res = await call('PATCH', '/api/admin/users/1a', boss(), { password: 'brand-new-pass' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: '1A', isAdmin: false });
    expect(sessionCount('1A')).toBe(0);
    expect((await app.inject({ url: '/api/me', headers: old })).statusCode).toBe(401);
    expect(await verifyPassword('brand-new-pass', getPasswordHash(db, '1A')!)).toBe(true);
    expect(await verifyPassword(PW, getPasswordHash(db, '1A')!)).toBe(false);
  });

  test('grants and revokes admin', async () => {
    expect((await call('PATCH', '/api/admin/users/1A', boss(), { isAdmin: true })).json()).toMatchObject({ id: '1A', isAdmin: true });
    expect(isAdmin(db, '1A')).toBe(true);
    expect((await call('PATCH', '/api/admin/users/1A', boss(), { isAdmin: false })).json()).toMatchObject({ isAdmin: false });
    expect(isAdmin(db, '1A')).toBe(false);
  });

  test('rename moves the expanded list and notes, keeps password and role, and signs the user out', async () => {
    setExpanded(db, '1A', ['TSM', 'NVDA'], '2026-10-15T00:00:00Z');
    ensureNotesSchema(db);
    db.prepare("INSERT INTO notes (user_id, report_id, text, updated_at) VALUES ('1A', 1, 'watch NIM', 'x'), ('2A', 1, 'other', 'x')").run();
    db.prepare("UPDATE users SET is_admin = 1, last_login_at = '2026-10-14T00:00:00.000Z' WHERE id = '1A'").run();
    as('1A');

    const res = await call('PATCH', '/api/admin/users/1A', boss(), { newId: 'trader1@example.com' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: 'TRADER1@EXAMPLE.COM', isAdmin: true, createdAt: '2026-10-01T00:00:00Z', lastLoginAt: '2026-10-14T00:00:00.000Z' });
    expect(ids()).toEqual(['2A', 'BOSS', 'TRADER1@EXAMPLE.COM']);
    expect(getExpanded(db, 'TRADER1@EXAMPLE.COM')).toEqual(['TSM', 'NVDA']);
    expect(getExpanded(db, '1A')).toEqual([]);
    expect(db.prepare('SELECT user_id, text FROM notes ORDER BY user_id').all())
      .toEqual([{ user_id: '2A', text: 'other' }, { user_id: 'TRADER1@EXAMPLE.COM', text: 'watch NIM' }]);
    expect(sessionCount('1A') + sessionCount('TRADER1@EXAMPLE.COM')).toBe(0);
    const login = await app.inject({ method: 'POST', url: '/api/login', payload: { id: 'trader1@example.com', password: PW } });
    expect(login.statusCode).toBe(204);
  });

  test('rename works when the notes table does not exist yet', async () => {
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'notes'").get()).toBeUndefined();
    expect((await call('PATCH', '/api/admin/users/1A', boss(), { newId: '1B' })).statusCode).toBe(200);
    expect(ids()).toEqual(['1B', '2A', 'BOSS']);
  });

  test('rename to the same ID in another case is a no-op, not a conflict', async () => {
    const res = await call('PATCH', '/api/admin/users/1A', boss(), { newId: '1a' });
    expect(res.statusCode).toBe(200);
    expect(ids()).toEqual(['1A', '2A', 'BOSS']);
  });

  test('rename to an existing ID is 409 and changes nothing (not even the other fields)', async () => {
    const res = await call('PATCH', '/api/admin/users/1A', boss(), { newId: '2a', isAdmin: true });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'User 2A already exists' });
    expect(isAdmin(db, '1A')).toBe(false);
    expect(ids()).toEqual(['1A', '2A', 'BOSS']);
  });

  test('404 for an unknown user', async () => {
    const res = await call('PATCH', '/api/admin/users/NOPE', boss(), { isAdmin: true });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'No user NOPE' });
  });

  test('400 for bad input', async () => {
    for (const payload of [
      {}, { password: 'short' }, { password: 5 }, { newId: 'a b' }, { newId: '' }, { isAdmin: 1 }, { isAdmin: 'true' },
    ]) {
      const res = await call('PATCH', '/api/admin/users/1A', boss(), payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(typeof res.json().error).toBe('string');
    }
    expect((await call('PATCH', '/api/admin/users/a%20b', boss(), { isAdmin: true })).statusCode).toBe(400);
  });

  test('an admin cannot remove their own admin role', async () => {
    db.prepare("UPDATE users SET is_admin = 1 WHERE id = '1A'").run();
    const res = await call('PATCH', '/api/admin/users/BOSS', boss(), { isAdmin: false });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'You cannot remove your own admin role' });
    expect(isAdmin(db, 'BOSS')).toBe(true);
  });

  test('another admin can be demoted while one admin remains; the last admin never can', async () => {
    db.prepare("UPDATE users SET is_admin = 1 WHERE id = '1A'").run();
    const one = as('1A');
    expect((await call('PATCH', '/api/admin/users/BOSS', one, { isAdmin: false })).statusCode).toBe(200);
    // 1A is now the last admin.
    const res = await call('PATCH', '/api/admin/users/1A', one, { isAdmin: false });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: '1A is the last admin; make someone else an admin first' });
    expect(isAdmin(db, '1A')).toBe(true);
  });
});

describe('DELETE /api/admin/users/:id', () => {
  test('removes the user with their sessions, expanded list and notes; they can no longer sign in', async () => {
    setExpanded(db, '1A', ['TSM'], '2026-10-15T00:00:00Z');
    ensureNotesSchema(db);
    db.prepare("INSERT INTO notes (user_id, report_id, text, updated_at) VALUES ('1A', 1, 'mine', 'x'), ('2A', 1, 'theirs', 'x')").run();
    const session = as('1A');

    const res = await call('DELETE', '/api/admin/users/1a', boss());
    expect(res.statusCode).toBe(204);
    expect(ids()).toEqual(['2A', 'BOSS']);
    expect(sessionCount('1A')).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM user_expanded WHERE user_id = '1A'").get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT user_id FROM notes').all()).toEqual([{ user_id: '2A' }]);
    expect((await app.inject({ url: '/api/me', headers: session })).statusCode).toBe(401);
    const login = await app.inject({ method: 'POST', url: '/api/login', payload: { id: '1A', password: PW } });
    expect(login.statusCode).toBe(401);
  });

  test('works when the notes table does not exist yet', async () => {
    expect((await call('DELETE', '/api/admin/users/1A', boss())).statusCode).toBe(204);
    expect(ids()).toEqual(['2A', 'BOSS']);
  });

  test('404 for an unknown user, 400 for an invalid ID', async () => {
    expect((await call('DELETE', '/api/admin/users/NOPE', boss())).statusCode).toBe(404);
    expect((await call('DELETE', '/api/admin/users/a%20b', boss())).statusCode).toBe(400);
  });

  test('an admin cannot delete themselves', async () => {
    db.prepare("UPDATE users SET is_admin = 1 WHERE id = '1A'").run();
    const res = await call('DELETE', '/api/admin/users/boss', boss());
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'You cannot delete your own account' });
    expect(ids()).toContain('BOSS');
  });

  test('the last admin can never be deleted', async () => {
    const res = await call('DELETE', '/api/admin/users/BOSS', boss());
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'BOSS is the last admin; make someone else an admin first' });
    expect(ids()).toContain('BOSS');
  });

  test('another admin can be deleted while one admin remains', async () => {
    db.prepare("UPDATE users SET is_admin = 1 WHERE id = '1A'").run();
    expect((await call('DELETE', '/api/admin/users/1A', boss())).statusCode).toBe(204);
  });
});
