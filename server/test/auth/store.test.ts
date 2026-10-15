import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  createSession, deleteSession, ensureAuthSchema, findSessionUser, getExpanded, getPasswordHash, isAdmin, listUsers,
  normalizeUserId, recordLogin, SESSION_TTL_MS, setAdmin, setExpanded, setUser,
} from '../../src/auth/store.js';
import { type Db, openDb } from '../../src/db/repo.js';

let db: Db;
beforeEach(() => { db = openDb(':memory:'); ensureAuthSchema(db); });

describe('users', () => {
  test('ids are trimmed and uppercased; invalid ids rejected', () => {
    expect(normalizeUserId(' 1a ')).toBe('1A');
    expect(normalizeUserId('')).toBeNull();
    expect(normalizeUserId('a b')).toBeNull();
    expect(normalizeUserId('x'.repeat(65))).toBeNull();
  });

  test('ids may be up to 64 characters and may be email addresses', () => {
    expect(normalizeUserId('x'.repeat(64))).toBe('X'.repeat(64));
    expect(normalizeUserId(' Jane.Doe-1_x@Example.com ')).toBe('JANE.DOE-1_X@EXAMPLE.COM');
    for (const bad of ['a+b@x.com', 'a/b', 'a"b', 'ä', 'a\nb']) expect(normalizeUserId(bad), bad).toBeNull();
  });

  test('setUser creates then updates, storing only a scrypt hash', async () => {
    expect(await setUser(db, '1a', '00000000', '2026-10-15T00:00:00Z')).toBe('created');
    const h1 = getPasswordHash(db, '1A');
    expect(h1).toMatch(/^scrypt\$/);
    expect(await setUser(db, '1A', 'other-pass', '2026-10-16T00:00:00Z')).toBe('updated');
    expect(getPasswordHash(db, '1A')).not.toBe(h1);
    const raw = JSON.stringify(db.prepare('SELECT * FROM users').all());
    expect(raw).not.toContain('00000000');
    expect(raw).not.toContain('other-pass');
    expect(listUsers(db)).toEqual([{ id: '1A', isAdmin: false, createdAt: '2026-10-15T00:00:00Z', lastLoginAt: null }]);
  });

  test('ensureAuthSchema is idempotent', () => {
    expect(() => ensureAuthSchema(db)).not.toThrow();
  });

  test('ensureAuthSchema adds is_admin and last_login_at to an existing users table', () => {
    const old = openDb(':memory:');
    old.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, password_hash TEXT NOT NULL, created_at TEXT NOT NULL);
      INSERT INTO users VALUES ('1A', 'h', '2026-10-01T00:00:00Z');`);
    ensureAuthSchema(old);
    ensureAuthSchema(old);
    expect(old.prepare('SELECT is_admin, last_login_at FROM users').get()).toEqual({ is_admin: 0, last_login_at: null });
    expect(isAdmin(old, '1A')).toBe(false);
  });

  test('admin flag: off by default, set and cleared; unknown users are not admins', async () => {
    await setUser(db, '1A', 'pw', '2026-10-15T00:00:00Z');
    expect(isAdmin(db, '1A')).toBe(false);
    expect(setAdmin(db, '1a', true)).toBe(true);
    expect(isAdmin(db, '1A')).toBe(true);
    expect(listUsers(db)[0]!.isAdmin).toBe(true);
    // Changing the password keeps the role.
    await setUser(db, '1A', 'pw2', '2026-10-16T00:00:00Z');
    expect(isAdmin(db, '1A')).toBe(true);
    expect(setAdmin(db, '1A', false)).toBe(true);
    expect(isAdmin(db, '1A')).toBe(false);
    expect(setAdmin(db, 'NOBODY', true)).toBe(false);
    expect(isAdmin(db, 'NOBODY')).toBe(false);
  });

  test('recordLogin stores the last sign-in time', async () => {
    await setUser(db, '1A', 'pw', '2026-10-15T00:00:00Z');
    recordLogin(db, '1A', '2026-10-15T09:00:00.000Z');
    expect(listUsers(db)[0]!.lastLoginAt).toBe('2026-10-15T09:00:00.000Z');
  });
});

describe('sessions', () => {
  const now = Date.parse('2026-10-15T12:00:00Z');

  test('token is random 32 bytes; only its SHA-256 is stored; valid for 30 days', async () => {
    await setUser(db, '2A', 'pw', '2026-10-15T00:00:00Z');
    const { token, expiresAt } = createSession(db, '2A', now);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(expiresAt).toBe(now + SESSION_TTL_MS);
    expect(SESSION_TTL_MS).toBe(30 * 24 * 3600 * 1000);
    const row = db.prepare('SELECT token_hash FROM sessions').get() as { token_hash: string };
    expect(row.token_hash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(JSON.stringify(db.prepare('SELECT * FROM sessions').all())).not.toContain(token);

    expect(findSessionUser(db, token, now + 1000)).toBe('2A');
    expect(findSessionUser(db, token, now + SESSION_TTL_MS + 1)).toBeNull();
    expect(findSessionUser(db, 'nope', now)).toBeNull();
  });

  test('deleteSession revokes the token', async () => {
    await setUser(db, '2A', 'pw', '2026-10-15T00:00:00Z');
    const { token } = createSession(db, '2A', now);
    deleteSession(db, token);
    expect(findSessionUser(db, token, now)).toBeNull();
  });
});

describe('expanded list', () => {
  test('per user, empty by default, replaced on set', async () => {
    await setUser(db, '1A', 'pw', '2026-10-15T00:00:00Z');
    await setUser(db, '2A', 'pw', '2026-10-15T00:00:00Z');
    expect(getExpanded(db, '1A')).toEqual([]);
    setExpanded(db, '1A', ['TSM', 'AAPL'], '2026-10-15T00:00:00Z');
    setExpanded(db, '1A', ['NVDA'], '2026-10-15T00:00:01Z');
    expect(getExpanded(db, '1A')).toEqual(['NVDA']);
    expect(getExpanded(db, '2A')).toEqual([]);
  });
});
