import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '../../src/db/repo.js';
import type { JobContext } from '../../src/jobs/context.js';
import { createJobRunner, type JobRunner } from '../../src/jobs/scheduler.js';
import { upsertJpPastDates } from '../../src/jp/db/jpRepo.js';
import { JP_DATE_SWEEP } from '../../src/jp/jobs/calendar.js';
import type { JpJobContext } from '../../src/jp/jobs/context.js';
import { JP_CRONS, JP_DATE_SWEEP_PEAK, jpDateSweepPerRun, warmUpJp } from '../../src/jp/jobs/scheduler.js';

afterEach(() => { vi.restoreAllMocks(); });

const down = async (): Promise<never> => { throw new Error('source down'); };

function setup() {
  const db = openDb(':memory:');
  const now = '2026-10-27T04:00:00.000Z';
  const ctx: JpJobContext = {
    db, now: () => now, todayJST: () => '2026-10-27',
    yahooCalendar: down, yahooSummary: down, yahooQuotes: down, yahooCloses: down, edinetCodeList: down,
    edinet: null, optionChain: async () => null,
    secHttp: null, // no SEC_USER_AGENT: the sweep does nothing, the rest still runs
    tierA: () => [],
  };
  const inner = createJobRunner({ db, now: () => now } as unknown as JobContext);
  const started: string[] = [];
  const finished: string[] = [];
  const job: JobRunner = (name, fn) => inner(name, async () => {
    started.push(name);
    if (name === 'jp-calendar') throw new Error('calendar exploded');
    await fn();
    finished.push(name);
  });
  return { db, ctx, job, started, finished };
}

describe('Japan scheduler', () => {
  it('warm-up runs in order, skips pastDates when populated, survives a failing source', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const order = ['jp-stocks', 'jp-past-dates', 'jp-calendar', 'jp-bulk-calendar', 'jp-results', 'jp-sec-sweep', 'jp-edinet', 'jp-estimates',
      'jp-prev-moves', 'jp-moves'];

    const empty = setup();
    const onStocks = vi.fn();
    await warmUpJp(empty.ctx, empty.job, { onStocks });
    expect(empty.started).toEqual(order);
    expect(empty.finished).toEqual(order.filter((n) => n !== 'jp-calendar'));
    expect(errors).toHaveBeenCalledWith('[job jp-calendar]', expect.any(Error));
    expect(onStocks).toHaveBeenCalledTimes(1);

    const populated = setup();
    upsertJpPastDates(populated.db, [{ code: '7203', date: '2026-08-04', timing: null }]);
    await warmUpJp(populated.ctx, populated.job);
    expect(populated.started).toEqual(order.filter((n) => n !== 'jp-past-dates'));
  });

  it('cron table', () => {
    expect(JP_CRONS).toEqual({
      stocks: '0 6 * * 1',
      pastDates: '0 3 * * 0',
      calendar: '*/10 * * * *',
      bulkCalendar: '5 */2 * * *',
      estimates: '20 * * * *',
      results: '25 */2 * * *',
      edinetToday: '*/30 9-19 * * 1-5',
      edinetBackfill: '0 2 * * *',
      secSweep: '20,50 * * * *',
      prevMoves: '30 1 * * *',
      movesSnapshot: '20 16 * * 1-5',
      liveMoves: '* 9-15 * * 1-5',
    });
    // The rolling date sweep runs at the cadence its per-run size was chosen for.
    expect(JP_DATE_SWEEP.everyMs).toBe(10 * 60_000);
  });

  it('the date sweep takes more codes per run in the reporting seasons', () => {
    expect(jpDateSweepPerRun('2026-10-27')).toBe(JP_DATE_SWEEP_PEAK.perRun);
    expect(jpDateSweepPerRun('2027-02-10')).toBe(JP_DATE_SWEEP_PEAK.perRun);
    expect(jpDateSweepPerRun('2027-05-14')).toBe(JP_DATE_SWEEP_PEAK.perRun);
    expect(jpDateSweepPerRun('2027-08-05')).toBe(JP_DATE_SWEEP_PEAK.perRun);
    expect(jpDateSweepPerRun('2026-12-15')).toBe(JP_DATE_SWEEP.perRun);
    expect(jpDateSweepPerRun('2027-03-25')).toBe(JP_DATE_SWEEP.perRun);
    expect(jpDateSweepPerRun('2027-06-25')).toBe(JP_DATE_SWEEP.perRun);
    // Even at the peak size the sweep is a small share of the 1 request/s Japan Yahoo budget.
    expect(JP_DATE_SWEEP_PEAK.perRun / (JP_DATE_SWEEP.everyMs / 1000)).toBeLessThanOrEqual(0.2);
  });
});
