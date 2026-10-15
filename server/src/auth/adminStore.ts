import { type Db, inTransaction } from '../db/repo.js';
import { ensureNotesSchema } from '../notes/store.js';
import { listUsers, type UserSummary } from './store.js';

/** User management for admins. IDs passed here are already normalized. */

export function getUser(db: Db, id: string): UserSummary | null {
  return listUsers(db).find((u) => u.id === id) ?? null;
}

export function existingIds(db: Db, ids: string[]): string[] {
  const has = db.prepare('SELECT 1 FROM users WHERE id = ?');
  return ids.filter((id) => has.get(id) !== undefined);
}

export function countAdmins(db: Db): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1').get() as { n: number }).n;
}

/** Inserts all users or none. Callers check for existing IDs first; a race still fails the whole batch. */
export function insertUsers(db: Db, users: { id: string; hash: string; isAdmin: boolean }[], now: string): void {
  const insert = db.prepare('INSERT INTO users (id, password_hash, created_at, is_admin) VALUES (?, ?, ?, ?)');
  inTransaction(db, () => {
    for (const u of users) insert.run(u.id, u.hash, now, u.isAdmin ? 1 : 0);
  });
}

export interface UserChange {
  hash?: string;
  isAdmin?: boolean;
  newId?: string;
}

/**
 * Applies a password change (signs the user out everywhere), an admin toggle and a rename in one
 * transaction. A rename signs the user out and moves their expanded list and notes to the new ID.
 */
export function updateUser(db: Db, id: string, change: UserChange): void {
  ensureNotesSchema(db); // the notes table may not exist yet in this database
  inTransaction(db, () => {
    if (change.hash !== undefined) {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(change.hash, id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    }
    if (change.isAdmin !== undefined) db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(change.isAdmin ? 1 : 0, id);
    const to = change.newId;
    if (to !== undefined && to !== id) {
      // Child rows reference users(id) without ON UPDATE CASCADE, so copy the user, re-point the rows, then drop the old one.
      db.prepare(`INSERT INTO users (id, password_hash, created_at, is_admin, last_login_at)
        SELECT ?, password_hash, created_at, is_admin, last_login_at FROM users WHERE id = ?`).run(to, id);
      db.prepare('UPDATE user_expanded SET user_id = ? WHERE user_id = ?').run(to, id);
      db.prepare('UPDATE notes SET user_id = ? WHERE user_id = ?').run(to, id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM users WHERE id = ?').run(id);
    }
  });
}

/** Deletes the user and everything that belongs to them. */
export function deleteUser(db: Db, id: string): void {
  ensureNotesSchema(db); // creates the table if missing and turns on secure_delete for the note text
  inTransaction(db, () => {
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM user_expanded WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM notes WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
  });
}
