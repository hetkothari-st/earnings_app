import { describe, expect, it, vi } from 'vitest';
import { openDb, upsertCalendarRow } from '../../src/db/repo.js';
import { getHkReport, hkStocks, mergeHkActuals, syncHkUniverse, upsertHkCalendarRow } from '../../src/hk/db/hkRepo.js';
import { refreshHkCalendar } from '../../src/hk/jobs/calendar.js';
import type { HkJobContext } from '../../src/hk/jobs/context.js';
import { refreshHkEstimates } from '../../src/hk/jobs/estimates.js';
import { computeHkPrevMoves } from '../../src/hk/jobs/prevMoves.js';
import { refreshHkYahooResults } from '../../src/hk/jobs/results.js';
import { checkHkHolidayCoverage, refreshHkStocks } from '../../src/hk/jobs/stocks.js';
import type { HkUniverseEntry } from '../../src/hk/universe.js';
import type { YahooHkSummary } from '../../src/hk/sources/yahooHk.js';

const NOW = '2026-10-27T04:00:00.000Z';
const TODAY = '2026-10-27';
const ENTRIES: HkUniverseEntry[] = [
  { code: '9988', name: 'Alibaba', cadence: 'Q', fyEndMonth: 3, adr: 'BABA', adrRatio: 8, cik: 1577552 },
  { code: '0285', name: 'BYD Electronic', cadence: 'H', fyEndMonth: 12, adr: null, adrRatio: null, cik: null },
  { code: '0700', name: 'Tencent', cadence: 'Q', fyEndMonth: 12, adr: null, adrRatio: null, cik: null },
];

const summary = (over: Partial<YahooHkSummary> = {}): YahooHkSummary => ({
  name: null, priceCurrency: 'HKD', sector: null, industry: null, marketCap: null, marketCapAsOf: null, nextDate: null,
  trend: [], epsHistory: [], revenueQuarters: [], financialCurrency: null, ...over,
});

function setup(opts: {
  today?: string; summaries?: Record<string, YahooHkSummary | null>;
  pastDates?: Record<string, { date: string; timing: 'BMO' | 'AMC' | 'DMH' | null }[] | Error>;
  closes?: Map<string, number> | Error;
} = {}) {
  const db = openDb(':memory:');
  syncHkUniverse(db, ENTRIES, NOW);
  const closeCalls: [string, string, string][] = [];
  const ctx: HkJobContext = {
    db, now: () => NOW, todayHKT: () => opts.today ?? TODAY,
    yahoo: async (s) => opts.summaries?.[s] ?? null,
    yahooPastDates: async (s) => {
      const r = opts.pastDates?.[s] ?? [];
      if (r instanceof Error) throw r;
      return r;
    },
    yahooCloses: async (s, from, to) => {
      closeCalls.push([s, from, to]);
      if (opts.closes instanceof Error) throw opts.closes;
      return opts.closes ?? new Map();
    },
    optionChain: async () => null, secHttp: null,
  };
  return { db, ctx, closeCalls };
}

const rows = (db: ReturnType<typeof openDb>, code: string) =>
  db.prepare('SELECT * FROM hk_reports WHERE code = ? ORDER BY report_date').all(code) as unknown as
    { id: number; report_date: string; date_status: string; period_end: string; period_kind: string; period_label: string; timing: string }[];

const usRow = (db: ReturnType<typeof openDb>, reportDate: string, timing: 'BMO' | 'AMC') =>
  upsertCalendarRow(db, {
    symbol: 'BABA', name: 'Alibaba Group', reportDate, fiscalQuarter: 'Sep/2026', timing, marketCap: null, epsEstimate: null,
    noOfEsts: null, epsActual: null, epsSurprisePct: null, lastYearEps: null, lastYearReportDate: null,
  }, NOW, TODAY);

describe('refreshHkStocks', () => {
  it('syncs the universe, applies the Yahoo profile and flags missing holidays', async () => {
    const { ctx, db } = setup({ today: '2027-12-01', summaries: { '0700.HK': summary({ name: 'Tencent Holdings Limited', sector: 'Communication Services' }) } });
    await refreshHkStocks(ctx);
    const tencent = hkStocks(db).find((s) => s.code === '0700');
    expect(tencent).toMatchObject({ name: 'Tencent Holdings Limited', sector: 'Communication Services' });
    expect(hkStocks(db).length).toBeGreaterThan(90);
    const err = db.prepare("SELECT last_error FROM source_status WHERE source = 'hk-holidays'").get() as { last_error: string | null } | undefined;
    expect(err?.last_error).toMatch(/2028/);
  });

  it('no holiday warning while the list covers 60 days ahead', () => {
    const { ctx, db } = setup();
    checkHkHolidayCoverage(ctx);
    const row = db.prepare("SELECT last_error FROM source_status WHERE source = 'hk-holidays'").get() as { last_error: string | null } | undefined;
    expect(row?.last_error ?? null).toBeNull();
  });
});

describe('refreshHkCalendar', () => {
  it('stale Yahoo date in the past creates no row', async () => {
    const { ctx, db } = setup({ summaries: { '0700.HK': summary({ nextDate: '2026-10-01' }) } });
    await refreshHkCalendar(ctx);
    expect(rows(db, '0700')).toEqual([]);
  });

  it('a future basic-level Yahoo date creates an estimated row with period and label', async () => {
    const { ctx, db } = setup({ summaries: { '0700.HK': summary({ nextDate: '2026-11-12' }) } });
    await refreshHkCalendar(ctx);
    expect(rows(db, '0700')).toMatchObject([{ report_date: '2026-11-12', date_status: 'estimated', period_end: '2026-09-30', period_label: 'Q3 26' }]);
  });

  it('Yahoo date never moves a confirmed date', async () => {
    const { ctx, db } = setup({ summaries: { '0700.HK': summary({ nextDate: '2026-11-27' }) } });
    const id = upsertHkCalendarRow(db, { code: '0700', name: 'Tencent', periodEnd: '2026-09-30', periodKind: 'Q', periodLabel: 'Q3 26',
      reportDate: '2026-11-20', dateStatus: 'confirmed' }, NOW);
    await refreshHkCalendar(ctx);
    expect(getHkReport(db, id)).toMatchObject({ reportDate: '2026-11-20', dateStatus: 'confirmed' });
    expect(rows(db, '0700')).toHaveLength(1);
  });

  it('full level: US AMC 11-19 + Yahoo 11-20 -> HK row 2026-11-20 estimated', async () => {
    const { ctx, db } = setup({ summaries: { '9988.HK': summary({ nextDate: '2026-11-20' }) } });
    usRow(db, '2026-11-19', 'AMC');
    await refreshHkCalendar(ctx);
    expect(rows(db, '9988')).toMatchObject([{ report_date: '2026-11-20', date_status: 'estimated', period_end: '2026-09-30' }]);
  });

  it('full level: the US date alone is used when Yahoo has none', async () => {
    const { ctx, db } = setup();
    usRow(db, '2026-11-19', 'BMO');
    await refreshHkCalendar(ctx);
    expect(rows(db, '9988')).toMatchObject([{ report_date: '2026-11-19' }]);
  });

  it('full level: US and Yahoo disagree -> nothing written', async () => {
    const { ctx, db } = setup({ summaries: { '9988.HK': summary({ nextDate: '2026-11-27' }) } });
    usRow(db, '2026-11-19', 'AMC');
    await refreshHkCalendar(ctx);
    expect(rows(db, '9988')).toEqual([]);
  });

  it('half-yearly basic name gets period 1H26 for an August date', async () => {
    const { ctx, db } = setup({ today: '2026-07-27', summaries: { '0285.HK': summary({ nextDate: '2026-08-20' }) } });
    await refreshHkCalendar(ctx);
    expect(rows(db, '0285')).toMatchObject([{ report_date: '2026-08-20', period_end: '2026-06-30', period_kind: 'H', period_label: '1H26' }]);
  });
});

describe('refreshHkEstimates', () => {
  const trend = (periodEnd: string, over = {}) => ({
    period: '0q', periodEnd, eps: 1.2, epsAnalysts: 10, epsCurrency: 'HKD', revenue: 5e10, revenueAnalysts: 8, revenueCurrency: 'HKD', ...over,
  });

  it('estimates only for the matching period end, with currency', async () => {
    const { ctx, db } = setup({ summaries: { '0700.HK': summary({ trend: [trend('2026-12-31'), trend('2026-09-30')] }) } });
    const id = upsertHkCalendarRow(db, { code: '0700', name: 'Tencent', periodEnd: '2026-09-30', periodKind: 'Q', periodLabel: 'Q3 26',
      reportDate: '2026-11-12', dateStatus: 'estimated' }, NOW);
    const other = upsertHkCalendarRow(db, { code: '0700', name: 'Tencent', periodEnd: '2026-06-30', periodKind: 'Q', periodLabel: 'Q2 26',
      reportDate: '2026-11-13', dateStatus: 'estimated' }, NOW);
    await refreshHkEstimates(ctx);
    expect(getHkReport(db, id)).toMatchObject({ epsEstimate: 1.2, epsAnalysts: 10, revenueEstimate: 5e10, estimateCurrency: 'HKD' });
    expect(getHkReport(db, other)).toMatchObject({ epsEstimate: null, estimateCurrency: null });
  });

  it('a revenue estimate in another currency is stored as null', async () => {
    const { ctx, db } = setup({ summaries: { '0700.HK': summary({ trend: [trend('2026-09-30', { revenueCurrency: 'CNY' })] }) } });
    const id = upsertHkCalendarRow(db, { code: '0700', name: 'Tencent', periodEnd: '2026-09-30', periodKind: 'Q', periodLabel: 'Q3 26',
      reportDate: '2026-11-12', dateStatus: 'estimated' }, NOW);
    await refreshHkEstimates(ctx);
    expect(getHkReport(db, id)).toMatchObject({ epsEstimate: 1.2, revenueEstimate: null, revenueAnalysts: null, estimateCurrency: 'HKD' });
  });

  it('without an EPS estimate the currency is the revenue currency', async () => {
    const { ctx, db } = setup({ summaries: { '0700.HK': summary({ trend: [trend('2026-09-30', { eps: null, epsCurrency: null, revenueCurrency: 'CNY' })] }) } });
    const id = upsertHkCalendarRow(db, { code: '0700', name: 'Tencent', periodEnd: '2026-09-30', periodKind: 'Q', periodLabel: 'Q3 26',
      reportDate: '2026-11-12', dateStatus: 'estimated' }, NOW);
    await refreshHkEstimates(ctx);
    expect(getHkReport(db, id)).toMatchObject({ epsEstimate: null, revenueEstimate: 5e10, estimateCurrency: 'CNY' });
  });

  it('an EPS estimate with no currency is skipped; the revenue (with its currency) is still stored', async () => {
    const { ctx, db } = setup({ summaries: { '0700.HK': summary({ trend: [trend('2026-09-30', { epsCurrency: null, revenueCurrency: 'CNY' })] }) } });
    const id = upsertHkCalendarRow(db, { code: '0700', name: 'Tencent', periodEnd: '2026-09-30', periodKind: 'Q', periodLabel: 'Q3 26',
      reportDate: '2026-11-12', dateStatus: 'estimated' }, NOW);
    await refreshHkEstimates(ctx);
    expect(getHkReport(db, id)).toMatchObject({ epsEstimate: null, epsAnalysts: null, revenueEstimate: 5e10, estimateCurrency: 'CNY' });
  });
});

describe('refreshHkYahooResults', () => {
  it('basic quarterly only, labelled yahoo; full-level rows untouched', async () => {
    const y = summary({
      epsHistory: [{ periodEnd: '2026-09-30', actual: 4.5, currency: 'CNY' }], revenueQuarters: [{ label: '3Q2026', revenue: 1.9e11 }],
      financialCurrency: 'CNY',
    });
    const { ctx, db } = setup({ summaries: { '0700.HK': y, '9988.HK': y, '0285.HK': y } });
    const mk = (code: string, kind: 'Q' | 'H', end: string) => upsertHkCalendarRow(db, { code, name: code, periodEnd: end, periodKind: kind,
      periodLabel: 'x', reportDate: '2026-10-20', dateStatus: 'confirmed' }, NOW);
    const basicQ = mk('0700', 'Q', '2026-09-30');
    const fullQ = mk('9988', 'Q', '2026-09-30');
    const basicH = mk('0285', 'H', '2026-09-30');
    expect(await refreshHkYahooResults(ctx)).toEqual([basicQ]);
    expect(getHkReport(db, basicQ)).toMatchObject({ epsActual: 4.5, epsCurrency: 'CNY', epsBasis: 'share', revenueActual: 1.9e11, revenueCurrency: 'CNY', actualSource: 'yahoo' });
    expect(getHkReport(db, fullQ)).toMatchObject({ epsActual: null, revenueActual: null, actualSource: null });
    expect(getHkReport(db, basicH)).toMatchObject({ epsActual: null });
    expect(await refreshHkYahooResults(ctx)).toEqual([]);
  });

  it('never replaces SEC actuals and skips rows that already have actuals', async () => {
    const y = summary({ epsHistory: [{ periodEnd: '2026-09-30', actual: 9, currency: 'HKD' }] });
    const { ctx, db } = setup({ summaries: { '0700.HK': y } });
    const id = upsertHkCalendarRow(db, { code: '0700', name: 'Tencent', periodEnd: '2026-09-30', periodKind: 'Q', periodLabel: 'Q3 26',
      reportDate: '2026-10-20', dateStatus: 'confirmed' }, NOW);
    mergeHkActuals(db, id, { eps: 4, epsCurrency: 'HKD', epsBasis: 'share', revenue: null, revenueCurrency: null, source: 'sec' }, NOW);
    expect(await refreshHkYahooResults(ctx)).toEqual([]);
    expect(getHkReport(db, id)).toMatchObject({ epsActual: 4, actualSource: 'sec' });
  });

  it('an EPS with no currency, or revenue with no financial currency, is dropped', async () => {
    const y = summary({
      epsHistory: [{ periodEnd: '2026-09-30', actual: 4.5, currency: null }], revenueQuarters: [{ label: '3Q2026', revenue: 1.9e11 }],
      financialCurrency: null,
    });
    const { ctx, db } = setup({ summaries: { '0700.HK': y } });
    const id = upsertHkCalendarRow(db, { code: '0700', name: 'Tencent', periodEnd: '2026-09-30', periodKind: 'Q', periodLabel: 'Q3 26',
      reportDate: '2026-10-20', dateStatus: 'confirmed' }, NOW);
    expect(await refreshHkYahooResults(ctx)).toEqual([]);
    expect(getHkReport(db, id)).toMatchObject({ epsActual: null, revenueActual: null, actualSource: null });
  });

  it('revenue is backfilled for a basic quarterly row that already has EPS; the stored EPS is kept', async () => {
    const mkSetup = (y: YahooHkSummary) => setup({ summaries: { '0700.HK': y } });
    const first = mkSetup(summary({ epsHistory: [{ periodEnd: '2026-09-30', actual: 4.5, currency: 'CNY' }] }));
    const id = upsertHkCalendarRow(first.db, { code: '0700', name: 'Tencent', periodEnd: '2026-09-30', periodKind: 'Q', periodLabel: 'Q3 26',
      reportDate: '2026-10-20', dateStatus: 'confirmed' }, NOW);
    expect(await refreshHkYahooResults(first.ctx)).toEqual([id]);
    first.ctx.yahoo = async () => summary({
      epsHistory: [{ periodEnd: '2026-09-30', actual: 9, currency: 'CNY' }], revenueQuarters: [{ label: '3Q2026', revenue: 1.9e11 }], financialCurrency: 'CNY',
    });
    expect(await refreshHkYahooResults(first.ctx)).toEqual([id]);
    expect(getHkReport(first.db, id)).toMatchObject({ epsActual: 4.5, revenueActual: 1.9e11, revenueCurrency: 'CNY', actualSource: 'yahoo' });
    expect(await refreshHkYahooResults(first.ctx)).toEqual([]); // complete: not touched again
  });
});

describe('computeHkPrevMoves', () => {
  const report = (db: ReturnType<typeof openDb>) => upsertHkCalendarRow(db, { code: '0700', name: 'Tencent', periodEnd: '2026-09-30',
    periodKind: 'Q', periodLabel: 'Q3 26', reportDate: '2026-11-12', dateStatus: 'estimated' }, NOW);

  it('unknown prior timing -> next-day window, basis assumed', async () => {
    const { ctx, db, closeCalls } = setup({
      pastDates: { '0700.HK': [{ date: '2026-08-13', timing: null }] },
      closes: new Map([['2026-08-13', 500], ['2026-08-14', 520]]),
    });
    const id = report(db);
    await computeHkPrevMoves(ctx);
    expect(getHkReport(db, id)).toMatchObject({ prevMovePct: 4, prevMoveDate: '2026-08-13', prevMoveBasis: 'assumed' });
    expect(closeCalls).toEqual([['0700.HK', '2026-08-08', '2026-08-15']]);
  });

  it('full level: the prior date is the ADR US report as an HK date; US timing gives HK timing (basis known)', async () => {
    // US BMO 2026-08-20 (21:30 HKT onward): HK date 08-20, after the HK close -> AMC window 08-20 -> 08-21.
    const bmo = setup({ closes: new Map([['2026-08-20', 100], ['2026-08-21', 105]]) });
    usRow(bmo.db, '2026-08-20', 'BMO');
    const a = upsertHkCalendarRow(bmo.db, { code: '9988', name: 'Alibaba', periodEnd: '2026-09-30', periodKind: 'Q', periodLabel: 'Q3 26',
      reportDate: '2026-11-13', dateStatus: 'estimated' }, NOW);
    await computeHkPrevMoves(bmo.ctx);
    expect(getHkReport(bmo.db, a)).toMatchObject({ prevMovePct: 5, prevMoveDate: '2026-08-20', prevMoveBasis: 'known' });
    expect(bmo.closeCalls[0]?.[0]).toBe('9988.HK');

    // US AMC 2026-08-20: HK date 08-21, before the HK open -> BMO window 08-20 -> 08-21.
    const amc = setup({ closes: new Map([['2026-08-20', 100], ['2026-08-21', 90]]) });
    usRow(amc.db, '2026-08-20', 'AMC');
    const b = upsertHkCalendarRow(amc.db, { code: '9988', name: 'Alibaba', periodEnd: '2026-09-30', periodKind: 'Q', periodLabel: 'Q3 26',
      reportDate: '2026-11-13', dateStatus: 'estimated' }, NOW);
    await computeHkPrevMoves(amc.ctx);
    expect(getHkReport(amc.db, b)).toMatchObject({ prevMovePct: -10, prevMoveDate: '2026-08-21', prevMoveBasis: 'known' });
  });

  it('full level: a US row with unknown timing gives basis assumed (after the HK close)', async () => {
    const { ctx, db } = setup({ closes: new Map([['2026-08-20', 100], ['2026-08-21', 102]]) });
    usRow(db, '2026-08-20', 'BMO');
    db.prepare("UPDATE reports SET timing = 'UNKNOWN'").run();
    const id = upsertHkCalendarRow(db, { code: '9988', name: 'Alibaba', periodEnd: '2026-09-30', periodKind: 'Q', periodLabel: 'Q3 26',
      reportDate: '2026-11-13', dateStatus: 'estimated' }, NOW);
    await computeHkPrevMoves(ctx);
    expect(getHkReport(db, id)).toMatchObject({ prevMovePct: 2, prevMoveDate: '2026-08-20', prevMoveBasis: 'assumed' });
  });

  it('known prior timing -> basis known', async () => {
    const { ctx, db } = setup({
      pastDates: { '0700.HK': [{ date: '2026-08-13', timing: 'BMO' }] },
      closes: new Map([['2026-08-12', 400], ['2026-08-13', 440]]),
    });
    const id = report(db);
    await computeHkPrevMoves(ctx);
    expect(getHkReport(db, id)).toMatchObject({ prevMovePct: 10, prevMoveBasis: 'known' });
  });

  it('a released prior report of this app comes before Yahoo', async () => {
    const { ctx, db } = setup({ closes: new Map([['2026-08-13', 500], ['2026-08-14', 510]]) });
    const prior = upsertHkCalendarRow(db, { code: '0700', name: 'Tencent', periodEnd: '2026-06-30', periodKind: 'Q', periodLabel: 'Q2 26',
      reportDate: '2026-08-13', dateStatus: 'confirmed' }, NOW);
    db.prepare("UPDATE hk_reports SET timing = 'AMC', released_at = '2026-08-13T09:00:00.000Z' WHERE id = ?").run(prior);
    const id = report(db);
    await computeHkPrevMoves(ctx);
    expect(getHkReport(db, id)).toMatchObject({ prevMovePct: 2, prevMoveBasis: 'known' });
  });

  it('Yahoo past dates outside the Ruling 15 window are ignored', async () => {
    // Quarterly: 30 days and 200 days back are both outside 45-140.
    const { ctx, db, closeCalls } = setup({ pastDates: { '0700.HK': [{ date: '2026-10-13', timing: 'AMC' }, { date: '2026-04-26', timing: 'AMC' }] } });
    const id = report(db);
    await computeHkPrevMoves(ctx);
    expect(closeCalls).toEqual([]);
    expect(getHkReport(db, id)).toMatchObject({ prevMovePct: null });
    expect(getHkReport(db, id)?.prevMoveCheckedAt).toBe(NOW);
  });

  it('half-year names use the 150-220 day window', async () => {
    const { ctx, db } = setup({
      today: '2026-08-10', pastDates: { '0285.HK': [{ date: '2026-02-20', timing: 'AMC' }] },
      closes: new Map([['2026-02-20', 100], ['2026-02-23', 103]]),
    });
    const id = upsertHkCalendarRow(db, { code: '0285', name: 'BYD Electronic', periodEnd: '2026-06-30', periodKind: 'H', periodLabel: '1H26',
      reportDate: '2026-08-20', dateStatus: 'estimated' }, NOW); // 181 days after 02-20
    await computeHkPrevMoves(ctx);
    expect(getHkReport(db, id)).toMatchObject({ prevMovePct: 3, prevMoveDate: '2026-02-20', prevMoveBasis: 'known' });
  });

  it('fetch failure leaves the row unchecked', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const closesFail = setup({ pastDates: { '0700.HK': [{ date: '2026-08-13', timing: 'AMC' }] }, closes: new Error('429') });
    const a = report(closesFail.db);
    await computeHkPrevMoves(closesFail.ctx);
    expect(getHkReport(closesFail.db, a)).toMatchObject({ prevMovePct: null, prevMoveCheckedAt: null });

    const datesFail = setup({ pastDates: { '0700.HK': new Error('429') } });
    const b = report(datesFail.db);
    await computeHkPrevMoves(datesFail.ctx);
    expect(getHkReport(datesFail.db, b)).toMatchObject({ prevMovePct: null, prevMoveCheckedAt: null });
  });

  it('a miss never blanks an earlier move and is not retried within 20 hours', async () => {
    const { ctx, db, closeCalls } = setup({ pastDates: { '0700.HK': [{ date: '2026-08-13', timing: 'AMC' }] }, closes: new Map() });
    const id = report(db);
    await computeHkPrevMoves(ctx);
    expect(getHkReport(db, id)).toMatchObject({ prevMovePct: null, prevMoveCheckedAt: NOW });
    await computeHkPrevMoves(ctx);
    expect(closeCalls).toHaveLength(1);
  });

  it('a Yahoo TAS row on the report date sets timing; an UNKNOWN-only answer leaves "Time not announced"', async () => {
    const withTas = setup({ pastDates: { '0700.HK': [{ date: '2026-11-12', timing: 'BMO' }] } });
    const a = report(withTas.db);
    await computeHkPrevMoves(withTas.ctx);
    expect(getHkReport(withTas.db, a)).toMatchObject({ timing: 'BMO', timingSource: 'yahoo' });

    const without = setup({ pastDates: { '0700.HK': [{ date: '2026-11-12', timing: null }, { date: '2026-11-13', timing: 'AMC' }] } });
    const b = report(without.db);
    await computeHkPrevMoves(without.ctx);
    expect(getHkReport(without.db, b)).toMatchObject({ timing: 'UNKNOWN', timingSource: null });
  });
});
