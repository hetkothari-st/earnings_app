import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  createSession, deleteSession, ensureAuthSchema, findSessionUser, getHidden, getPasswordHash, listUsers,
  normalizeUserId, SESSION_TTL_MS, setHidden, setUser,
} from '../../src/auth/store.js';
import { type Db, openDb } from '../../src/db/repo.js';

let db: Db;
beforeEach(() => { db = openDb(':memory:'); ensureAuthSchema(db); });

describe('users', () => {
  test('ids are trimmed and uppercased; invalid ids rejected', () => {
    expect(normalizeUserId(' 1a ')).toBe('1A');
    expect(normalizeUserId('')).toBeNull();
    expect(normalizeUserId('a b')).toBeNull();
    expect(normalizeUserId('x'.repeat(33))).toBeNull();
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
    expect(listUsers(db)).toEqual([{ id: '1A', createdAt: '2026-10-15T00:00:00Z' }]);
  });

  test('ensureAuthSchema is idempotent', () => {
    expect(() => ensureAuthSchema(db)).not.toThrow();
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

describe('hidden list', () => {
  test('per user, empty by default, replaced on set', async () => {
    await setUser(db, '1A', 'pw', '2026-10-15T00:00:00Z');
    await setUser(db, '2A', 'pw', '2026-10-15T00:00:00Z');
    expect(getHidden(db, '1A')).toEqual([]);
    setHidden(db, '1A', ['TSM', 'AAPL'], '2026-10-15T00:00:00Z');
    setHidden(db, '1A', ['NVDA'], '2026-10-15T00:00:01Z');
    expect(getHidden(db, '1A')).toEqual(['NVDA']);
    expect(getHidden(db, '2A')).toEqual([]);
  });
});
