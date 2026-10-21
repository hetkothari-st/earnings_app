import { schedule } from 'node-cron';
import { recordSourceError, recordSourceSuccess } from '../../db/repo.js';
import type { JobRunner } from '../../jobs/scheduler.js';
import { addDaysIST, holidaysUnknown } from '../domain/nseCalendar.js';
import { refreshInCalendar } from './calendar.js';
import type { InJobContext } from './context.js';
import { refreshInEstimates } from './estimates.js';
import { refreshInLiveMoves, snapshotInMoves } from './moves.js';
import { computeInPrevMoves } from './prevMoves.js';
import { refreshInResults } from './results.js';
import { refreshInShares } from '../../jobs/shares.js';
import { loadFoCache, refreshInStocks } from './stocks.js';

const IST = 'Asia/Kolkata';

export interface InSchedulerHooks {
  onResults?: (ids: number[]) => void;
  onMoves?: (ids: number[]) => void;
  /** Daily Kite login (and the admin "Log in now"); resolves when done. */
  login?: () => Promise<void>;
}

/** Ruling 5: the 2027 NSE holiday list is not in the app yet; say so on the status page ahead of time. */
export function checkHolidayCoverage(ctx: InJobContext): void {
  if (holidaysUnknown(addDaysIST(ctx.todayIST(), 60))) {
    recordSourceError(ctx.db, 'nse-holidays', 'NSE holiday list for 2027 not added yet: weekends only', ctx.now());
  } else {
    recordSourceSuccess(ctx.db, 'nse-holidays', ctx.now());
  }
}

/** India jobs, all on IST. Each job name is guarded against overlapping runs by `job`. */
export function startInScheduler(ctx: InJobContext, job: JobRunner, hooks: InSchedulerHooks = {}): void {
  const opts = { timezone: IST };
  const results = job('india-results', async () => {
    const ids = await refreshInResults(ctx);
    if (ids.length) hooks.onResults?.(ids);
  });
  const live = job('india-live-moves', async () => {
    const ids = await refreshInLiveMoves(ctx);
    if (ids.length) hooks.onMoves?.(ids);
  });

  if (hooks.login) schedule('45 7 * * *', job('india-kite-login', hooks.login), opts);
  schedule('30 7 * * *', job('india-stocks', async () => { await refreshInStocks(ctx); checkHolidayCoverage(ctx); }), opts);
  schedule('*/30 * * * *', job('india-calendar', () => refreshInCalendar(ctx)), opts);
  // Results come out at any hour, weekends included; the feeds are read every minute 08:00–23:59.
  schedule('* 8-23 * * *', results, opts);
  schedule('25 15 * * 1-5', job('india-moves', () => snapshotInMoves(ctx)), opts);
  schedule('* 9-15 * * 1-5', live, opts);
  schedule('0 6,13,19 * * *', job('india-estimates', () => refreshInEstimates(ctx)), opts);
  schedule('0 7 * * *', job('india-shares', () => refreshInShares(ctx)), opts);
  schedule('30 0,8 * * *', job('india-prev-moves', () => computeInPrevMoves(ctx)), opts);
}

/** On start: universe first (everything else depends on it), then the rest. */
export async function warmUpIndia(ctx: InJobContext, job: JobRunner): Promise<void> {
  loadFoCache(ctx.db);
  checkHolidayCoverage(ctx);
  await job('india-stocks', () => refreshInStocks(ctx))();
  await job('india-calendar', () => refreshInCalendar(ctx))();
  await job('india-results', async () => { await refreshInResults(ctx); })();
  await job('india-prev-moves', () => computeInPrevMoves(ctx))();
  await job('india-estimates', () => refreshInEstimates(ctx))();
  await job('india-shares', () => refreshInShares(ctx))();
}
