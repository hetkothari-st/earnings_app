import { describe, expect, it } from 'vitest';
import { openDb, upsertCalendarRow } from '../../src/db/repo.js';
import {
  getHkReport, HK_ID_BASE, hkReportsBetween, hkStocks, mergeHkActuals, recordHkRelease, saveHkExpectedMove, setHkEstimates,
  setHkProfile, setHkTiming, syncHkUniverse, upsertHkCalendarRow, usAdrRows,
} from '../../src/hk/db/hkRepo.js';
import { HK_UNIVERSE, type HkUniverseEntry } from '../../src/hk/universe.js';

const NOW = '2026-10-27T00:00:00.000Z';
const ENTRIES: HkUniverseEntry[] = [
  { code: '9988', name: 'Alibaba', cadence: 'Q', fyEndMonth: 3, adr: 'BABA', adrRatio: 8, cik: 1577552 },
  { code: '0285', name: 'BYD Electronic', cadence: 'H', fyEndMonth: 12, adr: null, adrRatio: null, cik: null },
];

function setup() {
  const db = openDb(':memory:');
  syncHkUniverse(db, ENTRIES, NOW);
  return db;
}

const base = { code: '9988', name: 'Alibaba', periodEnd: '2026-09-30', periodKind: 'Q' as const, periodLabel: 'Q3 26' };

describe('hk repo', () => {
  it('ids start at 2_000_000_001', () => {
    const db = setup();
    const a = upsertHkCalendarRow(db, { ...base, reportDate: '2026-11-13', dateStatus: 'estimated' }, NOW);
    const b = upsertHkCalendarRow(db, { ...base, code: '0285', periodEnd: '2026-06-30', periodKind: 'H', periodLabel: '1H26',
      reportDate: '2026-08-20', dateStatus: 'estimated' }, NOW);
    expect(a).toBe(HK_ID_BASE);
    expect(b).toBe(HK_ID_BASE + 1);
  });

  it('estimated date never replaces confirmed; confirmed new date is a reschedule', () => {
    const db = setup();
    const id = upsertHkCalendarRow(db, { ...base, reportDate: '2026-11-13', dateStatus: 'estimated' }, NOW);
    // A confirmed notice for the estimated date confirms it.
    upsertHkCalendarRow(db, { ...base, reportDate: '2026-11-13', dateStatus: 'confirmed', timing: 'BMO', timingSource: 'sec-notice' }, NOW);
    expect(getHkReport(db, id)).toMatchObject({ reportDate: '2026-11-13', dateStatus: 'confirmed', timing: 'BMO', timingSource: 'sec-notice', rescheduledFrom: null });
    // An estimated date elsewhere does not replace it.
    upsertHkCalendarRow(db, { ...base, reportDate: '2026-11-20', dateStatus: 'estimated' }, NOW);
    expect(getHkReport(db, id)).toMatchObject({ reportDate: '2026-11-13', dateStatus: 'confirmed' });
    // A new confirmed date is a reschedule: old date kept, timing back to unknown.
    saveHkExpectedMove(db, id, { expiry: '2026-11-20', strike: 100, callMid: 5, putMid: 5, underlying: 100, movePct: 10, illiquid: false, adr: 'BABA', quoteDate: '2026-11-12' }, false, NOW);
    upsertHkCalendarRow(db, { ...base, reportDate: '2026-11-18', dateStatus: 'confirmed' }, NOW);
    const r = getHkReport(db, id)!;
    expect(r).toMatchObject({ reportDate: '2026-11-18', rescheduledFrom: '2026-11-13', timing: 'UNKNOWN', timingSource: null });
    expect(r.expectedMove).toBeNull();
  });

  it('a released row keeps its date', () => {
    const db = setup();
    const id = upsertHkCalendarRow(db, { ...base, reportDate: '2026-11-13', dateStatus: 'estimated' }, NOW);
    expect(recordHkRelease(db, id, '2026-11-13T01:00:00.000Z', 'sec-6k', 'BMO')).toBe(true);
    upsertHkCalendarRow(db, { ...base, reportDate: '2026-11-18', dateStatus: 'confirmed' }, NOW);
    expect(getHkReport(db, id)).toMatchObject({ reportDate: '2026-11-13', timing: 'BMO' });
    // The earliest release wins; a null timing is not written.
    expect(recordHkRelease(db, id, '2026-11-13T02:00:00.000Z', 'sec-8k', null)).toBe(false);
    expect(setHkTiming(db, id, 'AMC', 'yahoo')).toBe(false);
  });

  it('yahoo actuals never replace sec; sec replaces yahoo; a null never blanks', () => {
    const db = setup();
    const id = upsertHkCalendarRow(db, { ...base, reportDate: '2026-11-13', dateStatus: 'estimated' }, NOW);
    expect(mergeHkActuals(db, id, { revenue: 100, revenueCurrency: 'CNY', eps: 1.5, epsCurrency: 'CNY', epsBasis: 'share', source: 'yahoo' }, NOW)).toBe(true);
    expect(getHkReport(db, id)).toMatchObject({ epsActual: 1.5, actualSource: 'yahoo' });
    // SEC replaces Yahoo.
    expect(mergeHkActuals(db, id, { revenue: 110, revenueCurrency: 'CNY', eps: 1.6, epsCurrency: 'CNY', epsBasis: 'share', source: 'sec', docUrl: 'https://x/y' }, NOW)).toBe(true);
    expect(getHkReport(db, id)).toMatchObject({ revenueActual: 110, epsActual: 1.6, actualSource: 'sec', secDocUrl: 'https://x/y' });
    // Yahoo never replaces SEC.
    expect(mergeHkActuals(db, id, { revenue: 1, revenueCurrency: 'HKD', eps: 9, epsCurrency: 'HKD', epsBasis: 'share', source: 'yahoo' }, NOW)).toBe(false);
    expect(getHkReport(db, id)).toMatchObject({ revenueActual: 110, epsActual: 1.6, epsCurrency: 'CNY', actualSource: 'sec' });
    // A null never blanks; nothing changed.
    expect(mergeHkActuals(db, id, { revenue: null, revenueCurrency: null, eps: null, epsCurrency: null, epsBasis: null, source: 'sec' }, NOW)).toBe(false);
    expect(getHkReport(db, id)).toMatchObject({ revenueActual: 110, revenueCurrency: 'CNY', epsActual: 1.6, epsBasis: 'share' });
  });

  it('sec with the same numbers as yahoo still takes the source, so a later yahoo cannot overwrite it', () => {
    const db = setup();
    const id = upsertHkCalendarRow(db, { ...base, reportDate: '2026-11-13', dateStatus: 'estimated' }, NOW);
    const nums = { revenue: 100, revenueCurrency: 'CNY', eps: 1.5, epsCurrency: 'CNY', epsBasis: 'share' as const };
    mergeHkActuals(db, id, { ...nums, source: 'yahoo' }, NOW);
    expect(mergeHkActuals(db, id, { ...nums, source: 'sec', docUrl: 'https://www.sec.gov/d' }, NOW)).toBe(true);
    expect(getHkReport(db, id)).toMatchObject({ actualSource: 'sec', secDocUrl: 'https://www.sec.gov/d' });
    expect(mergeHkActuals(db, id, { ...nums, eps: 9, revenue: 999, source: 'yahoo' }, NOW)).toBe(false);
    expect(getHkReport(db, id)).toMatchObject({ epsActual: 1.5, revenueActual: 100, actualSource: 'sec' });
  });

  it('a new figure carries its own currency and basis, never the old ones', () => {
    const db = setup();
    const id = upsertHkCalendarRow(db, { ...base, reportDate: '2026-11-13', dateStatus: 'estimated' }, NOW);
    mergeHkActuals(db, id, { revenue: 100, revenueCurrency: 'CNY', eps: 1.5, epsCurrency: 'CNY', epsBasis: 'share', source: 'yahoo' }, NOW);
    mergeHkActuals(db, id, { revenue: 120, revenueCurrency: null, eps: 1.7, epsCurrency: null, epsBasis: null, source: 'yahoo' }, NOW);
    expect(getHkReport(db, id)).toMatchObject({
      revenueActual: 120, revenueCurrency: null, epsActual: 1.7, epsCurrency: null, epsBasis: null,
    });
  });

  it('serves the stock name: Yahoo profile name over universe name, universe fixes propagate', () => {
    const db = setup();
    const id = upsertHkCalendarRow(db, { ...base, reportDate: '2026-11-13', dateStatus: 'estimated' }, NOW);
    expect(getHkReport(db, id)!.name).toBe('Alibaba');
    setHkProfile(db, '9988', { name: 'Alibaba Group Holding', sector: null, industry: null, marketCap: null, asOf: '2026-10-27' }, NOW);
    expect(getHkReport(db, id)!.name).toBe('Alibaba Group Holding');
    expect(hkStocks(db).find((s) => s.code === '9988')!.name).toBe('Alibaba Group Holding');
    // as-of is gated on asOf itself, not on the market cap
    setHkProfile(db, '9988', { name: null, sector: null, industry: null, marketCap: null, asOf: '2026-10-28' }, NOW);
    expect(hkStocks(db).find((s) => s.code === '9988')!.marketCapAsOf).toBe('2026-10-28');
    // universe-name fix reaches a stock with no profile name
    syncHkUniverse(db, ENTRIES.map((e) => (e.code === '0285' ? { ...e, name: 'BYD Electronic Intl' } : e)), NOW);
    const other = upsertHkCalendarRow(db, { ...base, code: '0285', reportDate: '2026-11-13', dateStatus: 'estimated' }, NOW);
    expect(getHkReport(db, other)!.name).toBe('BYD Electronic Intl');
  });

  it('final expected move is never replaced', () => {
    const db = setup();
    const id = upsertHkCalendarRow(db, { ...base, reportDate: '2026-11-13', dateStatus: 'estimated' }, NOW);
    const em = { expiry: '2026-11-20', strike: 100, callMid: 5, putMid: 5, underlying: 100, movePct: 10, illiquid: false, adr: 'BABA', quoteDate: '2026-11-12' };
    expect(saveHkExpectedMove(db, id, em, false, NOW)).toBe(true);
    expect(saveHkExpectedMove(db, id, { ...em, movePct: 8 }, true, NOW)).toBe(true);
    expect(saveHkExpectedMove(db, id, { ...em, movePct: 12 }, false, NOW)).toBe(false);
    expect(saveHkExpectedMove(db, id, { ...em, movePct: 12 }, true, NOW)).toBe(false);
    expect(getHkReport(db, id)!.expectedMove).toMatchObject({ movePct: 8, final: true, adr: 'BABA', quoteDate: '2026-11-12' });
  });

  it('syncHkUniverse marks dropped codes inactive and keeps their reports', () => {
    const db = setup();
    const id = upsertHkCalendarRow(db, { ...base, code: '0285', reportDate: '2026-11-13', dateStatus: 'estimated' }, NOW);
    syncHkUniverse(db, [ENTRIES[0]!], NOW);
    expect(hkStocks(db).map((s) => [s.code, s.active])).toEqual([['0285', false], ['9988', true]]);
    expect(getHkReport(db, id)).toBeDefined();
    expect(hkReportsBetween(db, '2026-11-01', '2026-11-30')).toEqual([]);
  });

  it('syncs the real universe with levels; profile and estimates never blank', () => {
    const db = openDb(':memory:');
    syncHkUniverse(db, HK_UNIVERSE, NOW);
    const stocks = hkStocks(db);
    expect(stocks.length).toBe(HK_UNIVERSE.length);
    expect(stocks.find((s) => s.code === '9988')).toMatchObject({ level: 'full', yahooSymbol: '9988.HK', adr: 'BABA' });
    setHkProfile(db, '9988', { name: 'Alibaba Group', sector: 'Tech', industry: null, marketCap: 1e12, asOf: '2026-10-27' }, NOW);
    setHkProfile(db, '9988', { name: null, sector: null, industry: null, marketCap: null, asOf: null }, NOW);
    expect(hkStocks(db).find((s) => s.code === '9988')).toMatchObject({ name: 'Alibaba Group', sector: 'Tech', marketCap: 1e12, marketCapAsOf: '2026-10-27' });
    const id = upsertHkCalendarRow(db, { ...base, reportDate: '2026-11-13', dateStatus: 'estimated' }, NOW);
    setHkEstimates(db, id, { eps: 1.2, epsAnalysts: 7, revenue: 5e10, revenueAnalysts: 6, currency: 'CNY' }, NOW);
    setHkEstimates(db, id, { eps: null, epsAnalysts: null, revenue: null, revenueAnalysts: null, currency: null }, NOW);
    expect(getHkReport(db, id)).toMatchObject({ epsEstimate: 1.2, revenueEstimate: 5e10, estimateCurrency: 'CNY' });
  });

  it('usAdrRows reads the US reports table', () => {
    const db = setup();
    upsertCalendarRow(db, {
      symbol: 'BABA', name: 'Alibaba Group', reportDate: '2026-11-12', fiscalQuarter: 'Sep/2026', timing: 'BMO',
      marketCap: null, epsEstimate: null, noOfEsts: null, epsActual: null, epsSurprisePct: null, lastYearEps: null, lastYearReportDate: null,
    }, NOW, '2026-10-27');
    expect(usAdrRows(db, 'BABA', '2026-11-01', '2026-11-30')).toEqual([{ reportDate: '2026-11-12', timing: 'BMO' }]);
    expect(usAdrRows(db, 'BABA', '2026-12-01', '2026-12-31')).toEqual([]);
  });
});
