import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '../../src/db/repo.js';
import { hkStocks } from '../../src/hk/db/hkRepo.js';
import type { HkJobContext } from '../../src/hk/jobs/context.js';
import { HK_CRONS, warmUpHk } from '../../src/hk/jobs/scheduler.js';
import type { JobContext } from '../../src/jobs/context.js';
import { createJobRunner, type JobRunner } from '../../src/jobs/scheduler.js';

afterEach(() => { vi.restoreAllMocks(); });

describe('HK scheduler', () => {
  it('warm-up runs jobs in order and survives a failing source', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = openDb(':memory:');
    const now = '2026-10-27T04:00:00.000Z';
    const ctx: HkJobContext = {
      db, now: () => now, todayHKT: () => '2026-10-27',
      yahoo: async () => { throw new Error('yahoo down'); },
      yahooPastDates: async () => { throw new Error('yahoo down'); },
      yahooCloses: async () => { throw new Error('yahoo down'); },
      optionChain: async () => null,
      secHttp: null, // no SEC_USER_AGENT: the sweep is skipped, the rest still runs
    };
    const inner = createJobRunner({ db, now: () => now } as unknown as JobContext);
    const started: string[] = [];
    const finished: string[] = [];
    const job: JobRunner = (name, fn) => {
      const run = inner(name, async () => {
        started.push(name);
        if (name === 'hk-calendar') throw new Error('calendar exploded');
        await fn();
        finished.push(name);
      });
      return run;
    };
    await warmUpHk(ctx, job);
    expect(started).toEqual(['hk-stocks', 'hk-calendar', 'hk-results', 'hk-sec-sweep', 'hk-estimates', 'hk-prev-moves']);
    expect(finished).toEqual(['hk-stocks', 'hk-results', 'hk-sec-sweep', 'hk-estimates', 'hk-prev-moves']);
    expect(errors).toHaveBeenCalledWith('[job hk-calendar]', expect.any(Error));
    expect(hkStocks(db).length).toBeGreaterThan(90); // the universe is in even though Yahoo is down
  });

  it('cron table', () => {
    expect(HK_CRONS).toEqual({
      stocks: '0 7 * * 1', calendar: '*/30 * * * *', estimates: '10 * * * *', results: '15,45 * * * *',
      secSweep: '20,50 * * * *', prevMoves: '30 1 * * *', movesSnapshot: '20 16 * * 1-5', liveMoves: '* 9-15 * * 1-5',
    });
  });
});
