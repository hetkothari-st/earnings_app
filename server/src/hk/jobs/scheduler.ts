import { schedule } from 'node-cron';
import { ET } from '../../domain/marketCalendar.js';
import type { JobRunner } from '../../jobs/scheduler.js';
import { HKT } from '../domain/hkCalendar.js';
import { refreshHkCalendar } from './calendar.js';
import type { HkJobContext } from './context.js';
import { refreshHkEstimates } from './estimates.js';
import { refreshHkLiveMoves, snapshotHkMoves } from './moves.js';
import { computeHkPrevMoves } from './prevMoves.js';
import { refreshHkYahooResults } from './results.js';
import { sweepHkSec } from './secSweep.js';
import { refreshHkStocks } from './stocks.js';

/** Cron expressions in Asia/Hong_Kong, except the two marked ET (US option sessions). */
export const HK_CRONS = {
  stocks: '0 7 * * 1',
  calendar: '*/30 * * * *',
  estimates: '10 * * * *',
  results: '15,45 * * * *',
  secSweep: '20,50 * * * *',
  /** ~50 Yahoo past-date calls per run: nightly only (plus the warm-up). */
  prevMoves: '30 1 * * *',
  /** ET */
  movesSnapshot: '20 16 * * 1-5',
  /** ET */
  liveMoves: '* 9-15 * * 1-5',
} as const;

export interface HkSchedulerHooks {
  onResults?: (ids: number[]) => void;
  onMoves?: (ids: number[]) => void;
}

/** HK jobs. Each job name (prefixed `hk-`) is guarded against overlapping runs by `job`. */
export function startHkScheduler(ctx: HkJobContext, job: JobRunner, hooks: HkSchedulerHooks = {}): void {
  const hkt = { timezone: HKT };
  const et = { timezone: ET };
  const withIds = (fn: () => Promise<number[]>, hook?: (ids: number[]) => void) => async () => {
    const ids = await fn();
    if (ids.length) hook?.(ids);
  };

  schedule(HK_CRONS.stocks, job('hk-stocks', () => refreshHkStocks(ctx)), hkt);
  schedule(HK_CRONS.calendar, job('hk-calendar', () => refreshHkCalendar(ctx)), hkt);
  schedule(HK_CRONS.estimates, job('hk-estimates', () => refreshHkEstimates(ctx)), hkt);
  schedule(HK_CRONS.results, job('hk-results', withIds(() => refreshHkYahooResults(ctx), hooks.onResults)), hkt);
  if (ctx.secHttp) schedule(HK_CRONS.secSweep, job('hk-sec-sweep', withIds(() => sweepHkSec(ctx), hooks.onResults)), hkt);
  schedule(HK_CRONS.prevMoves, job('hk-prev-moves', () => computeHkPrevMoves(ctx)), hkt);
  schedule(HK_CRONS.movesSnapshot, job('hk-moves', withIds(() => snapshotHkMoves(ctx), hooks.onMoves)), et);
  schedule(HK_CRONS.liveMoves, job('hk-live-moves', withIds(() => refreshHkLiveMoves(ctx), hooks.onMoves)), et);
}

/** On start: the universe first (everything depends on it), then calendar, results, SEC sweep, estimates, previous moves. */
export async function warmUpHk(ctx: HkJobContext, job: JobRunner): Promise<void> {
  await job('hk-stocks', () => refreshHkStocks(ctx))();
  await job('hk-calendar', () => refreshHkCalendar(ctx))();
  await job('hk-results', async () => { await refreshHkYahooResults(ctx); })();
  await job('hk-sec-sweep', async () => { await sweepHkSec(ctx); })();
  await job('hk-estimates', () => refreshHkEstimates(ctx))();
  await job('hk-prev-moves', () => computeHkPrevMoves(ctx))();
  // Provisional expected moves now, not only at the next 16:20 ET snapshot.
  await job('hk-moves', async () => { await snapshotHkMoves(ctx); })();
}
