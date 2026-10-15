import { createHash, randomBytes } from 'node:crypto';
import type { Db } from '../db/repo.js';
import { hashPassword } from './password.js';

export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
CREATE TABLE IF NOT EXISTS user_hidden (
  user_id TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  symbols TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

export function ensureAuthSchema(db: Db): void {
  db.exec(SCHEMA);
}

/** User IDs are case-insensitive on input and stored uppercase. Returns null for an invalid ID. */
export function normalizeUserId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const id = raw.trim().toUpperCase();
  return /^[A-Z0-9_.-]{1,32}$/.test(id) ? id : null;
}

export async function setUser(db: Db, rawId: string, password: string, now: string): Promise<'created' | 'updated'> {
  const id = normalizeUserId(rawId);
  if (!id) throw new Error('User ID must be 1-32 letters, digits, dot, dash or underscore');
  if (!password) throw new Error('Password must not be empty');
  const hash = await hashPassword(password);
  const existed = getPasswordHash(db, id) != null;
  db.prepare(`INSERT INTO users (id, password_hash, created_at) VALUES (?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET password_hash = excluded.password_hash`).run(id, hash, now);
  // A password change signs the user out everywhere.
  if (existed) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  return existed ? 'updated' : 'created';
}

export function getPasswordHash(db: Db, id: string): string | null {
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(id) as { password_hash: string } | undefined;
  return row?.password_hash ?? null;
}

export function listUsers(db: Db): { id: string; createdAt: string }[] {
  return (db.prepare('SELECT id, created_at FROM users ORDER BY created_at, id').all() as { id: string; created_at: string }[])
    .map((r) => ({ id: r.id, createdAt: r.created_at }));
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function createSession(db: Db, userId: string, now: number): { token: string; expiresAt: number } {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = now + SESSION_TTL_MS;
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256(token), userId, expiresAt);
  return { token, expiresAt };
}

export function findSessionUser(db: Db, token: string, now: number): string | null {
  const row = db.prepare('SELECT user_id, expires_at FROM sessions WHERE token_hash = ?').get(sha256(token)) as
    { user_id: string; expires_at: number } | undefined;
  return row && row.expires_at > now ? row.user_id : null;
}

export function deleteSession(db: Db, token: string): void {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

export function getHidden(db: Db, userId: string): string[] {
  const row = db.prepare('SELECT symbols FROM user_hidden WHERE user_id = ?').get(userId) as { symbols: string } | undefined;
  if (!row) return [];
  try {
    const v: unknown = JSON.parse(row.symbols);
    return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

export function setHidden(db: Db, userId: string, symbols: string[], now: string): void {
  db.prepare(`INSERT INTO user_hidden (user_id, symbols, updated_at) VALUES (?, ?, ?)
    ON CONFLICT (user_id) DO UPDATE SET symbols = excluded.symbols, updated_at = excluded.updated_at`)
    .run(userId, JSON.stringify(symbols), now);
}
