import { describe, expect, test } from 'vitest';
import { buildServer } from '../../src/api/server.js';
import { createSession, ensureAuthSchema } from '../../src/auth/store.js';
import { openDb } from '../../src/db/repo.js';

function setup() {
  const db = openDb(':memory:');
  ensureAuthSchema(db);
  db.prepare('INSERT INTO users (id, password_hash, created_at, is_admin) VALUES (?, ?, ?, 0)').run('1A', 'x', '2026-10-01T00:00:00Z');
  const now = Date.parse('2026-10-15T12:00:00Z');
  const calls: [string, string[]][] = [];
  const app = buildServer(db, { requireAuth: true, now: () => now, setVisible: (u, s) => { calls.push([u, s]); } });
  const cookie = `session=${createSession(db, '1A', now).token}`;
  const put = (payload: unknown, headers: Record<string, string> = { cookie }) =>
    app.inject({ method: 'PUT', url: '/api/live/visible', headers, payload: payload as object });
  return { calls, put };
}

describe('PUT /api/live/visible', () => {
  test('401 without a user', async () => {
    const { put, calls } = setup();
    expect((await put({ market: 'US', symbols: ['AAPL'] }, {})).statusCode).toBe(401);
    expect(calls).toEqual([]);
  });
  test('stores normalized, deduplicated symbols for the signed-in user', async () => {
    const { put, calls } = setup();
    expect((await put({ market: 'US', symbols: ['aapl', 'BRK.B', 'BRK/B'] })).statusCode).toBe(204);
    expect(calls).toEqual([['1A', ['AAPL', 'BRK-B']]]);
  });
  test('rejects bad input', async () => {
    const { put } = setup();
    expect((await put({ market: 'IN', symbols: [] })).statusCode).toBe(400);
    expect((await put({ market: 'US', symbols: 'AAPL' })).statusCode).toBe(400);
    expect((await put({ market: 'US', symbols: ['A B'] })).statusCode).toBe(400);
    expect((await put({ market: 'US', symbols: ['TOOLONGSYMBOL1'] })).statusCode).toBe(400);
    expect((await put({ market: 'US', symbols: Array.from({ length: 101 }, (_, i) => `S${i}`) })).statusCode).toBe(400);
  });
});
