import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { IN_SCHEMA } from '../../src/india/db/schema.js';
import {
  ensureInSchema,
  upsertInCalendarRow,
  mergeInFiling,
  listInRange,
  getInPref,
  setInPref,
  saveFoList,
  recordRelease,
  IN_ID_BASE,
} from '../../src/india/db/inRepo.js';

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(IN_SCHEMA);
  ensureInSchema(db);
  saveFoList(db, [{ symbol: 'RELIANCE', name: 'RELIANCE INDUSTRIES', lotSize: 500 }, { symbol: 'TATACOMM', name: 'TATA COMMUNICATIONS', lotSize: 350 }],
    '2026-10-15T00:00:00Z');
  return db;
}

describe('upsertInCalendarRow', () => {
  it('inserts a new row', () => {
    const db = makeDb();
    upsertInCalendarRow(db, {
      symbol: 'RELIANCE', name: 'Reliance Industries', quarterEnd: '2026-09-30',
      quarterLabel: 'Sep/2026', reportDate: '2026-10-17',
    }, new Date().toISOString());
    const rows = listInRange(db, { from: '2026-10-17', to: '2026-10-17', q: null });
    expect(rows.length).toBe(1);
    expect(rows[0]!.symbol).toBe('RELIANCE');
  });

  it('updates report_date when rescheduled (Review Focus #2)', () => {
    const db = makeDb();
    const now = new Date().toISOString();
    upsertInCalendarRow(db, {
      symbol: 'RELIANCE', name: 'Reliance', quarterEnd: '2026-09-30',
      quarterLabel: 'Sep/2026', reportDate: '2026-10-17',
    }, now);
    // Reschedule to a different date
    upsertInCalendarRow(db, {
      symbol: 'RELIANCE', name: 'Reliance', quarterEnd: '2026-09-30',
      quarterLabel: 'Sep/2026', reportDate: '2026-10-22',
    }, now);
    const rows = listInRange(db, { from: '2026-10-22', to: '2026-10-22', q: null });
    expect(rows[0]!.reportDate).toBe('2026-10-22');
    expect(rows[0]!.rescheduledFrom).toBe('2026-10-17');
  });
});

describe('mergeInFiling - Consolidated wins over standalone (Review Focus #1)', () => {
  it('consolidated actuals overwrite standalone actuals', () => {
    const db = makeDb();
    const now = new Date().toISOString();
    const base = {
      symbol: 'TATACOMM', name: 'Tata Comm', quarterEnd: '2026-09-30',
      quarterLabel: 'Sep/2026', reportDate: '2026-10-17',
      revenueActual: 5_000_000_000, revenueKind: 'revenue-from-ops',
      pnlActual: 500_000_000, epsActual: 10.0,
    };
    // Insert standalone first
    mergeInFiling(db, { ...base, nature: 'Standalone' }, now);
    // Then consolidated with higher numbers
    mergeInFiling(db, { ...base, nature: 'Consolidated', revenueActual: 9_000_000_000, epsActual: 18.0 }, now);

    const rows = listInRange(db, { from: '2026-10-17', to: '2026-10-17', q: null });
    expect(rows[0]!.nature).toBe('Consolidated');
    expect(rows[0]!.revenueActual).toBe(9_000_000_000);
    expect(rows[0]!.epsActual).toBe(18.0);
  });

  it('standalone does NOT overwrite consolidated actuals', () => {
    const db = makeDb();
    const now = new Date().toISOString();
    const base = {
      symbol: 'TATACOMM', name: 'Tata Comm', quarterEnd: '2026-09-30',
      quarterLabel: 'Sep/2026', reportDate: '2026-10-17',
      revenueActual: 9_000_000_000, revenueKind: 'revenue-from-ops',
      pnlActual: 900_000_000, epsActual: 18.0,
    };
    // Insert consolidated first
    mergeInFiling(db, { ...base, nature: 'Consolidated' }, now);
    // Then try to overwrite with standalone
    mergeInFiling(db, { ...base, nature: 'Standalone', revenueActual: 5_000_000_000, epsActual: 10.0 }, now);

    const rows = listInRange(db, { from: '2026-10-17', to: '2026-10-17', q: null });
    expect(rows[0]!.epsActual).toBe(18.0); // consolidated wins
  });
});

describe('user_prefs market preference', () => {
  it('defaults to US', () => {
    const db = makeDb();
    expect(getInPref(db, 'user1')).toBe('US');
  });

  it('stores and retrieves India preference', () => {
    const db = makeDb();
    const now = new Date().toISOString();
    setInPref(db, 'user1', 'IN', now);
    expect(getInPref(db, 'user1')).toBe('IN');
  });

  it('updates existing preference', () => {
    const db = makeDb();
    const now = new Date().toISOString();
    setInPref(db, 'user1', 'IN', now);
    setInPref(db, 'user1', 'US', now);
    expect(getInPref(db, 'user1')).toBe('US');
  });
});

describe('listInRange search', () => {
  it('filters by symbol prefix', () => {
    const db = makeDb();
    const now = new Date().toISOString();
    upsertInCalendarRow(db, {
      symbol: 'RELIANCE', name: 'Reliance Industries', quarterEnd: '2026-09-30',
      quarterLabel: 'Sep/2026', reportDate: '2026-10-17',
    }, now);
    upsertInCalendarRow(db, {
      symbol: 'TATACOMM', name: 'Tata Communications', quarterEnd: '2026-09-30',
      quarterLabel: 'Sep/2026', reportDate: '2026-10-18',
    }, now);
    const rows = listInRange(db, { from: '2026-10-17', to: '2026-10-18', q: 'RELI' });
    expect(rows.length).toBe(1);
    expect(rows[0]!.symbol).toBe('RELIANCE');
  });
});

describe('India report ids and the F&O universe', () => {
  it('ids start above the US range', () => {
    const db = makeDb();
    const id = upsertInCalendarRow(db, { symbol: 'RELIANCE', name: 'Reliance', quarterEnd: '2026-09-30', quarterLabel: 'Sep/2026', reportDate: '2026-10-17' }, 'now');
    expect(id).toBe(IN_ID_BASE);
  });

  it('old low ids are moved above the base on open', () => {
    const db = makeDb();
    db.prepare(`INSERT INTO in_reports (id, symbol, name, quarter_end, quarter_label, report_date) VALUES (7, 'RELIANCE', 'R', '2026-09-30', 'Sep/2026', '2026-10-17')`).run();
    ensureInSchema(db);
    expect(listInRange(db, { from: '2026-10-17', to: '2026-10-17', q: null })[0]!.id).toBe(IN_ID_BASE + 6);
  });

  it('stocks not in the F&O list are not listed', () => {
    const db = makeDb();
    upsertInCalendarRow(db, { symbol: 'AKIKO', name: 'Akiko Global', quarterEnd: '2026-09-30', quarterLabel: 'Sep/2026', reportDate: '2026-10-17' }, 'now');
    expect(listInRange(db, { from: '2026-10-17', to: '2026-10-17', q: null })).toHaveLength(0);
  });
});

describe('calendar rules', () => {
  const row = { symbol: 'RELIANCE', name: 'Reliance Industries Limited', quarterEnd: '2026-09-30', quarterLabel: 'Sep/2026', reportDate: '2026-10-17' };

  it('re-reading the same notice keeps the timing already found', () => {
    const db = makeDb();
    const id = upsertInCalendarRow(db, row, 'now');
    recordRelease(db, id, '2026-10-17T11:00:00.000Z', 'nse-filing'); // 16:30 IST
    upsertInCalendarRow(db, row, 'later');
    expect(listInRange(db, { from: '2026-10-17', to: '2026-10-17', q: null })[0]!.timing).toBe('AMC');
  });

  it('a Yahoo estimate never replaces an NSE date', () => {
    const db = makeDb();
    upsertInCalendarRow(db, row, 'now');
    upsertInCalendarRow(db, { ...row, reportDate: '2026-10-25', dateStatus: 'estimated' }, 'now');
    const r = listInRange(db, { from: '2026-10-01', to: '2026-10-31', q: null })[0]!;
    expect(r).toMatchObject({ reportDate: '2026-10-17', dateStatus: 'confirmed', rescheduledFrom: null });
  });

  it('an NSE notice replaces a Yahoo estimate without calling it a reschedule', () => {
    const db = makeDb();
    upsertInCalendarRow(db, { ...row, reportDate: '2026-10-25', dateStatus: 'estimated' }, 'now');
    upsertInCalendarRow(db, row, 'now');
    const r = listInRange(db, { from: '2026-10-01', to: '2026-10-31', q: null })[0]!;
    expect(r).toMatchObject({ reportDate: '2026-10-17', dateStatus: 'confirmed', rescheduledFrom: null });
  });
});

describe('recordRelease: earliest wins, timing by IST clock', () => {
  const row = { symbol: 'RELIANCE', name: 'Reliance', quarterEnd: '2026-09-30', quarterLabel: 'Sep/2026', reportDate: '2026-10-16' };
  const first = (db: DatabaseSync) => listInRange(db, { from: '2026-10-16', to: '2026-10-16', q: null })[0]!;

  it('during market, then a later filing does not change it', () => {
    const db = makeDb();
    const id = upsertInCalendarRow(db, row, 'now');
    expect(recordRelease(db, id, '2026-10-16T08:00:00.000Z', 'nse-announcement')).toBe(true); // 13:30 IST
    expect(recordRelease(db, id, '2026-10-16T12:00:00.000Z', 'nse-filing')).toBe(false);
    expect(first(db)).toMatchObject({ timing: 'DMH', timingSource: 'nse-announcement' });
  });

  it('just after midnight for the meeting of the day before counts as after close', () => {
    const db = makeDb();
    const id = upsertInCalendarRow(db, row, 'now');
    recordRelease(db, id, '2026-10-16T19:00:00.000Z', 'nse-filing'); // 00:30 IST on the 17th
    expect(first(db).timing).toBe('AMC');
  });

  it('a filing weeks later is not the release of this report', () => {
    const db = makeDb();
    const id = upsertInCalendarRow(db, row, 'now');
    expect(recordRelease(db, id, '2026-11-20T06:00:00.000Z', 'nse-filing')).toBe(false);
    expect(first(db).timing).toBe('UNKNOWN');
  });
});

describe('late filing for an older quarter (Review Focus #2)', () => {
  it('updates only the row with the matching quarter end', () => {
    const db = makeDb();
    upsertInCalendarRow(db, { symbol: 'RELIANCE', name: 'R', quarterEnd: '2026-09-30', quarterLabel: 'Sep/2026', reportDate: '2026-10-17' }, 'now');
    mergeInFiling(db, { symbol: 'RELIANCE', name: 'R', quarterEnd: '2026-06-30', quarterLabel: 'Jun/2026', reportDate: '2026-07-18',
      revenueActual: 1, revenueKind: 'revenue-from-ops', pnlActual: 1, epsActual: 1, nature: 'Consolidated' }, 'now');
    expect(listInRange(db, { from: '2026-10-17', to: '2026-10-17', q: null })[0]!.epsActual).toBeNull();
    expect(listInRange(db, { from: '2026-07-18', to: '2026-07-18', q: null })[0]!.epsActual).toBe(1);
  });

  it('a filing without a figure never blanks a stored one', () => {
    const db = makeDb();
    const base = { symbol: 'RELIANCE', name: 'R', quarterEnd: '2026-09-30', quarterLabel: 'Sep/2026', reportDate: '2026-10-17',
      revenueKind: 'revenue-from-ops', nature: 'Consolidated' as const };
    mergeInFiling(db, { ...base, revenueActual: 5, pnlActual: 2, epsActual: 3 }, 'now');
    const { changed } = mergeInFiling(db, { ...base, revenueActual: null, pnlActual: null, epsActual: null }, 'now');
    expect(changed).toBe(false);
    expect(listInRange(db, { from: '2026-10-17', to: '2026-10-17', q: null })[0]).toMatchObject({ revenueActual: 5, pnlActual: 2, epsActual: 3 });
  });
});
