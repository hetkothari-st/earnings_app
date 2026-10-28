import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDb, recordSourceSuccess } from '../../src/db/repo.js';
import { syncEuropeUniverse, upsertEuropePastDates } from '../../src/europe/db/europeRepo.js';
import type { EuropeJobContext } from '../../src/europe/jobs/context.js';
import { EUROPE_CRONS, prnHours, warmEsefSince, warmUpEurope, warmUpEuropeAfter } from '../../src/europe/jobs/scheduler.js';
import type { EuropeUniverseEntry } from '../../src/europe/universeBuild.js';
import type { JobContext } from '../../src/jobs/context.js';
import { createJobRunner, type JobRunner } from '../../src/jobs/scheduler.js';
import type { SweepTurns } from '../../src/sources/sweepTurns.js';

afterEach(() => { vi.restoreAllMocks(); });

const NOW = '2026-10-28T09:00:00.000Z';
const down = async (): Promise<never> => { throw new Error('source down'); };

const ENTRY: EuropeUniverseEntry = {
  market: 'UK', symbol: 'AZN.L', isin: 'GB0009895292', lei: null, name: 'AstraZeneca PLC', exchange: 'LSE', mic: 'XLON', country: 'GB',
  currency: 'GBp', adr: null, adrRatio: null, adrRatioVerified: false, cik: null, secForm: null,
};

function setup(market: 'UK' | 'EU' = 'UK', failing = `${market.toLowerCase()}-calendar`) {
  const db = openDb(':memory:');
  syncEuropeUniverse(db, 'UK', [ENTRY], NOW);
  const ctx: EuropeJobContext = {
    db, market, now: () => NOW, today: () => '2026-10-28',
    yahooCalendar: down, yahooSummary: down, yahooQuotes: down, yahooCloses: down, buildUniverse: down, bankHolidaysJson: down,
    esef: { recent: down, facts: down }, prnFeed: down, dila: null, optionChain: down,
    secHttp: null, // no SEC_USER_AGENT: the sweep does nothing, the rest still runs
    tierA: () => [],
  };
  const inner = createJobRunner({ db, now: () => NOW } as unknown as JobContext);
  const started: string[] = [];
  const finished: string[] = [];
  const job: JobRunner = (name, fn) => inner(name, async () => {
    started.push(name);
    if (name === failing) throw new Error('calendar exploded');
    await fn();
    finished.push(name);
  });
  return { db, ctx, job, started, finished };
}

describe('Europe scheduler', () => {
  it('warm-up order; skips pastDates when populated; survives a failing source; calendar job runs inside sweepTurns', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const order = ['uk-stocks', 'uk-past-dates', 'uk-calendar', 'uk-bulk-calendar', 'uk-results', 'uk-sec-sweep', 'uk-esef', 'uk-estimates',
      'uk-prev-moves', 'uk-moves'];

    const empty = setup();
    const onStocks = vi.fn();
    await warmUpEurope(empty.ctx, empty.job, { onStocks });
    expect(empty.started).toEqual(order);
    expect(empty.finished).toEqual(order.filter((n) => n !== 'uk-calendar'));
    expect(errors).toHaveBeenCalledWith('[job uk-calendar]', expect.any(Error));
    expect(onStocks).toHaveBeenCalledTimes(1);

    const populated = setup();
    upsertEuropePastDates(populated.db, [{ symbol: 'AZN.L', date: '2026-07-29', timing: null }]);
    await warmUpEurope(populated.ctx, populated.job);
    expect(populated.started).toEqual(order.filter((n) => n !== 'uk-past-dates'));

    // EU: its own prefix (the UK past date does not count for EU).
    const eu = setup('EU', 'none');
    await warmUpEurope(eu.ctx, eu.job);
    expect(eu.started).toEqual(order.map((n) => n.replace(/^uk-/, 'eu-')));

    // The date sweep takes its turn: the calendar step runs inside sweepTurns.run(market).
    const turned = setup('UK', 'none');
    const calls: string[] = [];
    const turns: SweepTurns = {
      run: async (who, fn) => { calls.push(who); return fn(); },
      active: () => null,
    };
    await warmUpEurope(turned.ctx, turned.job, { turns });
    expect(calls).toEqual(['uk']);
    expect(turned.finished).toContain('uk-calendar');
  });

  it('warm-up skips the universe rebuild while the last complete build is under 6 days old', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // NOW is 2026-10-28T09:00Z. 5 days 23 h ago: skipped (the weekly cron still rebuilds); the symbol index still loads.
    const recent = setup('UK', 'none');
    recordSourceSuccess(recent.db, 'europe-universe-uk', '2026-10-22T10:00:00.000Z');
    const onStocks = vi.fn();
    await warmUpEurope(recent.ctx, recent.job, { onStocks });
    expect(recent.started).not.toContain('uk-stocks');
    expect(recent.started[0]).toBe('uk-past-dates');
    expect(onStocks).toHaveBeenCalledTimes(1);
    // The other market's build does not count.
    const other = setup('EU', 'none');
    recordSourceSuccess(other.db, 'europe-universe-uk', '2026-10-27T10:00:00.000Z');
    await warmUpEurope(other.ctx, other.job);
    expect(other.started[0]).toBe('eu-stocks');
    // 6 days or older: rebuilt.
    const old = setup('UK', 'none');
    recordSourceSuccess(old.db, 'europe-universe-uk', '2026-10-22T09:00:00.000Z');
    await warmUpEurope(old.ctx, old.job);
    expect(old.started[0]).toBe('uk-stocks');
  });

  it('cron table', () => {
    expect(EUROPE_CRONS).toEqual({
      stocks: '0 5 * * 1',
      pastDates: '0 3 * * 0',
      calendar: { UK: '*/10 * * * *', EU: '3-59/10 * * * *' },
      bulkCalendar: '15 */2 * * *',
      estimates: '20,50 * * * *',
      results: '35 */2 * * *',
      prn: '*/2 6-17 * * 1-5',
      dila: '*/15 7-19 * * *',
      esef: '0 2 * * *',
      secSweep: '25,55 * * * *',
      prevMoves: '40 1 * * *',
      movesSnapshot: '20 16 * * 1-5',
      liveMoves: '* 9-15 * * 1-5',
    });
  });

  it('PR Newswire only 06:00–18:00 London; ESEF warm-up reads 30 days', () => {
    expect(prnHours('2026-10-28T05:59:00.000Z')).toBe(false); // 05:59 GMT
    expect(prnHours('2026-10-28T06:00:00.000Z')).toBe(true);
    expect(prnHours('2026-10-28T17:59:00.000Z')).toBe(true);
    expect(prnHours('2026-10-28T18:00:00.000Z')).toBe(false);
    expect(prnHours('2026-07-01T05:30:00.000Z')).toBe(true); // 06:30 BST
    const s = setup();
    expect(warmEsefSince(s.ctx)).toBe('2026-09-28 09:00:00');
  });

  it('a warm-up waits for the one before it, failed or not', async () => {
    const ran: string[] = [];
    await warmUpEuropeAfter(Promise.reject(new Error('jp failed')), async () => { ran.push('uk'); });
    expect(ran).toEqual(['uk']);
  });
});
