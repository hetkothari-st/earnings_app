import { describe, expect, it } from 'vitest';
import { openDb, upsertCalendarRow } from '../../src/db/repo.js';
import { usAdrRows } from '../../src/hk/db/hkRepo.js';
import {
  edinetSeen, getJpReport, JP_ID_BASE, jpPastDates, jpPastDatesCount, jpReportsBetween, jpStocks, lastEdinetSeenAt, listJpRange,
  markEdinetSeen, mergeJpActuals, nearestUnreleasedJp, recordJpRelease, saveJpExpectedMove, setJpEstimates, setJpProfile, setJpTiming, syncJpUniverse,
  upsertJpCalendarRow, upsertJpPastDates,
} from '../../src/jp/db/jpRepo.js';
import type { JpUniverseEntry } from '../../src/jp/universe.js';

const NOW = '2026-10-27T00:00:00.000Z';
const ENTRIES: JpUniverseEntry[] = [
  { code: '7203', edinetCode: 'E02144', name: 'TOYOTA MOTOR CORPORATION', nameJa: 'トヨタ自動車株式会社', fyEndMonth: 3, industryJa: '輸送用機器',
    adr: 'TM', adrRatio: 10, cik: 1094517 },
  { code: '285A', edinetCode: 'E99999', name: 'KIOXIA HOLDINGS CORPORATION', nameJa: 'キオクシアホールディングス株式会社', fyEndMonth: 3,
    industryJa: '電気機器', adr: null, adrRatio: null, cik: null },
];

function setup() {
  const db = openDb(':memory:');
  syncJpUniverse(db, ENTRIES, NOW);
  return db;
}

const base = {
  code: '7203', name: 'TOYOTA MOTOR CORPORATION', period: { periodEnd: '2026-09-30', fiscalQuarter: 2 as const, fyEnd: '2027-03-31' },
  periodLabel: '2Q FY27',
};
const q = (value: number) => ({ value, currency: 'JPY', span: 'quarter' as const, ytdMonths: null });
const eq = (basic: number | null, diluted: number | null = null) => ({ basic, diluted, currency: 'JPY', span: 'quarter' as const, ytdMonths: null });
const em = { expiry: '2026-11-06', strike: 180, callMid: 5, putMid: 5, underlying: 180, movePct: 5.5, illiquid: false, adr: 'TM', quoteDate: '2026-11-04' };

describe('jp repo', () => {
  it('ids start at 3_000_000_001', () => {
    const db = setup();
    const a = upsertJpCalendarRow(db, { ...base, reportDate: '2026-11-05', dateStatus: 'estimated' }, NOW);
    const b = upsertJpCalendarRow(db, { ...base, code: '285A', name: 'KIOXIA', reportDate: '2026-11-12', dateStatus: 'estimated' }, NOW);
    expect(JP_ID_BASE).toBe(3_000_000_001);
    expect(a).toBe(JP_ID_BASE);
    expect(b).toBe(JP_ID_BASE + 1);
    expect(getJpReport(db, a)).toMatchObject({ periodEnd: '2026-09-30', fiscalQuarter: 2, fyEnd: '2027-03-31', periodLabel: '2Q FY27',
      nameJa: 'トヨタ自動車株式会社', industryJa: '輸送用機器', level: 'full', adr: 'TM', adrRatio: 10 });
    expect(jpStocks(db).find((s) => s.code === '285A')).toMatchObject({ level: 'basic', yahooSymbol: '285A.T', edinetCode: 'E99999', active: true });
  });

  it('estimated date never replaces confirmed; confirmed new date is a reschedule', () => {
    const db = setup();
    const id = upsertJpCalendarRow(db, { ...base, reportDate: '2026-11-05', dateStatus: 'estimated' }, NOW);
    upsertJpCalendarRow(db, { ...base, reportDate: '2026-11-05', dateStatus: 'confirmed', timing: 'AMC', timingSource: 'sec-notice' }, NOW);
    expect(getJpReport(db, id)).toMatchObject({ reportDate: '2026-11-05', dateStatus: 'confirmed', timing: 'AMC', timingSource: 'sec-notice', rescheduledFrom: null });
    upsertJpCalendarRow(db, { ...base, reportDate: '2026-11-10', dateStatus: 'estimated' }, NOW);
    expect(getJpReport(db, id)).toMatchObject({ reportDate: '2026-11-05', dateStatus: 'confirmed' });
    saveJpExpectedMove(db, id, em, false, NOW);
    upsertJpCalendarRow(db, { ...base, reportDate: '2026-11-07', dateStatus: 'confirmed' }, NOW);
    const r = getJpReport(db, id)!;
    expect(r).toMatchObject({ reportDate: '2026-11-07', rescheduledFrom: '2026-11-05', timing: 'UNKNOWN', timingSource: null });
    expect(r.expectedMove).toBeNull();
    // Released: the date is fixed, timing no longer set from Yahoo.
    expect(recordJpRelease(db, id, '2026-11-07T06:30:00.000Z', 'AMC')).toBe(true);
    expect(getJpReport(db, id)).toMatchObject({ timing: 'AMC', timingSource: 'sec-6k' });
    expect(recordJpRelease(db, id, '2026-11-07T07:00:00.000Z', null)).toBe(false);
    upsertJpCalendarRow(db, { ...base, reportDate: '2026-11-12', dateStatus: 'confirmed' }, NOW);
    expect(getJpReport(db, id)!.reportDate).toBe('2026-11-07');
    expect(setJpTiming(db, id, 'BMO', 'yahoo')).toBe(false);
  });

  it('precedence: edinet replaces yahoo, never sec; yahoo never replaces edinet; sec replaces both; equal source first wins; null never blanks', () => {
    const db = setup();
    const id = upsertJpCalendarRow(db, { ...base, reportDate: '2026-11-05', dateStatus: 'estimated' }, NOW);
    expect(mergeJpActuals(db, id, { revenue: q(100), eps: eq(50), source: 'yahoo' }, NOW)).toBe(true);
    // Same source never replaces itself.
    expect(mergeJpActuals(db, id, { revenue: q(101), eps: eq(51), source: 'yahoo' }, NOW)).toBe(false);
    expect(getJpReport(db, id)).toMatchObject({ revenueActual: 100, revenueSource: 'yahoo', epsActual: 50, epsSource: 'yahoo' });
    // EDINET replaces Yahoo (a six-month YTD figure).
    const ytd6 = { span: 'ytd' as const, ytdMonths: 6 as const };
    expect(mergeJpActuals(db, id, {
      revenue: { value: 200, currency: 'JPY', ...ytd6 }, eps: { basic: 90, diluted: 89, currency: 'JPY', ...ytd6 }, source: 'edinet', edinetDocId: 'S100ABCD',
    }, NOW)).toBe(true);
    expect(getJpReport(db, id)).toMatchObject({
      revenueActual: 200, revenueSource: 'edinet', revenueSpan: 'ytd', revenueYtdMonths: 6,
      epsActual: 90, epsDilutedActual: 89, epsSource: 'edinet', epsSpan: 'ytd', epsYtdMonths: 6, edinetDocId: 'S100ABCD',
    });
    // A later Yahoo quarter never replaces EDINET.
    expect(mergeJpActuals(db, id, { revenue: q(100), eps: eq(50), source: 'yahoo' }, NOW)).toBe(false);
    expect(mergeJpActuals(db, id, { revenue: { value: 201, currency: 'JPY', ...ytd6 }, eps: null, source: 'edinet', edinetDocId: 'S100ZZZZ' }, NOW)).toBe(false);
    expect(getJpReport(db, id)).toMatchObject({ revenueActual: 200, epsActual: 90, edinetDocId: 'S100ABCD' });
    // SEC replaces both.
    expect(mergeJpActuals(db, id, { revenue: q(300), eps: eq(120, 119), source: 'sec', docUrl: 'https://www.sec.gov/a' }, NOW)).toBe(true);
    expect(getJpReport(db, id)).toMatchObject({
      revenueActual: 300, revenueSource: 'sec', revenueSpan: 'quarter', revenueYtdMonths: null,
      epsActual: 120, epsDilutedActual: 119, epsSource: 'sec', secDocUrl: 'https://www.sec.gov/a',
    });
    // EDINET never replaces SEC; a second SEC filing never replaces the first.
    expect(mergeJpActuals(db, id, { revenue: { value: 9, currency: 'JPY', ...ytd6 }, eps: { basic: 9, diluted: 9, currency: 'JPY', ...ytd6 }, source: 'edinet' }, NOW)).toBe(false);
    expect(mergeJpActuals(db, id, { revenue: q(301), eps: eq(121), source: 'sec', docUrl: 'https://www.sec.gov/b' }, NOW)).toBe(false);
    expect(getJpReport(db, id)).toMatchObject({ revenueActual: 300, epsActual: 120, secDocUrl: 'https://www.sec.gov/a' });
    // A null never blanks.
    expect(mergeJpActuals(db, id, { revenue: null, eps: null, source: 'sec' }, NOW)).toBe(false);
    expect(mergeJpActuals(db, id, { revenue: null, eps: eq(null, null), source: 'sec' }, NOW)).toBe(false);
    expect(getJpReport(db, id)).toMatchObject({ revenueActual: 300, epsActual: 120, epsDilutedActual: 119 });
  });

  it('an EPS group with only diluted is stored only when nothing is stored', () => {
    const db = setup();
    const id = upsertJpCalendarRow(db, { ...base, reportDate: '2026-11-05', dateStatus: 'estimated' }, NOW);
    expect(mergeJpActuals(db, id, { eps: eq(50), source: 'yahoo' }, NOW)).toBe(true);
    expect(mergeJpActuals(db, id, { eps: eq(null, 49), source: 'sec' }, NOW)).toBe(false);
    expect(getJpReport(db, id)).toMatchObject({ epsActual: 50, epsDilutedActual: null, epsSource: 'yahoo' });
    const other = upsertJpCalendarRow(db, { ...base, code: '285A', name: 'KIOXIA', reportDate: '2026-11-12', dateStatus: 'estimated' }, NOW);
    expect(mergeJpActuals(db, other, { eps: eq(null, 49), source: 'edinet' }, NOW)).toBe(true);
    expect(getJpReport(db, other)).toMatchObject({ epsActual: null, epsDilutedActual: 49, epsSource: 'edinet' });
    // The row counts as having EPS for the jobs.
    expect(jpReportsBetween(db, '2026-11-12', '2026-11-12')[0]).toMatchObject({ id: other, hasEps: true, hasRevenue: false, fiscalQuarter: 2 });
  });

  it('a diluted-only row counts as released: no Yahoo timing, no date move, not "nearest unreleased"', () => {
    const db = setup();
    const id = upsertJpCalendarRow(db, { ...base, reportDate: '2026-11-05', dateStatus: 'estimated' }, NOW);
    expect(mergeJpActuals(db, id, { eps: eq(null, 49), source: 'edinet' }, NOW)).toBe(true);
    expect(setJpTiming(db, id, 'AMC', 'yahoo')).toBe(false);
    upsertJpCalendarRow(db, { ...base, reportDate: '2026-11-12', dateStatus: 'confirmed', timing: 'BMO', timingSource: 'sec-notice' }, NOW);
    expect(getJpReport(db, id)).toMatchObject({ reportDate: '2026-11-05', dateStatus: 'estimated', timing: 'UNKNOWN', rescheduledFrom: null });
    expect(nearestUnreleasedJp(db, '7203', '2026-11-05')).toBeNull();
  });

  it('an incoming basic fills a diluted-only group; a lower source keeps the stored diluted; never across spans', () => {
    const db = setup();
    // Same source fills the missing basic.
    const a = upsertJpCalendarRow(db, { ...base, reportDate: '2026-11-05', dateStatus: 'estimated' }, NOW);
    expect(mergeJpActuals(db, a, { eps: eq(null, 49), source: 'sec' }, NOW)).toBe(true);
    expect(mergeJpActuals(db, a, { eps: eq(50, 48), source: 'sec' }, NOW)).toBe(true);
    expect(getJpReport(db, a)).toMatchObject({ epsActual: 50, epsDilutedActual: 49, epsSource: 'sec', epsSpan: 'quarter' });
    // A lower source fills the basic only; the stored (higher) diluted stays.
    const b = upsertJpCalendarRow(db, { ...base, code: '285A', name: 'KIOXIA', reportDate: '2026-11-12', dateStatus: 'estimated' }, NOW);
    expect(mergeJpActuals(db, b, { eps: eq(null, 49), source: 'sec' }, NOW)).toBe(true);
    expect(mergeJpActuals(db, b, { eps: eq(51, 47), source: 'yahoo' }, NOW)).toBe(true);
    expect(getJpReport(db, b)).toMatchObject({ epsActual: 51, epsDilutedActual: 49, epsSpan: 'quarter' });
    // Once the basic is stored, the same lower source never touches the group again.
    expect(mergeJpActuals(db, b, { eps: eq(52, 46), source: 'yahoo' }, NOW)).toBe(false);
    expect(getJpReport(db, b)).toMatchObject({ epsActual: 51, epsDilutedActual: 49 });
    // A lower-source basic of another span (or currency) never joins a stored diluted.
    const db2 = setup();
    const c = upsertJpCalendarRow(db2, { ...base, reportDate: '2026-11-05', dateStatus: 'estimated' }, NOW);
    expect(mergeJpActuals(db2, c, { eps: { basic: null, diluted: 89, currency: 'JPY', span: 'ytd', ytdMonths: 6 }, source: 'edinet' }, NOW)).toBe(true);
    expect(mergeJpActuals(db2, c, { eps: eq(50), source: 'yahoo' }, NOW)).toBe(false);
    expect(mergeJpActuals(db2, c, { eps: { basic: 90, diluted: null, currency: 'USD', span: 'ytd', ytdMonths: 6 }, source: 'yahoo' }, NOW)).toBe(false);
    expect(getJpReport(db2, c)).toMatchObject({ epsActual: null, epsDilutedActual: 89, epsSource: 'edinet', epsSpan: 'ytd', epsYtdMonths: 6 });
  });

  it('revenue and EPS groups keep their own source and span', () => {
    const db = setup();
    const id = upsertJpCalendarRow(db, { ...base, reportDate: '2026-11-05', dateStatus: 'estimated' }, NOW);
    expect(mergeJpActuals(db, id, { eps: eq(120, 119), revenue: null, source: 'sec', docUrl: 'https://www.sec.gov/a' }, NOW)).toBe(true);
    expect(mergeJpActuals(db, id, {
      revenue: { value: 24_000_000_000_000, currency: 'JPY', span: 'ytd', ytdMonths: 6 },
      eps: { basic: 200, diluted: 199, currency: 'JPY', span: 'ytd', ytdMonths: 6 }, source: 'edinet', edinetDocId: 'S100ABCD',
    }, NOW)).toBe(true);
    expect(getJpReport(db, id)).toMatchObject({
      revenueActual: 24_000_000_000_000, revenueCurrency: 'JPY', revenueSource: 'edinet', revenueSpan: 'ytd', revenueYtdMonths: 6,
      epsActual: 120, epsDilutedActual: 119, epsCurrency: 'JPY', epsSource: 'sec', epsSpan: 'quarter', epsYtdMonths: null,
      secDocUrl: 'https://www.sec.gov/a', edinetDocId: 'S100ABCD',
    });
  });

  it('estimates: COALESCE within a span; a different span replaces all four values', () => {
    const db = setup();
    const id = upsertJpCalendarRow(db, { ...base, reportDate: '2026-11-05', dateStatus: 'estimated' }, NOW);
    setJpEstimates(db, id, { eps: 60, epsAnalysts: 10, revenue: 1e13, revenueAnalysts: 9, currency: 'JPY', span: 'quarter' }, NOW);
    setJpEstimates(db, id, { eps: null, epsAnalysts: null, revenue: 1.1e13, revenueAnalysts: 8, currency: 'JPY', span: 'quarter' }, NOW);
    expect(getJpReport(db, id)).toMatchObject({ epsEstimate: 60, epsAnalysts: 10, revenueEstimate: 1.1e13, revenueAnalysts: 8, estimateSpan: 'quarter' });
    setJpEstimates(db, id, { eps: 250, epsAnalysts: 15, revenue: null, revenueAnalysts: null, currency: 'JPY', span: 'year' }, NOW);
    expect(getJpReport(db, id)).toMatchObject({ epsEstimate: 250, epsAnalysts: 15, revenueEstimate: null, revenueAnalysts: null, estimateSpan: 'year', estimateCurrency: 'JPY' });
  });

  it('estimates without a currency are skipped (uncertain means blank); stored values stay', () => {
    const db = setup();
    const id = upsertJpCalendarRow(db, { ...base, reportDate: '2026-11-05', dateStatus: 'estimated' }, NOW);
    setJpEstimates(db, id, { eps: 60, epsAnalysts: 10, revenue: 1e13, revenueAnalysts: 9, currency: 'JPY', span: 'quarter' }, NOW);
    setJpEstimates(db, id, { eps: 0.5, epsAnalysts: 3, revenue: 7e10, revenueAnalysts: 2, currency: null, span: 'year' }, NOW);
    expect(getJpReport(db, id)).toMatchObject({ epsEstimate: 60, epsAnalysts: 10, revenueEstimate: 1e13, revenueAnalysts: 9, estimateCurrency: 'JPY', estimateSpan: 'quarter' });
    const other = upsertJpCalendarRow(db, { ...base, code: '285A', name: 'KIOXIA', reportDate: '2026-11-12', dateStatus: 'estimated' }, NOW);
    setJpEstimates(db, other, { eps: 0.5, epsAnalysts: 3, revenue: null, revenueAnalysts: null, currency: null, span: 'quarter' }, NOW);
    expect(getJpReport(db, other)).toMatchObject({ epsEstimate: null, epsAnalysts: null, estimateCurrency: null, estimateSpan: null });
  });

  it('search matches code, English name and Japanese name; profile never blanks', () => {
    const db = setup();
    const id = upsertJpCalendarRow(db, { ...base, reportDate: '2026-11-05', dateStatus: 'estimated' }, NOW);
    setJpProfile(db, '7203', { name: 'Toyota Motor Corporation', sector: 'Consumer Cyclical', industry: 'Auto Manufacturers', marketCap: 4e13, asOf: '2026-10-27' }, NOW);
    setJpProfile(db, '7203', { name: null, sector: null, industry: null, marketCap: null, asOf: null }, NOW);
    expect(jpStocks(db).find((s) => s.code === '7203')).toMatchObject({ name: 'Toyota Motor Corporation', sector: 'Consumer Cyclical', marketCap: 4e13, marketCapAsOf: '2026-10-27' });
    const find = (term: string) => listJpRange(db, { from: '2026-11-01', to: '2026-11-30', q: term }).map((r) => r.id);
    expect(find('7203')).toEqual([id]);
    expect(find('TOYOTA')).toEqual([id]);
    expect(find('Motor Corp')).toEqual([id]);
    expect(find('トヨタ')).toEqual([id]);
    expect(find('ソニー')).toEqual([]);
  });

  it('final expected move never replaced', () => {
    const db = setup();
    const id = upsertJpCalendarRow(db, { ...base, reportDate: '2026-11-05', dateStatus: 'estimated' }, NOW);
    expect(saveJpExpectedMove(db, id, em, false, NOW)).toBe(true);
    expect(saveJpExpectedMove(db, id, { ...em, movePct: 4 }, true, NOW)).toBe(true);
    expect(saveJpExpectedMove(db, id, { ...em, movePct: 6 }, false, NOW)).toBe(false);
    expect(saveJpExpectedMove(db, id, { ...em, movePct: 6 }, true, NOW)).toBe(false);
    expect(getJpReport(db, id)!.expectedMove).toMatchObject({ movePct: 4, final: true, adr: 'TM', quoteDate: '2026-11-04' });
  });

  it('past dates upsert is idempotent', () => {
    const db = setup();
    const rows = [
      { code: '7203', date: '2026-08-07', timing: 'DMH' as const },
      { code: '7203', date: '2026-05-08', timing: null },
    ];
    expect(jpPastDatesCount(db)).toBe(0);
    upsertJpPastDates(db, rows);
    upsertJpPastDates(db, rows);
    expect(jpPastDatesCount(db)).toBe(2);
    // A later timing fills an unknown one; a null never blanks.
    upsertJpPastDates(db, [{ code: '7203', date: '2026-05-08', timing: 'AMC' }, { code: '7203', date: '2026-08-07', timing: null }]);
    expect(jpPastDates(db, '7203')).toEqual([{ date: '2026-08-07', timing: 'DMH' }, { date: '2026-05-08', timing: 'AMC' }]);
  });

  it('edinet seen bookkeeping', () => {
    const db = setup();
    expect(edinetSeen(db, 'S100ABCD')).toBe(false);
    expect(lastEdinetSeenAt(db)).toBeNull();
    markEdinetSeen(db, 'S100ABCD', '7203', '160', '2026-09-30', 'merged', NOW);
    markEdinetSeen(db, 'S100ABCD', '7203', '160', '2026-09-30', 'error', '2026-10-28T00:00:00.000Z');
    expect(edinetSeen(db, 'S100ABCD')).toBe(true);
    expect(lastEdinetSeenAt(db)).toBe(NOW);
  });

  it('usAdrRows still importable from hkRepo', () => {
    const db = setup();
    upsertCalendarRow(db, {
      symbol: 'TM', name: 'Toyota Motor', reportDate: '2026-11-05', fiscalQuarter: 'Sep/2026', timing: 'BMO',
      marketCap: null, epsEstimate: null, noOfEsts: null, epsActual: null, epsSurprisePct: null, lastYearEps: null, lastYearReportDate: null,
    }, NOW, '2026-10-27');
    expect(usAdrRows(db, 'TM', '2026-11-01', '2026-11-30')).toEqual([{ reportDate: '2026-11-05', timing: 'BMO' }]);
  });
});
