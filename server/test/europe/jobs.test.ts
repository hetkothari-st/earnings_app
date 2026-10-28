import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, upsertCalendarRow } from '../../src/db/repo.js';
import {
  europePastDates, europeStocks, getEuropeReport, mergeEuropeActuals, recordEuropeRelease, saveBankHolidays, setEuropeProfile, storedBankHolidays,
  syncEuropeUniverse, upsertEuropeCalendarRow,
} from '../../src/europe/db/europeRepo.js';
import { europePeriodFor, europePeriodLabel } from '../../src/europe/domain/period.js';
import type { EuropeMarket } from '../../src/europe/exchanges.js';
import { europeBulkRegions, refreshEuropeBulkCalendar, refreshEuropeCalendar } from '../../src/europe/jobs/calendar.js';
import type { EuropeJobContext } from '../../src/europe/jobs/context.js';
import { refreshEuropeEstimates } from '../../src/europe/jobs/estimates.js';
import { refreshEuropePastDates } from '../../src/europe/jobs/pastDates.js';
import { computeEuropePrevMoves } from '../../src/europe/jobs/prevMoves.js';
import { refreshEuropeYahooResults } from '../../src/europe/jobs/results.js';
import { refreshEuropeStocks } from '../../src/europe/jobs/stocks.js';
import { type EuropeCalRow, type EuropeQuote, fetchEuropeQuotes, parseEuropeSummary } from '../../src/europe/sources/yahooEurope.js';
import type { EuropeUniverseEntry } from '../../src/europe/universeBuild.js';
import { HttpError } from '../../src/sources/http.js';
import type { SweepTurns } from '../../src/sources/sweepTurns.js';
import type { YahooClient } from '../../src/sources/yahooClient.js';
import type { YahooForeignSummary } from '../../src/sources/yahooForeignSummary.js';

const NOW = '2026-10-28T09:00:00.000Z';
const TODAY = '2026-10-28';

const fxText = (path: string) => readFileSync(new URL(`../fixtures/europe/${path}`, import.meta.url), 'utf8');
const summaryFx = (symbol: string): YahooForeignSummary =>
  parseEuropeSummary(JSON.parse(fxText(`yahoo/y_${symbol}.json`)), 'Europe/London');
const AZN = summaryFx('AZN.L'); // nextDate 2026-10-30 (announced), 0q 2026-09-30, USD trend, GBp quote
const BT = summaryFx('BT-A.L'); // nextDate 2026-11-05 (announced), FY Mar, 0q 2026-09-30, GBP trend, no epsHistory
const FEVR = summaryFx('FEVR.L'); // AIM, FY Dec, only 0y / +1y, no epsHistory

/** The real quote batch (AZN.L GBp, IHG.L USD, ...). */
async function quoteFixture(): Promise<Map<string, EuropeQuote>> {
  const y: YahooClient = {
    json: async () => JSON.parse(fxText('yahoo/y_quote_batch.json')),
    text: async () => { throw new Error('unused'); },
    postJson: async () => { throw new Error('unused'); },
  };
  return fetchEuropeQuotes(y, ['AZN.L']);
}

const entry = (symbol: string, isin: string, extra: Partial<EuropeUniverseEntry> = {}): EuropeUniverseEntry => ({
  market: 'UK', symbol, isin, lei: null, name: `${symbol} plc`, exchange: 'LSE', mic: 'XLON', country: isin.slice(0, 2), currency: 'GBp',
  adr: null, adrRatio: null, adrRatioVerified: false, cik: null, secForm: null, ...extra,
});
const ENTRIES: EuropeUniverseEntry[] = [
  entry('AZN.L', 'GB0009895292', { name: 'AstraZeneca PLC', adr: 'AZN', adrRatio: 1, adrRatioVerified: true, cik: 901832, secForm: '6-K' }),
  entry('BT-A.L', 'GB0030913577'),
  entry('FEVR.L', 'GB00BRJ9BJ26', { mic: 'AIMX' }),
  entry('IHG.L', 'GB00BHJYC057'),
];

type Summ = YahooForeignSummary | null | Error;

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

function setup(opts: {
  market?: EuropeMarket;
  today?: string;
  summaries?: Record<string, Summ>;
  calendar?: { rows: EuropeCalRow[]; complete: boolean } | Error;
  closes?: Map<string, number> | Error;
  tierA?: string[];
  universe?: Awaited<ReturnType<EuropeJobContext['buildUniverse']>> | Error;
  holidays?: unknown;
  quotes?: Map<string, EuropeQuote>;
  db?: ReturnType<typeof openDb>;
  fyEnd?: Record<string, number>;
  /** SEC documents by URL (a stub of the one SEC client); absent: no SEC client. */
  sec?: Record<string, string>;
} = {}) {
  const db = opts.db ?? openDb(':memory:');
  if (!opts.db) {
    syncEuropeUniverse(db, 'UK', ENTRIES, NOW);
    const fy = opts.fyEnd ?? { 'AZN.L': 12, 'BT-A.L': 3, 'FEVR.L': 12 };
    for (const [symbol, month] of Object.entries(fy)) {
      setEuropeProfile(db, symbol, { name: null, sector: null, industry: null, marketCap: null, marketCapCurrency: null, asOf: null,
        fyEndMonth: { month, source: 'esef' } }, NOW);
    }
  }
  const summaryCalls: { symbol: string; maxAgeMs: number }[] = [];
  const closeCalls: [string, string, string][] = [];
  const calendarCalls: [string, string, string][] = [];
  const quoteCalls: string[][] = [];
  let holidayCalls = 0;
  const ctx: EuropeJobContext = {
    db,
    market: opts.market ?? 'UK',
    now: () => NOW,
    today: () => opts.today ?? TODAY,
    yahooCalendar: async (region, from, to) => {
      calendarCalls.push([region, from, to]);
      if (opts.calendar instanceof Error) throw opts.calendar;
      return opts.calendar ?? { rows: [], complete: true };
    },
    yahooSummary: async (symbol, maxAgeMs) => {
      summaryCalls.push({ symbol, maxAgeMs });
      const s = opts.summaries?.[symbol];
      if (s instanceof Error) throw s;
      return s ?? null;
    },
    yahooQuotes: async (symbols) => {
      quoteCalls.push(symbols);
      const all = opts.quotes ?? new Map<string, EuropeQuote>();
      return new Map(symbols.flatMap((s) => (all.has(s) ? [[s, all.get(s)!] as const] : [])));
    },
    yahooCloses: async (symbol, from, to) => {
      closeCalls.push([symbol, from, to]);
      if (opts.closes instanceof Error) throw opts.closes;
      return opts.closes ?? new Map();
    },
    buildUniverse: async () => {
      if (opts.universe instanceof Error) throw opts.universe;
      return opts.universe ?? { entries: ENTRIES, leftOut: 0, complete: true };
    },
    bankHolidaysJson: async () => {
      holidayCalls++;
      if (opts.holidays instanceof Error) throw opts.holidays;
      return opts.holidays ?? JSON.parse(fxText('feeds/govuk_bank_holidays.json'));
    },
    esef: {} as EuropeJobContext['esef'],
    prnFeed: async () => [],
    dila: null,
    optionChain: async () => null,
    secHttp: opts.sec ? secStub(opts.sec) : null,
    tierA: () => opts.tierA ?? [],
  };
  return { db, ctx, summaryCalls, closeCalls, calendarCalls, quoteCalls, holidayCalls: () => holidayCalls };
}

type Db = ReturnType<typeof openDb>;
const rows = (db: Db, symbol: string) =>
  db.prepare('SELECT * FROM europe_reports WHERE symbol = ? ORDER BY report_date').all(symbol) as unknown as
    { id: number; report_date: string; date_status: string; period_end: string; period_label: string; period_confirmed: number;
      timing: string; timing_source: string | null }[];
const status = (db: Db, source: string) =>
  db.prepare('SELECT last_error AS error, last_success_at AS ok FROM source_status WHERE source = ?').get(source) as
    { error: string | null; ok: string | null } | undefined;

const usRow = (db: Db, symbol: string, reportDate: string, timing: 'BMO' | 'AMC') =>
  upsertCalendarRow(db, {
    symbol, name: symbol, reportDate, fiscalQuarter: `${reportDate.slice(5, 7)}/2026`, timing, marketCap: null, epsEstimate: null,
    noOfEsts: null, epsActual: null, epsSurprisePct: null, lastYearEps: null, lastYearReportDate: null,
  }, NOW, TODAY);

/** A UK calendar row for `symbol` on `reportDate` with the period `europePeriodFor` gives (fiscal year end `fy`). */
const ukRow = (db: Db, symbol: string, reportDate: string, fy: number, confirmed = false) => {
  const period = europePeriodFor(reportDate, fy);
  return upsertEuropeCalendarRow(db, 'UK', {
    symbol, name: symbol, exchange: 'LSE', period, periodLabel: europePeriodLabel(period), periodConfirmed: confirmed,
    reportDate, dateStatus: 'estimated',
  }, NOW);
};

const passTurns = (): SweepTurns & { calls: string[] } => {
  const calls: string[] = [];
  return { calls, run: (who, fn) => { calls.push(who); return fn(); }, active: () => null };
};

// ---------------------------------------------------------------------------------------------------------------

describe('refreshEuropeStocks', () => {
  it('universe sync: incomplete build deactivates nothing and records europe-universe', async () => {
    const partial = { entries: [ENTRIES[0]!], leftOut: 3, complete: false };
    const { db, ctx } = setup({ universe: partial });
    await refreshEuropeStocks(ctx);
    await refreshEuropeStocks(ctx); // twice: a second missed refresh would deactivate
    expect(europeStocks(db, 'UK').filter((s) => s.active).map((s) => s.symbol)).toEqual(['AZN.L', 'BT-A.L', 'FEVR.L', 'IHG.L']);
    expect(europeStocks(db, 'UK').every((s) => s.missedRefreshes === 0)).toBe(true);
    expect(status(db, 'europe-universe-uk')?.error).toMatch(/incomplete/);

    // A complete build syncs: a missing symbol counts a missed refresh.
    const full = setup({ db, universe: { entries: ENTRIES.slice(0, 3), leftOut: 0, complete: true } });
    await refreshEuropeStocks(full.ctx);
    expect(europeStocks(db, 'UK').find((s) => s.symbol === 'IHG.L')).toMatchObject({ active: true, missedRefreshes: 1 });
    expect(status(db, 'europe-universe-uk')?.ok).toBe(NOW);

    // A thrown build keeps the stored universe too.
    const thrown = setup({ db, universe: new Error('FIRDS 503') });
    await refreshEuropeStocks(thrown.ctx);
    expect(europeStocks(db, 'UK').filter((s) => s.active)).toHaveLength(4);
  });

  it('quotes: cap stored with its own currency (GBP for a GBp line, USD for IHG.L), never converted', async () => {
    const { db, ctx, quoteCalls } = setup({ quotes: await quoteFixture() });
    await refreshEuropeStocks(ctx);
    expect(quoteCalls).toEqual([['AZN.L', 'BT-A.L', 'FEVR.L', 'IHG.L']]);
    const s = new Map(europeStocks(db, 'UK').map((x) => [x.symbol, x]));
    expect(s.get('AZN.L')).toMatchObject({ marketCap: 198857129984, marketCapCurrency: 'GBP' });
    expect(s.get('IHG.L')).toMatchObject({ marketCap: 23936333824, marketCapCurrency: 'USD' });
    expect(s.get('AZN.L')!.marketCapAsOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(s.get('FEVR.L')).toMatchObject({ marketCap: null, marketCapCurrency: null }); // not in the batch
  });

  it('a quote without a cap keeps the stored cap, currency and date', async () => {
    const { db } = setup();
    setEuropeProfile(db, 'BT-A.L', { name: null, sector: null, industry: null, marketCap: 2.1e10, marketCapCurrency: 'GBP', asOf: '2026-10-20' }, NOW);
    const noCap: EuropeQuote = { symbol: 'BT-A.L', price: 195.5, prevClose: 194, time: Date.parse(NOW), currency: 'GBp', marketCap: null,
      marketCapCurrency: null, name: 'BT Group plc' };
    const quoted = setup({ db, quotes: new Map([['BT-A.L', noCap]]) });
    await refreshEuropeStocks(quoted.ctx);
    expect(europeStocks(db, 'UK').find((x) => x.symbol === 'BT-A.L')).toMatchObject({
      marketCap: 2.1e10, marketCapCurrency: 'GBP', marketCapAsOf: '2026-10-20', name: 'BT Group plc',
    });
  });

  it('gov.uk holidays stored; fetch failure keeps stored', async () => {
    const { db, ctx } = setup();
    await refreshEuropeStocks(ctx);
    const stored = storedBankHolidays(db);
    expect(stored.has('2026-12-28')).toBe(true);
    expect(stored.has('2027-08-30')).toBe(true);
    expect((db.prepare("SELECT title FROM europe_bank_holidays WHERE date = '2026-12-25'").get() as { title: string | null }).title)
      .toBe('Christmas Day');
    const n = stored.size;

    const failed = setup({ db, holidays: new Error('HTTP 503') });
    await refreshEuropeStocks(failed.ctx);
    expect(storedBankHolidays(db).size).toBe(n);
    expect(status(db, 'govuk-holidays')?.error).toMatch(/503/);

    const malformed = setup({ db, holidays: { scotland: {} } });
    await refreshEuropeStocks(malformed.ctx);
    expect(storedBankHolidays(db).size).toBe(n);

    // EU never asks gov.uk.
    const eu = setup({ db, market: 'EU', universe: { entries: [], leftOut: 0, complete: false } });
    await refreshEuropeStocks(eu.ctx);
    expect(eu.holidayCalls()).toBe(0);
  });

  it('europe-holidays warning when a holiday list does not reach today + 60', async () => {
    const { db, ctx } = setup();
    await refreshEuropeStocks(ctx);
    expect(status(db, 'europe-holidays')).toMatchObject({ error: null, ok: NOW });
    const late = setup({ db, today: '2027-11-15' });
    await refreshEuropeStocks(late.ctx);
    expect(status(db, 'europe-holidays')?.error).toMatch(/2028.*LSE/);
    // The year comes from the data: no hardcoded year in the message.
    const later = setup({ db, today: '2028-11-15' });
    await refreshEuropeStocks(later.ctx);
    expect(status(db, 'europe-holidays')?.error).toMatch(/2029.*LSE/);
  });
});

describe('refreshEuropeCalendar', () => {
  it('sweep runs inside sweepTurns and respects perRun', async () => {
    const turns = passTurns();
    const { ctx, summaryCalls } = setup({ summaries: { 'AZN.L': AZN, 'BT-A.L': BT } });
    await refreshEuropeCalendar(ctx, { perRun: 2, turns });
    expect(turns.calls).toEqual(['uk']);
    expect(summaryCalls).toHaveLength(2);

    const eu = setup({ market: 'EU' });
    const euTurns = passTurns();
    await refreshEuropeCalendar(eu.ctx, { perRun: 0, turns: euTurns });
    expect(euTurns.calls).toEqual(['eu']);
    expect(eu.summaryCalls).toHaveLength(0);
  });

  it('AIM FY results dated 2026-05-20 with no confirming source → row period unconfirmed; a Yahoo epsHistory for 2025-12-31 never merges into it', async () => {
    const aim: YahooForeignSummary = { ...FEVR, nextDate: '2026-05-20', nextDateEstimated: false };
    const { db, ctx } = setup({ today: '2026-05-10', summaries: { 'FEVR.L': aim } });
    await refreshEuropeCalendar(ctx, { perRun: 10, turns: passTurns() });
    const [r] = rows(db, 'FEVR.L');
    expect(r).toMatchObject({ report_date: '2026-05-20', period_end: '2026-03-31', period_confirmed: 0, date_status: 'estimated' });
    expect(getEuropeReport(db, r!.id)?.periodConfirmed).toBe(false);

    const after: YahooForeignSummary = { ...aim, epsHistory: [{ periodEnd: '2025-12-31', actual: 0.25, currency: 'GBP' }] };
    const res = setup({ db, today: '2026-05-25', summaries: { 'FEVR.L': after } });
    expect(await refreshEuropeYahooResults(res.ctx)).toEqual([]);
    expect(getEuropeReport(db, r!.id)).toMatchObject({ epsActual: null, releasedAt: null, periodConfirmed: false });
  });

  it('trend 0q end equal to periodEnd confirms the period', async () => {
    const { db, ctx } = setup({ summaries: { 'BT-A.L': BT, 'AZN.L': { ...AZN, trend: AZN.trend.filter((t) => t.period !== '0q') } } });
    await refreshEuropeCalendar(ctx, { perRun: 10, turns: passTurns() });
    expect(rows(db, 'BT-A.L')).toMatchObject([{ report_date: '2026-11-05', period_end: '2026-09-30', period_label: 'H1 FY27', period_confirmed: 1 }]);
    // No 0q item: AZN.L's row stays unconfirmed.
    expect(rows(db, 'AZN.L')).toMatchObject([{ report_date: '2026-10-30', period_end: '2026-09-30', period_confirmed: 0 }]);
    // An H1 row never takes a quarter trend item: no estimate rather than a quarter-span one on a half-year row.
    const bt = getEuropeReport(db, rows(db, 'BT-A.L')[0]!.id);
    expect(bt).toMatchObject({ epsEstimate: null, estimateSpan: null });
    // AZN.L's Q3 row: its 0q item was removed and +1q ends 2026-12-31, so no estimate either.
    expect(getEuropeReport(db, rows(db, 'AZN.L')[0]!.id)).toMatchObject({ epsEstimate: null });
  });

  it('full level: US AMC 2026-11-05 + Yahoo AZN.L 2026-11-06 → row 2026-11-06; disagreement without flag → nothing', async () => {
    const agree = setup({ summaries: { 'AZN.L': { ...AZN, nextDate: '2026-11-06', nextDateEstimated: null } } });
    usRow(agree.db, 'AZN', '2026-11-05', 'AMC');
    await refreshEuropeCalendar(agree.ctx, { perRun: 10, turns: passTurns() });
    expect(rows(agree.db, 'AZN.L')).toMatchObject([{ report_date: '2026-11-06', date_status: 'estimated' }]);

    const disagree = setup({ summaries: { 'AZN.L': { ...AZN, nextDate: '2026-11-10', nextDateEstimated: null } } });
    usRow(disagree.db, 'AZN', '2026-11-05', 'AMC');
    await refreshEuropeCalendar(disagree.ctx, { perRun: 10, turns: passTurns() });
    expect(rows(disagree.db, 'AZN.L')).toEqual([]);

    // An announced Yahoo date wins; a Yahoo projection gives way to the US date.
    const announced = setup({ summaries: { 'AZN.L': { ...AZN, nextDate: '2026-11-10', nextDateEstimated: false } } });
    usRow(announced.db, 'AZN', '2026-11-05', 'AMC');
    await refreshEuropeCalendar(announced.ctx, { perRun: 10, turns: passTurns() });
    expect(rows(announced.db, 'AZN.L')).toMatchObject([{ report_date: '2026-11-10', date_status: 'estimated' }]);

    const projected = setup({ summaries: { 'AZN.L': { ...AZN, nextDate: '2026-11-10', nextDateEstimated: true } } });
    usRow(projected.db, 'AZN', '2026-11-05', 'AMC');
    await refreshEuropeCalendar(projected.ctx, { perRun: 10, turns: passTurns() });
    expect(rows(projected.db, 'AZN.L')).toMatchObject([{ report_date: '2026-11-06' }]);
  });

  it('full level: US AMC on a Friday → the next LSE trading day (Monday); Yahoo on that Monday agrees', async () => {
    const agree = setup({ summaries: { 'AZN.L': { ...AZN, nextDate: '2026-11-09', nextDateEstimated: null } } });
    usRow(agree.db, 'AZN', '2026-11-06', 'AMC');
    await refreshEuropeCalendar(agree.ctx, { perRun: 10, turns: passTurns() });
    expect(rows(agree.db, 'AZN.L')).toMatchObject([{ report_date: '2026-11-09' }]);

    const usOnly = setup({ summaries: { 'AZN.L': null } });
    usRow(usOnly.db, 'AZN', '2026-11-06', 'AMC');
    await refreshEuropeCalendar(usOnly.ctx, { perRun: 10, turns: passTurns() });
    expect(rows(usOnly.db, 'AZN.L')).toMatchObject([{ report_date: '2026-11-09' }]);
  });

  it('full level: US AMC before a bank holiday → the next LSE trading day after it', async () => {
    // Thu 2026-12-24 AMC: Fri 12-25 holiday, weekend, Mon 12-28 holiday (stored gov.uk date) → Tue 12-29.
    const { db, ctx } = setup({ today: '2026-12-20', summaries: { 'AZN.L': null } });
    saveBankHolidays(db, [{ date: '2026-12-25', title: 'Christmas Day' }, { date: '2026-12-28', title: 'Boxing Day' }], NOW);
    usRow(db, 'AZN', '2026-12-24', 'AMC');
    await refreshEuropeCalendar(ctx, { perRun: 10, turns: passTurns() });
    expect(rows(db, 'AZN.L')).toMatchObject([{ report_date: '2026-12-29' }]);
  });

  it('no fyEndMonth → no row', async () => {
    const { db, ctx } = setup({ fyEnd: {}, summaries: { 'BT-A.L': { ...BT, fyEndMonth: null }, 'AZN.L': AZN } });
    await refreshEuropeCalendar(ctx, { perRun: 10, turns: passTurns() });
    expect(rows(db, 'BT-A.L')).toEqual([]);
    expect(europeStocks(db, 'UK').find((s) => s.symbol === 'BT-A.L')?.fyEndMonth).toBeNull();
    // A summary that states the fiscal year end stores it (source yahoo) and the row follows.
    const stock = europeStocks(db, 'UK').find((s) => s.symbol === 'AZN.L');
    expect(stock).toMatchObject({ fyEndMonth: 12, fyEndSource: 'yahoo' });
    expect(rows(db, 'AZN.L')).toMatchObject([{ report_date: '2026-10-30', period_end: '2026-09-30' }]);
  });

  it('a stale announced date with a matching actual is kept as a past date; a failed request ends the run', async () => {
    const past: YahooForeignSummary = { ...FEVR, nextDate: '2026-09-10', nextDateEstimated: false,
      epsHistory: [{ periodEnd: '2026-06-30', actual: 0.1, currency: 'GBP' }] };
    const { db, ctx, summaryCalls } = setup({ summaries: { 'AZN.L': new Error('HTTP 500'), 'FEVR.L': past } });
    await refreshEuropeCalendar(ctx, { perRun: 10, turns: passTurns() });
    expect(summaryCalls.map((c) => c.symbol)).toEqual(['AZN.L']);
    expect(status(db, 'yahoo-uk-calendar')?.error).toMatch(/500/);
    const next = setup({ db, summaries: { 'FEVR.L': past } });
    await refreshEuropeCalendar(next.ctx, { perRun: 10, turns: passTurns() });
    expect(europePastDates(db, 'FEVR.L')).toEqual([{ date: '2026-09-10', timing: null }]);
    expect(rows(db, 'FEVR.L')).toEqual([]);
  });
});

describe('refreshEuropeBulkCalendar / refreshEuropePastDates', () => {
  const cal = (symbol: string, date: string, timeType = 'TNS', timing: EuropeCalRow['timing'] = 'UNKNOWN'): EuropeCalRow =>
    ({ symbol, date, timing, timeType, epsActual: null });

  it('bulk supplement no-op when no region enabled', async () => {
    const { db, ctx, calendarCalls } = setup({ calendar: { rows: [cal('BT-A.L', '2026-11-05')], complete: true } });
    await refreshEuropeBulkCalendar(ctx, { regions: [] });
    expect(await refreshEuropePastDates(ctx, { regions: [] })).toBe(0);
    expect(calendarCalls).toEqual([]);
    expect(rows(db, 'BT-A.L')).toEqual([]);
    expect(europeBulkRegions('UK')).toEqual(['gb']);
    expect(europeBulkRegions('EU')).toEqual(['it', 'de', 'ch', 'se', 'dk']);
  });

  it('bulk creates a missing period with TAS timing and never moves a stored date', async () => {
    const { db, ctx, calendarCalls } = setup({
      calendar: { rows: [cal('BT-A.L', '2026-11-05', 'TAS', 'BMO'), cal('FEVR.L', '2026-11-12', 'TAS', 'BMO'), cal('XYZ.L', '2026-11-05')], complete: false },
    });
    ukRow(db, 'FEVR.L', '2026-11-10', 12);
    await refreshEuropeBulkCalendar(ctx);
    expect(calendarCalls).toEqual([['gb', TODAY, '2027-02-25']]);
    expect(rows(db, 'BT-A.L')).toMatchObject([{ report_date: '2026-11-05', timing: 'BMO', timing_source: 'yahoo', period_confirmed: 0 }]);
    expect(rows(db, 'FEVR.L')).toMatchObject([{ report_date: '2026-11-10', timing: 'UNKNOWN' }]);
    expect(status(db, 'yahoo-uk-calendar')?.error).toMatch(/incomplete/);
  });

  it('past dates: [today−400, today−1] per enabled region, own stocks only', async () => {
    const { db, ctx, calendarCalls } = setup({
      calendar: { rows: [cal('BT-A.L', '2026-05-14', 'TAS', 'BMO'), cal('FEVR.L', '2026-09-10'), cal('0JQR.L', '2026-10-20')], complete: true },
    });
    expect(await refreshEuropePastDates(ctx)).toBe(2);
    expect(calendarCalls).toEqual([['gb', '2025-09-23', '2026-10-27']]);
    expect(europePastDates(db, 'BT-A.L')).toEqual([{ date: '2026-05-14', timing: 'BMO' }]);
    expect(europePastDates(db, '0JQR.L')).toEqual([]);
  });
});

describe('refreshEuropeEstimates', () => {
  it('estimates: GBp EPS estimate stored GBp; Q4 takes year item; budget respected', async () => {
    const fevr: YahooForeignSummary = {
      ...FEVR,
      trend: [
        { period: '0q', periodEnd: '2026-12-31', eps: 7.1, epsAnalysts: 3, epsCurrency: 'GBp', revenue: 1e8, revenueAnalysts: 3, revenueCurrency: 'GBP' },
        { period: '0y', periodEnd: '2026-12-31', eps: 28.5, epsAnalysts: 12, epsCurrency: 'GBp', revenue: 4e8, revenueAnalysts: 11, revenueCurrency: 'GBP' },
      ],
    };
    const { db, ctx, summaryCalls } = setup({ tierA: ['FEVR.L'], summaries: { 'FEVR.L': fevr, 'BT-A.L': BT } });
    const q4 = ukRow(db, 'FEVR.L', '2027-03-10', 12); // FY26, fourth quarter
    const h1 = ukRow(db, 'BT-A.L', '2026-11-05', 3);
    await refreshEuropeEstimates(ctx);
    expect(getEuropeReport(db, q4)).toMatchObject({
      epsEstimate: 28.5, epsEstimateCurrency: 'GBp', epsAnalysts: 12, revenueEstimate: 4e8, revenueEstimateCurrency: 'GBP', estimateSpan: 'year',
      sector: 'Consumer Defensive',
    });
    // H1 row: no quarter item taken (no estimate), but the 0q end still confirms its period.
    expect(getEuropeReport(db, h1)).toMatchObject({ epsEstimate: null, estimateSpan: null, periodConfirmed: true });
    expect(summaryCalls.map((c) => c.symbol)).toEqual(['BT-A.L', 'FEVR.L']); // nearest first

    const budgeted = setup({ db, tierA: ['FEVR.L'], summaries: { 'FEVR.L': fevr, 'BT-A.L': BT } });
    await refreshEuropeEstimates(budgeted.ctx, { budget: 1 });
    expect(budgeted.summaryCalls.map((c) => c.symbol)).toEqual(['BT-A.L']);

    // Outside tier B and not watched: no request.
    const plain = setup({ db, summaries: { 'FEVR.L': fevr, 'BT-A.L': BT } });
    await refreshEuropeEstimates(plain.ctx);
    expect(plain.summaryCalls.map((c) => c.symbol)).toEqual(['BT-A.L']);
  });
});

describe('refreshEuropeYahooResults', () => {
  it('Yahoo results flip released with source yahoo and never replace an ESEF value', async () => {
    const hist = (periodEnd: string, actual: number, currency: string | null = 'GBp') => [{ periodEnd, actual, currency }];
    const { db, ctx, summaryCalls } = setup({
      today: '2026-11-06',
      summaries: {
        'IHG.L': { ...AZN, epsHistory: hist('2026-09-30', 1.2, 'USD') },
        'BT-A.L': { ...BT, epsHistory: hist('2026-09-30', 2.1) },
        'FEVR.L': { ...FEVR, epsHistory: hist('2026-09-30', 99) },
        'AZN.L': { ...AZN, epsHistory: hist('2026-09-30', 2.7, 'USD') },
      },
    });
    const ihg = ukRow(db, 'IHG.L', '2026-10-22', 12); // Q3 FY26: a true quarter row
    mergeEuropeActuals(db, ihg, { revenue: { value: 1.3e9, currency: 'USD', span: 'quarter', ytdMonths: null }, source: 'esef' }, NOW);
    const bt = ukRow(db, 'BT-A.L', '2026-11-05', 3); // H1 FY27
    const fevr = ukRow(db, 'FEVR.L', '2026-10-20', 9); // FY26 (a September year end): a fourth-quarter row
    const azn = ukRow(db, 'AZN.L', '2026-10-30', 12);

    expect(await refreshEuropeYahooResults(ctx)).toEqual([fevr, ihg, bt]);
    expect(getEuropeReport(db, ihg)).toMatchObject({
      epsActual: 1.2, epsCurrency: 'USD', epsSource: 'yahoo', epsSpan: 'quarter', releasedAt: NOW, releasedSource: 'yahoo', periodConfirmed: true,
      revenueActual: 1.3e9, revenueSource: 'esef',
    });
    // H1 and FY rows: Yahoo's figure may be a 6- or 12-month one, so no EPS; the release still flips.
    expect(getEuropeReport(db, bt)).toMatchObject({ epsActual: null, epsSource: null, releasedAt: NOW, releasedSource: 'yahoo' });
    expect(getEuropeReport(db, fevr)).toMatchObject({ periodLabel: 'FY26', epsActual: null, releasedAt: NOW, releasedSource: 'yahoo' });
    expect(getEuropeReport(db, azn)).toMatchObject({ epsActual: null, releasedAt: null }); // full level: SEC's job
    expect(summaryCalls.map((c) => c.symbol)).toEqual(['FEVR.L', 'IHG.L', 'BT-A.L']);

    // An ESEF EPS replaces Yahoo's; a later Yahoo run never puts its own back.
    expect(mergeEuropeActuals(db, ihg, { eps: { basic: 1.25, diluted: null, currency: 'USD', span: 'quarter', ytdMonths: null }, source: 'esef' }, NOW)).toBe(true);
    const again = setup({ db, today: '2026-11-06', summaries: { 'IHG.L': { ...AZN, epsHistory: hist('2026-09-30', 1.2, 'USD') } } });
    expect(await refreshEuropeYahooResults(again.ctx)).toEqual([]);
    expect(getEuropeReport(db, ihg)).toMatchObject({ epsActual: 1.25, epsSource: 'esef' });
  });
});

/** A stub of the SEC client: a 404 for any URL not given. */
function secStub(docs: Record<string, string>): NonNullable<EuropeJobContext['secHttp']> {
  const http: NonNullable<EuropeJobContext['secHttp']> = {
    async text(url) {
      const body = docs[url];
      if (body === undefined) throw new HttpError(404, url);
      return body;
    },
    async json(url) { return JSON.parse(await http.text(url)); },
  };
  return http;
}

// AstraZeneca's Q1 2026 results 6-K (Task 4 fixture), 0001654954-26-004047, filed 2026-04-29.
const AZN_ACC = '0001654954-26-004047';
const AZN_DIR = 'https://www.sec.gov/Archives/edgar/data/901832/000165495426004047';
/** EDGAR documents for that 6-K with the given ET acceptance wall clock (`yyyyMMddHHmmss`). */
const aznSec = (acceptedEt: string): Record<string, string> => ({
  'https://data.sec.gov/submissions/CIK0000901832.json': JSON.stringify({ filings: { recent: {
    accessionNumber: [AZN_ACC], filingDate: ['2026-04-29'], form: ['6-K'], items: [''], primaryDocument: ['azn_q1_2026.htm'],
  } } }),
  [`${AZN_DIR}/${AZN_ACC}-index.htm`]: `<html><body><table class="tableFile"><tr><th>Seq</th><th>Description</th><th>Document</th><th>Type</th><th>Size</th></tr>
<tr><td>1</td><td>6-K</td><td><a href="${AZN_DIR}/azn_q1_2026.htm">azn_q1_2026.htm</a></td><td>6-K</td><td>1</td></tr></table></body></html>`,
  [`${AZN_DIR}/azn_q1_2026.htm`]: fxText('sec/azn_q1_2026_results_6k.htm'),
  [`${AZN_DIR}/${AZN_ACC}.hdr.sgml`]: `<SEC-HEADER>\n<ACCEPTANCE-DATETIME>${acceptedEt}\n</SEC-HEADER>`,
});

describe('computeEuropePrevMoves', () => {
  it('ADR US row AMC → the next LSE trading day before the open: known timing', async () => {
    // US AMC Fri 2026-08-28 → the next LSE trading day, Tue 09-01 (Mon 08-31 is a UK bank holiday), BMO: Fri 08-28 → Tue 09-01.
    const closes = new Map([['2026-08-28', 100], ['2026-08-31', 999], ['2026-09-01', 105]]);
    const { db, ctx, closeCalls } = setup({ closes });
    saveBankHolidays(db, [{ date: '2026-08-31', title: 'Summer bank holiday' }], NOW);
    usRow(db, 'AZN', '2026-08-28', 'AMC');
    const id = ukRow(db, 'AZN.L', '2026-11-05', 12);
    await computeEuropePrevMoves(ctx);
    expect(closeCalls).toEqual([['AZN.L', '2026-08-23', '2026-09-02']]);
    expect(getEuropeReport(db, id)).toMatchObject({ prevMovePct: 5, prevMoveDate: '2026-09-01', prevMoveBasis: 'known' });
  });

  it('past date with unknown timing → blank, never assumed; nothing in 45–140 days → checked, blank', async () => {
    const closes = new Map([['2026-09-10', 1000], ['2026-09-11', 950]]);
    const { db, ctx, closeCalls } = setup({ closes });
    db.prepare('INSERT INTO europe_past_dates (symbol, date, timing) VALUES (?, ?, NULL)').run('FEVR.L', '2026-09-10');
    const id = ukRow(db, 'FEVR.L', '2026-11-10', 12);
    const bt = ukRow(db, 'BT-A.L', '2026-11-05', 3);
    await computeEuropePrevMoves(ctx);
    expect(getEuropeReport(db, id)).toMatchObject({ prevMovePct: null, prevMoveBasis: null, prevMoveCheckedAt: NOW });
    expect(getEuropeReport(db, bt)).toMatchObject({ prevMovePct: null, prevMoveCheckedAt: NOW });
    expect(closeCalls).toEqual([]);
  });

  it('past date with a stated timing (Yahoo TAS BMO) → that window, known', async () => {
    const closes = new Map([['2026-09-09', 1000], ['2026-09-10', 950], ['2026-09-11', 1]]);
    const { db, ctx } = setup({ closes });
    db.prepare("INSERT INTO europe_past_dates (symbol, date, timing) VALUES (?, ?, 'BMO')").run('FEVR.L', '2026-09-10');
    const id = ukRow(db, 'FEVR.L', '2026-11-10', 12);
    await computeEuropePrevMoves(ctx);
    expect(getEuropeReport(db, id)).toMatchObject({ prevMovePct: -5, prevMoveDate: '2026-09-10', prevMoveBasis: 'known' });
  });

  it('SEC results 6-K accepted before the LSE open on the report date proves BMO (US row BMO says nothing locally)', async () => {
    // Accepted 02:00:00 ET Wed 2026-04-29 = 07:00 London, before the 08:00 open: Tue 04-28 → Wed 04-29.
    const closes = new Map([['2026-04-28', 100], ['2026-04-29', 104], ['2026-04-30', 999]]);
    const { db, ctx } = setup({ closes, today: '2026-07-23', sec: aznSec('20260429020000') });
    usRow(db, 'AZN', '2026-04-29', 'BMO');
    const id = ukRow(db, 'AZN.L', '2026-07-23', 12);
    await computeEuropePrevMoves(ctx);
    expect(getEuropeReport(db, id)).toMatchObject({ prevMovePct: 4, prevMoveDate: '2026-04-29', prevMoveBasis: 'known' });
  });

  it('a results 6-K accepted after the local open proves nothing: blank', async () => {
    // Accepted 07:00 ET = 12:00 London, inside the session (the RNS may have come at 07:00): unknown → blank.
    const closes = new Map([['2026-04-28', 100], ['2026-04-29', 104], ['2026-04-30', 999]]);
    const { db, ctx } = setup({ closes, today: '2026-07-23', sec: aznSec('20260429070000') });
    usRow(db, 'AZN', '2026-04-29', 'BMO');
    const id = ukRow(db, 'AZN.L', '2026-07-23', 12);
    await computeEuropePrevMoves(ctx);
    expect(getEuropeReport(db, id)).toMatchObject({ prevMovePct: null, prevMoveBasis: null, prevMoveCheckedAt: NOW });
  });

  it("the app's own release: SEC acceptance before the open on its date proves BMO; after the open → blank", async () => {
    const closes = new Map([['2026-07-23', 100], ['2026-07-24', 90], ['2026-07-27', 999]]);
    const early = setup({ closes });
    const prior = ukRow(early.db, 'AZN.L', '2026-07-24', 12);
    recordEuropeRelease(early.db, prior, { at: '2026-07-24T06:01:00.000Z', source: 'sec', timing: null }); // 07:01 London
    const next = ukRow(early.db, 'AZN.L', '2026-10-30', 12);
    await computeEuropePrevMoves(early.ctx);
    expect(getEuropeReport(early.db, next)).toMatchObject({ prevMovePct: -10, prevMoveDate: '2026-07-24', prevMoveBasis: 'known' });

    const late = setup({ closes });
    const p2 = ukRow(late.db, 'AZN.L', '2026-07-24', 12);
    recordEuropeRelease(late.db, p2, { at: '2026-07-24T11:00:00.000Z', source: 'sec', timing: null }); // 12:00 London
    const n2 = ukRow(late.db, 'AZN.L', '2026-10-30', 12);
    await computeEuropePrevMoves(late.ctx);
    expect(getEuropeReport(late.db, n2)).toMatchObject({ prevMovePct: null, prevMoveBasis: null });
  });
});
