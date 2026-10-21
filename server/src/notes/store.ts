import { DateTime } from 'luxon';
import type { Db } from '../db/repo.js';
import { ET, sessionClose } from '../domain/marketCalendar.js';
import { IST } from '../india/domain/nseCalendar.js';
import type { Timing } from '../types.js';

export const MAX_NOTE_LENGTH = 5000;
const KEEP_AFTER_RESULTS_MS = 24 * 3_600_000;

export interface Note {
  reportId: number;
  text: string;
  updatedAt: string;
  deleteAt: string; // ISO instant: 24 hours after the results
}

const ready = new WeakSet<Db>();

/** Notes table; secure_delete makes SQLite overwrite deleted text instead of leaving it in free pages. */
export function ensureNotesSchema(db: Db): void {
  if (ready.has(db)) return;
  db.exec(`PRAGMA secure_delete = ON;
    CREATE TABLE IF NOT EXISTS notes (
      user_id TEXT NOT NULL,
      report_id INTEGER NOT NULL,
      text TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, report_id)
    );`);
  ready.add(db);
}

/**
 * When the results came out: the SEC filing time if known, else 9:30 AM ET for BMO, the close for
 * AMC/during market, end of day for unknown. Notes are deleted 24 hours after that.
 */
export function noteDeadline(r: { reportDate: string; timing: Timing; secAcceptedAt: string | null }): string {
  let released: DateTime;
  if (r.secAcceptedAt) released = DateTime.fromISO(r.secAcceptedAt, { zone: ET });
  else if (r.timing === 'BMO') released = DateTime.fromISO(`${r.reportDate}T09:30`, { zone: ET });
  else if (r.timing === 'UNKNOWN') released = DateTime.fromISO(`${r.reportDate}T23:59:59`, { zone: ET });
  else released = DateTime.fromISO(`${r.reportDate}T${sessionClose(r.reportDate)}`, { zone: ET });
  return new Date(released.toMillis() + KEEP_AFTER_RESULTS_MS).toISOString();
}

/**
 * India: 24 hours after the NSE release if known, else 09:15 IST for before-open, the 15:30 close for
 * during-market/after-close, end of day for unknown.
 */
export function inNoteDeadline(r: { reportDate: string; timing: Timing; releasedAt: string | null }): string {
  let released: DateTime;
  if (r.releasedAt) released = DateTime.fromISO(r.releasedAt);
  else if (r.timing === 'BMO') released = DateTime.fromISO(`${r.reportDate}T09:15`, { zone: IST });
  else if (r.timing === 'UNKNOWN') released = DateTime.fromISO(`${r.reportDate}T23:59:59`, { zone: IST });
  else released = DateTime.fromISO(`${r.reportDate}T15:30`, { zone: IST });
  return new Date(released.toMillis() + KEEP_AFTER_RESULTS_MS).toISOString();
}

interface Row {
  userId: string; reportId: number; text: string; updatedAt: string; reportDate: string | null; timing: Timing | null; secAcceptedAt: string | null;
  inReportDate: string | null; inTiming: Timing | null; inReleasedAt: string | null;
}

function rows(db: Db, userId: string | null): Row[] {
  ensureNotesSchema(db);
  return db.prepare(`SELECT n.user_id AS userId, n.report_id AS reportId, n.text, n.updated_at AS updatedAt,
        r.report_date AS reportDate, r.timing, r.sec_accepted_at AS secAcceptedAt,
        i.report_date AS inReportDate, i.timing AS inTiming, i.released_at AS inReleasedAt
      FROM notes n LEFT JOIN reports r ON r.id = n.report_id LEFT JOIN in_reports i ON i.id = n.report_id
      ${userId == null ? '' : 'WHERE n.user_id = ?'} ORDER BY COALESCE(r.report_date, i.report_date)`)
    .all(...(userId == null ? [] : [userId])) as unknown as Row[];
}

const deadlineOf = (r: Row) => {
  if (r.reportDate && r.timing) return noteDeadline({ reportDate: r.reportDate, timing: r.timing, secAcceptedAt: r.secAcceptedAt });
  if (r.inReportDate && r.inTiming) return inNoteDeadline({ reportDate: r.inReportDate, timing: r.inTiming, releasedAt: r.inReleasedAt });
  return null;
};

function hardDelete(db: Db, expired: Row[]): void {
  if (expired.length === 0) return;
  const del = db.prepare('DELETE FROM notes WHERE user_id = ? AND report_id = ?');
  for (const r of expired) del.run(r.userId, r.reportId);
  // Flush the write-ahead log so deleted text does not linger in the -wal file.
  try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* in-memory databases have no WAL */ }
}

/** The user's live notes. Expired ones are deleted on the spot and never returned. */
export function listNotes(db: Db, userId: string, nowMs: number): Note[] {
  const live: Note[] = [];
  const expired: Row[] = [];
  for (const r of rows(db, userId)) {
    const deleteAt = deadlineOf(r);
    if (!deleteAt || Date.parse(deleteAt) <= nowMs) expired.push(r);
    else live.push({ reportId: r.reportId, text: r.text, updatedAt: r.updatedAt, deleteAt });
  }
  hardDelete(db, expired);
  return live;
}

/** Saves the note; blank text deletes it. Returns the saved note, or null when deleted. */
export function setNote(db: Db, userId: string, reportId: number, text: string, now: string): Note | null {
  ensureNotesSchema(db);
  if (text.length > MAX_NOTE_LENGTH) throw new RangeError(`Notes are limited to ${MAX_NOTE_LENGTH} characters`);
  if (text.trim() === '') {
    db.prepare('DELETE FROM notes WHERE user_id = ? AND report_id = ?').run(userId, reportId);
    return null;
  }
  db.prepare(`INSERT INTO notes (user_id, report_id, text, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (user_id, report_id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at`)
    .run(userId, reportId, text, now);
  return listNotes(db, userId, Date.parse(now)).find((n) => n.reportId === reportId) ?? null;
}

/** Deletes every expired note (all users). Returns how many were deleted. */
export function purgeExpiredNotes(db: Db, nowMs: number): number {
  const expired = rows(db, null).filter((r) => {
    const d = deadlineOf(r);
    return !d || Date.parse(d) <= nowMs;
  });
  hardDelete(db, expired);
  return expired.length;
}
