import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, upsertCalendarRow } from '../../src/db/repo.js';
import {
  getJpReport, jpPastDates, jpStocks, mergeJpActuals, setJpPrevMove, syncJpUniverse, upsertJpCalendarRow, upsertJpPastDates,
} from '../../src/jp/db/jpRepo.js';
import { JST } from '../../src/jp/domain/jpCalendar.js';
import { refreshJpBulkCalendar, refreshJpCalendar } from '../../src/jp/jobs/calendar.js';
import type { JpJobContext } from '../../src/jp/jobs/context.js';
import { refreshJpEstimates } from '../../src/jp/jobs/estimates.js';
import { refreshJpPastDates } from '../../src/jp/jobs/pastDates.js';
import { computeJpPrevMoves } from '../../src/jp/jobs/prevMoves.js';
import { refreshJpYahooResults } from '../../src/jp/jobs/results.js';
import { checkJpHolidayCoverage, refreshJpStocks } from '../../src/jp/jobs/stocks.js';
import { fetchYahooQuotes, type YahooCalRow, type YahooQuote } from '../../src/jp/sources/yahooJp.js';
import type { JpUniverseEntry } from '../../src/jp/universe.js';
import type { YahooClient } from '../../src/sources/yahooClient.js';
import { parseYahooSummaryFor, type YahooForeignSummary } from '../../src/sources/yahooForeignSummary.js';

const NOW = '2026-10-27T01:00:00.000Z';
const TODAY = '2026-10-27';
const HOUR = 3_600_000;
const at = (ms: number) => new Date(Date.parse(NOW) + ms).toISOString();

const fxText = (n: string) => readFileSync(new URL(`../fixtures/jp/${n}`, import.meta.url), 'utf8');
const summaryFx = (code: string): YahooForeignSummary =>
  parseYahooSummaryFor(JSON.parse(fxText(`y_${code}.T.json`)), { zone: JST, capCurrency: 'JPY' });
const S7203 = summaryFx('7203'); // nextDate 2026-11-05, 0q 2026-09-30, history up to 2026-06-30
const S3382 = summaryFx('3382'); // nextDate 2027-01-07, FY end Feb, 0y 2027-02-28, history up to 2026-08-31
const S9983 = summaryFx('9983'); // nextDate 2027-01-07, FY end Aug

/** The real quote batch, served for whichever symbols are asked. */
async function quoteFixture(): Promise<Map<string, YahooQuote>> {
  const y: YahooClient = {
    json: async () => JSON.parse(fxText('y_quote_batch.json')),
    text: async () => { throw new Error('unused'); },
    postJson: async () => { throw new Error('unused'); },
  };
  return fetchYahooQuotes(y, ['7203.T']);
}

const ENTRIES: JpUniverseEntry[] = [
  { code: '3382', edinetCode: 'E03462', name: 'Seven & i Holdings Co., Ltd.', nameJa: '株式会社セブン＆アイ・ホールディングス', fyEndMonth: 2,
    industryJa: '小売業', adr: null, adrRatio: null, cik: null },
  { code: '6501', edinetCode: 'E01737', name: 'Hitachi, Ltd.', nameJa: '株式会社日立製作所', fyEndMonth: 3, industryJa: '電気機器',
    adr: null, adrRatio: null, cik: null },
  { code: '7203', edinetCode: 'E02144', name: 'TOYOTA MOTOR CORPORATION', nameJa: 'トヨタ自動車株式会社', fyEndMonth: 3, industryJa: '輸送用機器',
    adr: 'TM', adrRatio: 10, cik: 1094517 },
  { code: '9983', edinetCode: 'E03217', name: 'FAST RETAILING CO.,LTD.', nameJa: '株式会社ファーストリテイリング', fyEndMonth: 8,
    industryJa: '小売業', adr: null, adrRatio: null, cik: null },
  { code: '9999', edinetCode: 'E99999', name: 'NO FY END', nameJa: '決算日不明', fyEndMonth: null, industryJa: null,
    adr: null, adrRatio: null, cik: null },
];

type Summ = YahooForeignSummary | null | Error;

// trackIn logs failed source calls; the failures here are deliberate.
beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); });

function setup(opts: {
  today?: string;
  now?: () => string;
  summaries?: Record<string, Summ>;
  calendar?: { rows: YahooCalRow[]; complete: boolean } | Error;
  closes?: Map<string, number> | Error;
  tierA?: string[];
  codeList?: string | Error;
  quotes?: Map<string, YahooQuote>;
  db?: ReturnType<typeof openDb>;
} = {}) {
  const db = opts.db ?? openDb(':memory:');
  if (!opts.db) syncJpUniverse(db, ENTRIES, NOW);
  const summaryCalls: { symbol: string; maxAgeMs: number }[] = [];
  const closeCalls: [string, string, string][] = [];
  const calendarCalls: [string, string][] = [];
  const quoteCalls: string[][] = [];
  const ctx: JpJobContext = {
    db,
    now: opts.now ?? (() => NOW),
    todayJST: () => opts.today ?? TODAY,
    yahooCalendar: async (from, to) => {
      calendarCalls.push([from, to]);
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
      const all = opts.quotes ?? new Map<string, YahooQuote>();
      return new Map(symbols.flatMap((s) => (all.has(s) ? [[s, all.get(s)!] as const] : [])));
    },
    yahooCloses: async (symbol, from, to) => {
      closeCalls.push([symbol, from, to]);
      if (opts.closes instanceof Error) throw opts.closes;
      return opts.closes ?? new Map();
    },
    edinetCodeList: async () => {
      if (opts.codeList instanceof Error) throw opts.codeList;
      return opts.codeList ?? fxText('codelist_rows.csv');
    },
    edinet: null,
    optionChain: async () => null,
    secHttp: null,
    tierA: () => opts.tierA ?? [],
  };
  return { db, ctx, summaryCalls, closeCalls, calendarCalls, quoteCalls };
}

type Db = ReturnType<typeof openDb>;
const rows = (db: Db, code: string) =>
  db.prepare('SELECT * FROM jp_reports WHERE code = ? ORDER BY report_date').all(code) as unknown as
    { id: number; report_date: string; date_status: string; period_end: string; period_label: string; timing: string; timing_source: string | null }[];
const sourceError = (db: Db, source: string) =>
  (db.prepare('SELECT last_error FROM source_status WHERE source = ?').get(source) as { last_error: string | null } | undefined)?.last_error ?? null;

const usRow = (db: Db, symbol: string, reportDate: string, timing: 'BMO' | 'AMC') =>
  upsertCalendarRow(db, {
    symbol, name: symbol, reportDate, fiscalQuarter: 'Sep/2026', timing, marketCap: null, epsEstimate: null,
    noOfEsts: null, epsActual: null, epsSurprisePct: null, lastYearEps: null, lastYearReportDate: null,
  }, NOW, TODAY);

const row = (code: string, period: { periodEnd: string; fiscalQuarter: 1 | 2 | 3 | 4; fyEnd: string }, periodLabel: string, reportDate: string,
  dateStatus: 'confirmed' | 'estimated' = 'estimated') => ({ code, name: code, period, periodLabel, reportDate, dateStatus });

const calRow = (code: string, date: string, timeType = 'TNS', timing: YahooCalRow['timing'] = 'UNKNOWN', epsActual: number | null = null): YahooCalRow =>
  ({ symbol: `${code}.T`, code, date, timing, timeType, epsActual });

// ---------------------------------------------------------------------------------------------------------------

describe('refreshJpStocks', () => {
  it('universe sync: 7203 full, 250A basic, a dropped code inactive; failed code-list fetch deactivates nothing', async () => {
    const quotes = await quoteFixture();
    const { db, ctx, quoteCalls } = setup({ quotes, db: openDb(':memory:') });
    await refreshJpStocks(ctx);
    const by = new Map(jpStocks(db).map((s) => [s.code, s]));
    // English code-list name served over the Yahoo name; cap in JPY with the JST date of the quote.
    expect(by.get('7203')).toMatchObject({
      level: 'full', adr: 'TM', name: 'TOYOTA MOTOR CORPORATION', marketCap: 36535558733824, marketCapAsOf: '2026-10-27', active: true,
    });
    // Alphanumeric code; no Yahoo quote for it: kept with blank cap.
    expect(by.has('7240')).toBe(false);
    expect(by.get('250A')).toMatchObject({ level: 'basic', yahooSymbol: '250A.T', marketCap: null, active: true });
    expect(quoteCalls.every((b) => b.length <= 50)).toBe(true);
    const active = jpStocks(db).filter((s) => s.active).length;

    // HOKUTO (13790) drops out of the list: inactive, everything else stays. NOK (72400, 非上場) never enters.
    const without = fxText('codelist_rows.csv').split(/\r?\n/).filter((l) => !l.includes('"13790"')).join('\n');
    await refreshJpStocks(setup({ db, codeList: without, quotes }).ctx);
    expect(jpStocks(db).find((s) => s.code === '1379')?.active).toBe(false);
    expect(jpStocks(db).filter((s) => s.active).length).toBe(active - 1);

    // A failed code-list fetch keeps the stored universe.
    await refreshJpStocks(setup({ db, codeList: new Error('HTTP 503'), quotes }).ctx);
    expect(jpStocks(db).filter((s) => s.active).length).toBe(active - 1);
    expect(sourceError(db, 'edinet-codelist')).toMatch(/503/);
  });

  it('a jp-holidays warning while the holiday list does not reach 60 days ahead', () => {
    const late = setup({ today: '2027-12-01' });
    checkJpHolidayCoverage(late.ctx);
    expect(sourceError(late.db, 'jp-holidays')).toMatch(/2028/);
    const now = setup();
    checkJpHolidayCoverage(now.ctx);
    expect(sourceError(now.db, 'jp-holidays')).toBeNull();
  });
});

describe('refreshJpCalendar (rolling per-symbol sweep)', () => {
  it('stale date creates no row; confirmed date never moved', async () => {
    const q1 = { periodEnd: '2026-11-30', fiscalQuarter: 1 as const, fyEnd: '2027-08-31' };
    const { db, ctx } = setup({ summaries: { '3382.T': { ...S3382, nextDate: '2026-10-20' }, '9983.T': S9983 } });
    upsertJpCalendarRow(db, row('9983', q1, '1Q FY27', '2027-01-08', 'confirmed'), NOW);
    await refreshJpCalendar(ctx, { perRun: 10 });
    expect(rows(db, '3382')).toEqual([]);
    expect(rows(db, '9983')).toMatchObject([{ report_date: '2027-01-08', date_status: 'confirmed', period_end: '2026-11-30' }]);
  });

  it('estimated date for the period from the single next date; timing stays unknown', async () => {
    const { db, ctx } = setup({ summaries: { '3382.T': S3382 } });
    await refreshJpCalendar(ctx, { perRun: 10 });
    expect(rows(db, '3382')).toMatchObject([
      { report_date: '2027-01-07', date_status: 'estimated', period_end: '2026-11-30', period_label: '3Q FY27', timing: 'UNKNOWN' },
    ]);
  });

  it('no fyEndMonth → no row (and no request)', async () => {
    const { db, ctx, summaryCalls } = setup({ summaries: { '9999.T': { ...S3382 } } });
    await refreshJpCalendar(ctx, { perRun: 10 });
    expect(rows(db, '9999')).toEqual([]);
    expect(summaryCalls.map((c) => c.symbol)).not.toContain('9999.T');
  });

  it('full level: US BMO 2026-11-05 + Yahoo 2026-11-05 → row 2026-11-05 estimated 2Q FY27; disagreement → nothing', async () => {
    const agree = setup({ summaries: { '7203.T': S7203 } });
    usRow(agree.db, 'TM', '2026-11-05', 'BMO');
    await refreshJpCalendar(agree.ctx, { perRun: 10 });
    expect(rows(agree.db, '7203')).toMatchObject([
      { report_date: '2026-11-05', date_status: 'estimated', period_end: '2026-09-30', period_label: '2Q FY27' },
    ]);

    const disagree = setup({ summaries: { '7203.T': { ...S7203, nextDate: '2026-11-06' } } });
    usRow(disagree.db, 'TM', '2026-11-05', 'BMO');
    await refreshJpCalendar(disagree.ctx, { perRun: 10 });
    expect(rows(disagree.db, '7203')).toEqual([]);

    // Yahoo has no single date: the US row alone (US AMC 11-04 → JST 11-05).
    const usOnly = setup({ summaries: { '7203.T': { ...S7203, nextDate: null } } });
    usRow(usOnly.db, 'TM', '2026-11-04', 'AMC');
    await refreshJpCalendar(usOnly.ctx, { perRun: 10 });
    expect(rows(usOnly.db, '7203')).toMatchObject([{ report_date: '2026-11-05', date_status: 'estimated' }]);
  });

  it('sweep incomplete: rows so far written, nothing deleted, source error recorded', async () => {
    const { db, ctx, summaryCalls } = setup({
      summaries: { '3382.T': S3382, '7203.T': new Error('HTTP 429'), '9983.T': S9983, '6501.T': null },
    });
    const kept = upsertJpCalendarRow(db, row('6501', { periodEnd: '2026-09-30', fiscalQuarter: 2, fyEnd: '2027-03-31' }, '2Q FY27', '2026-11-10'), NOW);
    await refreshJpCalendar(ctx, { perRun: 10 });
    // Codes without a date go first (3382, 7203, 9983); the run stops at the failure.
    expect(summaryCalls.map((c) => c.symbol)).toEqual(['3382.T', '7203.T']);
    expect(rows(db, '3382')).toHaveLength(1);
    expect(getJpReport(db, kept)?.reportDate).toBe('2026-11-10');
    expect(sourceError(db, 'yahoo-jp-calendar')).toMatch(/429/);

    // The next run resumes with the codes not yet checked; the failed one waits for its next turn.
    const next = setup({ db, summaries: { '9983.T': S9983, '6501.T': null } });
    await refreshJpCalendar(next.ctx, { perRun: 10 });
    expect(next.summaryCalls.map((c) => c.symbol)).toEqual(['9983.T', '6501.T']);
  });

  it('first run takes codes with no date; progress survives a restart; near-term rows every 6 h; capped per run', async () => {
    let now = NOW;
    const summaries: Record<string, Summ> = { '3382.T': S3382, '7203.T': S7203, '9983.T': S9983, '6501.T': null };
    const { db, ctx, summaryCalls } = setup({ summaries, now: () => now });
    upsertJpCalendarRow(db, row('6501', { periodEnd: '2026-09-30', fiscalQuarter: 2, fyEnd: '2027-03-31' }, '2Q FY27', '2026-11-10'), NOW);

    await refreshJpCalendar(ctx, { perRun: 2 });
    expect(summaryCalls.map((c) => c.symbol)).toEqual(['3382.T', '7203.T']);

    // A restart: a new context on the same database resumes the cycle.
    now = at(60_000);
    const second = setup({ db, summaries, now: () => now });
    await refreshJpCalendar(second.ctx, { perRun: 2 });
    expect(second.summaryCalls.map((c) => c.symbol)).toEqual(['9983.T', '6501.T']);

    const third = setup({ db, summaries, now: () => now });
    await refreshJpCalendar(third.ctx, { perRun: 2 });
    expect(third.summaryCalls).toEqual([]);

    // Six hours on: only the near-term codes (reporting within 14 days) are due; 3382 and 9983 (January) wait a day.
    now = at(6 * HOUR + 2 * 60_000);
    const fourth = setup({ db, summaries, now: () => now });
    await refreshJpCalendar(fourth.ctx, { perRun: 10 });
    expect(fourth.summaryCalls.map((c) => c.symbol)).toEqual(['7203.T', '6501.T']);

    now = at(24 * HOUR + 2 * 60_000);
    const fifth = setup({ db, summaries, now: () => now });
    await refreshJpCalendar(fifth.ctx, { perRun: 10 });
    // Longest overdue first: the near-term pair (due 12 h after their 6 h check), then the daily ones.
    expect(fifth.summaryCalls.map((c) => c.symbol)).toEqual(['6501.T', '7203.T', '3382.T', '9983.T']);
  });

  it('a past calendar date whose period has an actual in earningsHistory is kept as a past date', async () => {
    const { db, ctx } = setup({
      summaries: {
        '7203.T': { ...S7203, nextDate: '2026-08-04' },               // period 2026-06-30: history has it
        '3382.T': { ...S3382, nextDate: '2026-10-09', epsHistory: [] }, // no actual: not kept
        '9983.T': { ...S9983, nextDate: '2026-04-09' },               // older than 140 days: not kept
      },
    });
    await refreshJpCalendar(ctx, { perRun: 10 });
    expect(jpPastDates(db, '7203')).toEqual([{ date: '2026-08-04', timing: null }]);
    expect(jpPastDates(db, '3382')).toEqual([]);
    expect(jpPastDates(db, '9983')).toEqual([]);
    expect(rows(db, '7203')).toEqual([]);
  });
});

describe('refreshJpBulkCalendar', () => {
  it('two different dates in one fiscal period → no row; dates in different periods → two rows', async () => {
    const { db, ctx, calendarCalls } = setup({
      calendar: { complete: true, rows: [
        calRow('3382', '2027-01-07'), calRow('3382', '2027-01-09'),
        calRow('6501', '2026-11-10'), calRow('6501', '2027-02-01'),
      ] },
    });
    await refreshJpBulkCalendar(ctx);
    expect(calendarCalls).toEqual([['2026-10-27', '2027-02-24']]);
    expect(rows(db, '3382')).toEqual([]);
    expect(rows(db, '6501').map((r) => [r.report_date, r.period_end])).toEqual([
      ['2026-11-10', '2026-09-30'], ['2027-02-01', '2026-12-31'],
    ]);
  });

  it('stale bulk date creates no row; a stored date is never moved by the bulk calendar', async () => {
    const { db, ctx } = setup({
      calendar: { complete: true, rows: [calRow('3382', '2026-10-20'), calRow('9983', '2027-01-09')] },
    });
    upsertJpCalendarRow(db, row('9983', { periodEnd: '2026-11-30', fiscalQuarter: 1, fyEnd: '2027-08-31' }, '1Q FY27', '2027-01-08', 'confirmed'), NOW);
    await refreshJpBulkCalendar(ctx);
    expect(rows(db, '3382')).toEqual([]);
    expect(rows(db, '9983')).toMatchObject([{ report_date: '2027-01-08', date_status: 'confirmed' }]);
  });

  it('TAS 13:25 JST sets DMH; other types leave Time not announced', async () => {
    const { db, ctx } = setup({
      calendar: { complete: true, rows: [calRow('6501', '2026-10-29', 'TAS', 'DMH'), calRow('3382', '2027-01-07', 'TNS')] },
    });
    await refreshJpBulkCalendar(ctx);
    expect(rows(db, '6501')).toMatchObject([{ report_date: '2026-10-29', timing: 'DMH', timing_source: 'yahoo' }]);
    expect(rows(db, '3382')).toMatchObject([{ report_date: '2027-01-07', timing: 'UNKNOWN', timing_source: null }]);
  });

  it('sweep incomplete: rows so far written, nothing deleted, source error recorded', async () => {
    const { db, ctx } = setup({ calendar: { complete: false, rows: [calRow('6501', '2026-11-10')] } });
    const kept = upsertJpCalendarRow(db, row('3382', { periodEnd: '2026-11-30', fiscalQuarter: 3, fyEnd: '2027-02-28' }, '3Q FY27', '2027-01-07'), NOW);
    await refreshJpBulkCalendar(ctx);
    expect(rows(db, '6501')).toHaveLength(1);
    expect(getJpReport(db, kept)?.reportDate).toBe('2027-01-07');
    expect(sourceError(db, 'yahoo-jp-calendar')).toMatch(/incomplete/);
  });
});

describe('refreshJpPastDates', () => {
  it('writes past dates with TAS timing, else null; an incomplete sweep is recorded', async () => {
    const { db, ctx, calendarCalls } = setup({
      calendar: { complete: false, rows: [calRow('6501', '2026-07-29', 'TAS', 'AMC'), calRow('3382', '2026-10-09')] },
    });
    expect(await refreshJpPastDates(ctx)).toBe(2);
    expect(calendarCalls).toEqual([['2025-09-22', '2026-10-26']]);
    expect(jpPastDates(db, '6501')).toEqual([{ date: '2026-07-29', timing: 'AMC' }]);
    expect(jpPastDates(db, '3382')).toEqual([{ date: '2026-10-09', timing: null }]);
    expect(sourceError(db, 'yahoo-jp-past-dates')).toMatch(/incomplete/);
  });
});

describe('refreshJpEstimates', () => {
  it('estimates: Q4 row takes the year item (span year); Q2 row the quarter item; budget and nearest-first respected', async () => {
    const { db, ctx, summaryCalls } = setup({ summaries: { '3382.T': S3382, '7203.T': S7203, '9983.T': S9983 } });
    const fy = upsertJpCalendarRow(db, row('3382', { periodEnd: '2027-02-28', fiscalQuarter: 4, fyEnd: '2027-02-28' }, 'FY27', '2026-10-28'), NOW);
    const q2 = upsertJpCalendarRow(db, row('7203', { periodEnd: '2026-09-30', fiscalQuarter: 2, fyEnd: '2027-03-31' }, '2Q FY27', '2026-11-05'), NOW);
    const far = upsertJpCalendarRow(db, row('9983', { periodEnd: '2026-11-30', fiscalQuarter: 1, fyEnd: '2027-08-31' }, '1Q FY27', '2026-11-09'), NOW);
    await refreshJpEstimates(ctx, { budget: 2 });
    expect(summaryCalls).toEqual([{ symbol: '3382.T', maxAgeMs: 12 * HOUR }, { symbol: '7203.T', maxAgeMs: 12 * HOUR }]);
    expect(getJpReport(db, fy)).toMatchObject({ epsEstimate: 125.77504, estimateSpan: 'year', estimateCurrency: 'JPY' });
    expect(getJpReport(db, q2)).toMatchObject({ epsEstimate: 56.37642, estimateSpan: 'quarter', estimateCurrency: 'JPY' });
    expect(getJpReport(db, far)?.epsEstimate).toBeNull();
    expect(jpStocks(db).find((s) => s.code === '3382')).toMatchObject({ sector: 'Consumer Defensive', industry: 'Grocery Stores' });
  });

  it('tier A (visible or watched) rows use the 25-minute max age', async () => {
    const { db, ctx, summaryCalls } = setup({ summaries: { '9983.T': S9983 }, tierA: ['9983'] });
    const id = upsertJpCalendarRow(db, row('9983', { periodEnd: '2026-11-30', fiscalQuarter: 1, fyEnd: '2027-08-31' }, '1Q FY27', '2027-01-07'), NOW);
    await refreshJpEstimates(ctx);
    expect(summaryCalls).toEqual([{ symbol: '9983.T', maxAgeMs: 25 * 60_000 }]);
    expect(getJpReport(db, id)).toMatchObject({ epsEstimate: 536.8116, estimateSpan: 'quarter' });
  });
});

describe('refreshJpYahooResults', () => {
  it('Yahoo results only when earningsHistory has the period; never over an EDINET value; rows dated [today-3, today]', async () => {
    const { db, ctx, summaryCalls } = setup({ summaries: { '3382.T': S3382, '9983.T': S9983, '6501.T': S7203 } });
    const aug = (q: 2 | 4, fyEnd: string) => ({ periodEnd: '2026-08-31', fiscalQuarter: q, fyEnd });
    const seven = upsertJpCalendarRow(db, row('3382', aug(2, '2027-02-28'), '2Q FY27', '2026-10-26'), NOW);
    const uniqlo = upsertJpCalendarRow(db, row('9983', aug(4, '2026-08-31'), 'FY26', '2026-10-25'), NOW);
    mergeJpActuals(db, uniqlo, {
      eps: { basic: 1500, diluted: 1499, currency: 'JPY', span: 'ytd', ytdMonths: 12 },
      revenue: { value: 3_400_000_000_000, currency: 'JPY', span: 'ytd', ytdMonths: 12 }, source: 'edinet',
    }, NOW);
    const hitachi = upsertJpCalendarRow(db, row('6501', { periodEnd: '2026-09-30', fiscalQuarter: 2, fyEnd: '2027-03-31' }, '2Q FY27', '2026-10-27'), NOW);
    upsertJpCalendarRow(db, row('6501', { periodEnd: '2026-06-30', fiscalQuarter: 1, fyEnd: '2027-03-31' }, '1Q FY27', '2026-10-20'), NOW);
    upsertJpCalendarRow(db, row('7203', { periodEnd: '2026-09-30', fiscalQuarter: 2, fyEnd: '2027-03-31' }, '2Q FY27', '2026-10-27'), NOW);

    const changed = await refreshJpYahooResults(ctx);
    expect(changed).toEqual([seven]);
    expect(summaryCalls.map((c) => c.symbol).sort()).toEqual(['3382.T', '6501.T']);
    expect(getJpReport(db, seven)).toMatchObject({
      epsActual: 28.05, epsCurrency: 'JPY', epsSource: 'yahoo', epsSpan: 'quarter',
      revenueActual: 3081455000000, revenueCurrency: 'JPY', revenueSource: 'yahoo', revenueSpan: 'quarter',
    });
    expect(getJpReport(db, uniqlo)).toMatchObject({ epsActual: 1500, epsSource: 'edinet', revenueSource: 'edinet' });
    expect(getJpReport(db, hitachi)?.epsActual).toBeNull();
  });
});

describe('computeJpPrevMoves', () => {
  it('previous move from the ADR US row with US BMO → JST AMC window', async () => {
    const closes = new Map([['2026-08-04', 3000], ['2026-08-05', 3150]]);
    const { db, ctx, closeCalls } = setup({ closes });
    usRow(db, 'TM', '2026-08-04', 'BMO');
    const id = upsertJpCalendarRow(db, row('7203', { periodEnd: '2026-09-30', fiscalQuarter: 2, fyEnd: '2027-03-31' }, '2Q FY27', '2026-11-05'), NOW);
    await computeJpPrevMoves(ctx);
    expect(closeCalls).toEqual([['7203.T', '2026-07-30', '2026-08-06']]);
    expect(getJpReport(db, id)).toMatchObject({ prevMovePct: 5, prevMoveDate: '2026-08-04', prevMoveBasis: 'known' });
  });

  it('previous move from jp_past_dates with unknown timing → assumed', async () => {
    const closes = new Map([['2026-08-06', 1000], ['2026-08-07', 950]]);
    const { db, ctx } = setup({ closes });
    upsertJpPastDates(db, [{ code: '6501', date: '2026-08-06', timing: null }]);
    const id = upsertJpCalendarRow(db, row('6501', { periodEnd: '2026-09-30', fiscalQuarter: 2, fyEnd: '2027-03-31' }, '2Q FY27', '2026-10-29'), NOW);
    await computeJpPrevMoves(ctx);
    expect(getJpReport(db, id)).toMatchObject({ prevMovePct: -5, prevMoveDate: '2026-08-06', prevMoveBasis: 'assumed' });
  });

  it('a failed close fetch is retried; rows outside [today-1, today+14] and not tier A are left alone; checked rows wait 20 h', async () => {
    const { db, ctx, closeCalls } = setup({ closes: new Error('HTTP 500') });
    upsertJpPastDates(db, [{ code: '6501', date: '2026-08-06', timing: null }, { code: '3382', date: '2026-10-09', timing: null }]);
    const id = upsertJpCalendarRow(db, row('6501', { periodEnd: '2026-09-30', fiscalQuarter: 2, fyEnd: '2027-03-31' }, '2Q FY27', '2026-10-29'), NOW);
    upsertJpCalendarRow(db, row('3382', { periodEnd: '2026-11-30', fiscalQuarter: 3, fyEnd: '2027-02-28' }, '3Q FY27', '2027-01-07'), NOW);
    await computeJpPrevMoves(ctx);
    expect(closeCalls.map((c) => c[0])).toEqual(['6501.T']);
    expect(getJpReport(db, id)?.prevMoveCheckedAt).toBeNull();

    setJpPrevMove(db, id, null, NOW);
    const later = setup({ db, closes: new Map() });
    await computeJpPrevMoves(later.ctx);
    expect(later.closeCalls).toEqual([]);

    // Tier A widens the set.
    const watched = setup({ db, closes: new Map(), tierA: ['3382'] });
    await computeJpPrevMoves(watched.ctx);
    expect(watched.closeCalls.map((c) => c[0])).toEqual(['3382.T']);
  });
});
