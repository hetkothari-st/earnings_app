import { createHash, randomBytes } from 'node:crypto';
import type { Db } from '../db/repo.js';
import { hashPassword } from './password.js';

export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  last_login_at TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
CREATE TABLE IF NOT EXISTS user_expanded (
  user_id TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  symbols TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

/** Columns added to `users` after it first shipped; older databases gain them on start-up. */
const USER_COLUMNS_ADDED = [
  ['is_admin', 'INTEGER NOT NULL DEFAULT 0'],
  ['last_login_at', 'TEXT'],
] as const;

export function ensureAuthSchema(db: Db): void {
  db.exec(SCHEMA);
  const have = new Set((db.prepare('PRAGMA table_info(users)').all() as { name: string }[]).map((c) => c.name));
  for (const [name, type] of USER_COLUMNS_ADDED) {
    if (!have.has(name)) db.exec(`ALTER TABLE users ADD COLUMN ${name} ${type}`);
  }
}

export const USER_ID_RULE = 'User ID must be 1-64 letters, digits, dot, dash, underscore or @';

/** User IDs are case-insensitive on input and stored uppercase. Returns null for an invalid ID. */
export function normalizeUserId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const id = raw.trim().toUpperCase();
  return /^[A-Z0-9_.@-]{1,64}$/.test(id) ? id : null;
}

export async function setUser(db: Db, rawId: string, password: string, now: string): Promise<'created' | 'updated'> {
  const id = normalizeUserId(rawId);
  if (!id) throw new Error(USER_ID_RULE);
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

export interface UserSummary {
  id: string;
  isAdmin: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

export function listUsers(db: Db): UserSummary[] {
  type Row = { id: string; is_admin: number; created_at: string; last_login_at: string | null };
  return (db.prepare('SELECT id, is_admin, created_at, last_login_at FROM users ORDER BY created_at, id').all() as Row[])
    .map((r) => ({ id: r.id, isAdmin: r.is_admin === 1, createdAt: r.created_at, lastLoginAt: r.last_login_at }));
}

export function isAdmin(db: Db, id: string): boolean {
  const row = db.prepare('SELECT is_admin FROM users WHERE id = ?').get(id) as { is_admin: number } | undefined;
  return row?.is_admin === 1;
}

/** Grants or revokes admin. Returns false when the user does not exist. */
export function setAdmin(db: Db, rawId: string, admin: boolean): boolean {
  const id = normalizeUserId(rawId);
  if (!id) return false;
  return Number(db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(admin ? 1 : 0, id).changes) > 0;
}

export function recordLogin(db: Db, id: string, at: string): void {
  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(at, id);
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

export function getExpanded(db: Db, userId: string): string[] {
  const row = db.prepare('SELECT symbols FROM user_expanded WHERE user_id = ?').get(userId) as { symbols: string } | undefined;
  if (!row) return [];
  try {
    const v: unknown = JSON.parse(row.symbols);
    return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

export function setExpanded(db: Db, userId: string, symbols: string[], now: string): void {
  db.prepare(`INSERT INTO user_expanded (user_id, symbols, updated_at) VALUES (?, ?, ?)
    ON CONFLICT (user_id) DO UPDATE SET symbols = excluded.symbols, updated_at = excluded.updated_at`)
    .run(userId, JSON.stringify(symbols), now);
}
