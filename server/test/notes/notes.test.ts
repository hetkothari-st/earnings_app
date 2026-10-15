import { beforeEach, describe, expect, test } from 'vitest';
import { type Db, listRange, openDb, setSecResult, upsertCalendarRow } from '../../src/db/repo.js';
import { listNotes, noteDeadline, purgeExpiredNotes, setNote } from '../../src/notes/store.js';
import type { CalendarRow } from '../../src/types.js';

const NOW = '2026-10-15T08:00:00.000Z';
const cal = (over: Partial<CalendarRow> = {}): CalendarRow => ({
  symbol: 'SCHW', name: 'Charles Schwab', reportDate: '2026-10-15', fiscalQuarter: 'Sep/2026', timing: 'BMO',
  marketCap: 1.6e11, epsEstimate: 1.66, noOfEsts: 10, epsActual: null, epsSurprisePct: null,
  lastYearEps: null, lastYearReportDate: null, ...over,
});

let db: Db;
let id: number;
beforeEach(() => {
  db = openDb(':memory:');
  upsertCalendarRow(db, cal(), NOW, '2026-10-15');
  id = listRange(db, { from: '2026-10-15', to: '2026-10-15', minCap: null, q: null })[0]!.id;
});

describe('noteDeadline: 24 hours after the results', () => {
  test('BMO: 9:30 AM ET on the report day + 24h', () => {
    expect(noteDeadline({ reportDate: '2026-10-15', timing: 'BMO', secAcceptedAt: null })).toBe('2026-10-16T13:30:00.000Z');
  });
  test('AMC: the close + 24h; early-close day uses 1 PM', () => {
    expect(noteDeadline({ reportDate: '2026-10-15', timing: 'AMC', secAcceptedAt: null })).toBe('2026-10-16T20:00:00.000Z');
    expect(noteDeadline({ reportDate: '2026-11-27', timing: 'AMC', secAcceptedAt: null })).toBe('2026-11-28T18:00:00.000Z');
  });
  test('unknown time: end of the report day ET + 24h', () => {
    expect(noteDeadline({ reportDate: '2026-10-15', timing: 'UNKNOWN', secAcceptedAt: null })).toBe('2026-10-17T03:59:59.000Z');
  });
  test('the SEC filing time is used when known', () => {
    expect(noteDeadline({ reportDate: '2026-10-15', timing: 'BMO', secAcceptedAt: '2026-10-15T06:30:38' })).toBe('2026-10-16T10:30:38.000Z');
  });
});

describe('notes store', () => {
  test('notes belong to one user; saving again replaces; empty text deletes', () => {
    setNote(db, '1A', id, 'watch guidance', NOW);
    expect(listNotes(db, '1A', Date.parse(NOW))).toEqual([
      { reportId: id, text: 'watch guidance', updatedAt: NOW, deleteAt: '2026-10-16T13:30:00.000Z' },
    ]);
    expect(listNotes(db, '2A', Date.parse(NOW))).toEqual([]);
    setNote(db, '1A', id, 'changed', NOW);
    expect(listNotes(db, '1A', Date.parse(NOW))[0]!.text).toBe('changed');
    setNote(db, '1A', id, '   ', NOW);
    expect(listNotes(db, '1A', Date.parse(NOW))).toEqual([]);
  });
  test('expired notes are never returned and are deleted from the database', () => {
    setNote(db, '1A', id, 'old', NOW);
    expect(listNotes(db, '1A', Date.parse('2026-10-16T13:30:01Z'))).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM notes').get()).toMatchObject({ n: 0 });
  });
  test('purge deletes every expired note for every user, keeps live ones', () => {
    setNote(db, '1A', id, 'a', NOW);
    upsertCalendarRow(db, cal({ symbol: 'LATER', reportDate: '2026-10-20' }), NOW, '2026-10-15');
    const later = listRange(db, { from: '2026-10-20', to: '2026-10-20', minCap: null, q: null })[0]!.id;
    setNote(db, '2A', later, 'b', NOW);
    expect(purgeExpiredNotes(db, Date.parse('2026-10-17T00:00:00Z'))).toBe(1);
    expect(listNotes(db, '2A', Date.parse('2026-10-17T00:00:00Z')).map((n) => n.text)).toEqual(['b']);
  });
  test('a later SEC filing time moves the deadline', () => {
    setNote(db, '1A', id, 'x', NOW);
    setSecResult(db, id, { check: 'verified', timing: 'BMO', timingSource: 'nasdaq', acceptedAt: '2026-10-15T06:30:38', docUrl: null, indexUrl: null }, NOW);
    expect(listNotes(db, '1A', Date.parse(NOW))[0]!.deleteAt).toBe('2026-10-16T10:30:38.000Z');
  });
  test('note text is limited to 5000 characters', () => {
    expect(() => setNote(db, '1A', id, 'x'.repeat(5001), NOW)).toThrow(RangeError);
  });
});
