import { describe, expect, it } from 'vitest';
import { buildServer } from '../../src/api/server.js';
import { openDb } from '../../src/db/repo.js';
import { mergeInFiling, recordRelease, saveFoList, setInEstimates, upsertInCalendarRow } from '../../src/india/db/inRepo.js';
import type { InEarningsResponse } from '../../src/india/api/types.js';
import { inNoteDeadline, listNotes, setNote } from '../../src/notes/store.js';

const NOW = '2026-10-15T06:00:00.000Z';

function setup() {
  const db = openDb(':memory:');
  saveFoList(db, [{ symbol: 'TATACOMM', name: 'TATA COMMUNICATIONS', lotSize: 350 }, { symbol: 'UCOBANK', name: 'UCO BANK', lotSize: 1 }], NOW);
  const base = { quarterEnd: '2026-09-30', quarterLabel: 'Sep/2026', reportDate: '2026-10-15' };
  const tc = upsertInCalendarRow(db, { symbol: 'TATACOMM', name: 'Tata Communications Limited', ...base }, NOW);
  setInEstimates(db, tc, { eps: 11, epsAnalysts: 5, revenue: 6e10, revenueAnalysts: 4 }, NOW);
  mergeInFiling(db, { symbol: 'TATACOMM', name: 'Tata Communications Limited', ...base, revenueActual: 66_878_900_000,
    revenueKind: 'revenue-from-ops', pnlActual: 3e9, epsActual: 11.96, nature: 'Consolidated' }, NOW);
  const uco = upsertInCalendarRow(db, { symbol: 'UCOBANK', name: 'UCO Bank', ...base }, NOW);
  setInEstimates(db, uco, { eps: 0.5, epsAnalysts: 2, revenue: 7e10, revenueAnalysts: 2 }, NOW);
  mergeInFiling(db, { symbol: 'UCOBANK', name: 'UCO Bank', ...base, revenueActual: 81_740_800_000,
    revenueKind: 'total-income', pnlActual: 7.8e9, epsActual: 0.63, nature: 'Standalone' }, NOW);
  return { db, tc, uco };
}

describe('GET /api/in/earnings', () => {
  it('beat/miss only for consolidated actuals; banks never get a revenue colour', async () => {
    const { db } = setup();
    const app = buildServer(db);
    const res = await app.inject({ url: '/api/in/earnings?from=2026-10-15&to=2026-10-15' });
    const rows = (res.json() as InEarningsResponse).rows;
    const tc = rows.find((r) => r.symbol === 'TATACOMM')!;
    const uco = rows.find((r) => r.symbol === 'UCOBANK')!;
    expect(tc.id).toBeGreaterThan(1_000_000_000);
    expect(tc).toMatchObject({ basis: 'consolidated', eps: { result: 'beat', surprisePct: 8.7 }, revenue: { result: 'beat', kind: 'revenue-from-ops' } });
    expect(uco).toMatchObject({ basis: 'standalone', eps: { result: null, surprisePct: null }, revenue: { result: null, kind: 'total-income' } });
  });

  it('rejects bad ranges', async () => {
    const app = buildServer(setup().db);
    expect((await app.inject({ url: '/api/in/earnings?from=2026-10-16&to=2026-10-15' })).statusCode).toBe(400);
  });
});

describe('GET /api/in/markets', () => {
  it('Kite ticks first, Yahoo for a missing index, nulls when both fail', async () => {
    const app = buildServer(setup().db, {
      india: {
        indexNames: ['NIFTY 50', 'SENSEX', 'NIFTY BANK'],
        indices: () => new Map([['NIFTY 50', { price: 25000, prevClose: 24800, changePct: 0.81, at: NOW, source: 'stream' as const }]]),
        yahooIndex: async (n) => (n === 'SENSEX' ? { price: 81000, prevClose: 80000 } : null),
      },
    });
    const body = (await app.inject({ url: '/api/in/markets' })).json() as { indices: unknown[] };
    expect(body.indices).toMatchObject([
      { index: 'NIFTY 50', price: 25000, source: 'kite' },
      { index: 'SENSEX', price: 81000, changePct: 1.25, source: 'yahoo' },
      { index: 'NIFTY BANK', price: null, source: null },
    ]);
  });
});

describe('India notes', () => {
  it('deadline: 24 hours after the NSE release, else by timing in IST', () => {
    expect(inNoteDeadline({ reportDate: '2026-10-15', timing: 'AMC', releasedAt: '2026-10-15T12:03:55.000Z' })).toBe('2026-10-16T12:03:55.000Z');
    expect(inNoteDeadline({ reportDate: '2026-10-15', timing: 'BMO', releasedAt: null })).toBe('2026-10-16T03:45:00.000Z');
    expect(inNoteDeadline({ reportDate: '2026-10-15', timing: 'UNKNOWN', releasedAt: null })).toBe('2026-10-16T18:29:59.000Z');
  });

  it('a note on an India report is kept until its deadline', () => {
    const { db, tc } = setup();
    recordRelease(db, tc, '2026-10-15T12:03:55.000Z', 'nse-filing');
    setNote(db, 'u1', tc, 'watch margins', NOW);
    expect(listNotes(db, 'u1', Date.parse(NOW))).toEqual([{ reportId: tc, text: 'watch margins', updatedAt: NOW, deleteAt: '2026-10-16T12:03:55.000Z' }]);
    expect(listNotes(db, 'u1', Date.parse('2026-10-16T12:04:00Z'))).toEqual([]);
  });
});
