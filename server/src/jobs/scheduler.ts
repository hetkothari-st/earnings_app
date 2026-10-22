import { schedule } from 'node-cron';
import { recordSourceError } from '../db/repo.js';
import { CalendarCoverageError, ET } from '../domain/marketCalendar.js';
import type { JobContext } from './context.js';
import { refreshCalendar, refreshWatchedEstimates } from './refreshCalendar.js';
import { refreshLiveMoves } from './liveMoves.js';
import { refreshResults } from './refreshResults.js';
import { computePrevMoves } from './prevMoves.js';
import { refreshSectors } from './sectors.js';
import { refreshYahoo } from './yahooFill.js';
import { addDays, prevTradingDay } from '../domain/marketCalendar.js';
import { secSync } from './secSync.js';
import { snapshotMoves } from './snapshotMoves.js';
import { purgeExpiredNotes } from '../notes/store.js';
import { refreshUsShares } from './shares.js';

export type JobRunner = (name: string, fn: () => Promise<void>) => () => Promise<void>;

/** Wraps jobs so that a job never overlaps a still-running job of the same name. Never throws. */
export function createJobRunner(ctx: JobContext): JobRunner {
  const running = new Set<string>();
  return (name, fn) => async () => {
    if (running.has(name)) return; // previous run still going
    running.add(name);
    const started = Date.now();
    try {
      await fn();
      console.log(`[job ${name}] done in ${Math.round((Date.now() - started) / 1000)}s`);
    } catch (err) {
      // A calendar that has run out of years must show up in /api/status, not only in the console.
      if (err instanceof CalendarCoverageError) recordSourceError(ctx.db, 'calendar', err.message, ctx.now());
      console.error(`[job ${name}]`, err);
    } finally {
      running.delete(name);
    }
  };
}

/** Daily share-count refresh (SEC), on the app's one SEC client. Null without SEC_USER_AGENT: the job is skipped. */
export function usSharesJob(ctx: JobContext): (() => Promise<void>) | null {
  const http = ctx.sources.secHttp;
  return http ? () => refreshUsShares(ctx, http) : null;
}

/** Spec section 7 (US), cron expressions in America/New_York. */
export const US_CRONS = {
  /** Next 14 days of the Nasdaq calendar. */
  calendarNear: '*/5 * * * *',
  /** The 90-day calendar refresh. */
  calendarFull: '0 */2 * * *',
  /** Results: every minute 06:00-20:59 on weekdays. */
  results: '* 6-20 * * 1-5',
  /** Yahoo estimates for reports in the next 7 days, then for the rest. */
  yahooNear: '0 * * * *',
  yahooFar: '5 */6 * * *',
  /** Live expected move every minute 09:30-16:15. */
  live: ['30-59 9 * * 1-5', '* 10-15 * * 1-5', '0-15 16 * * 1-5'],
} as const;

/** Spec section 7. All cron expressions are evaluated in America/New_York. */
export function startScheduler(
  ctx: JobContext,
  onResults: (ids: number[]) => void = () => {},
  onMoves: (ids: number[]) => void = () => {},
): JobRunner {
  const job = createJobRunner(ctx);
  const opts = { timezone: ET };
  const results = job('results', async () => {
    const ids = await refreshResults(ctx);
    if (ids.length) onResults(ids);
    // Backup values (foreign listings, lagging sources) for yesterday and today.
    await refreshYahoo(ctx, prevTradingDay(ctx.today()), ctx.today());
  });

  // The calendar covers only the next 14 days every 5 minutes; the 90-day sweep stays every 2 hours.
  schedule(US_CRONS.calendarNear, job('calendar-near', () => refreshCalendar(ctx, 14)), opts);
  schedule(US_CRONS.calendarFull, job('calendar', () => refreshCalendar(ctx).then(() => snapshotMoves(ctx))), opts);
  schedule(US_CRONS.yahooNear, job('yahoo-near', () => refreshYahoo(ctx, ctx.today(), addDays(ctx.today(), 7))), opts);
  schedule(US_CRONS.yahooFar, job('yahoo-far', () => refreshYahoo(ctx, addDays(ctx.today(), 8), addDays(ctx.today(), 90)).then(() => refreshWatchedEstimates(ctx))), opts);
  // Every minute through the whole release window, no midday gap.
  schedule(US_CRONS.results, results, opts);
  schedule('20 16 * * 1-5', job('moves', () => snapshotMoves(ctx)), opts);
  // Notes are permanently deleted 24 hours after the results; checked every 5 minutes.
  schedule('*/5 * * * *', job('notes', async () => { purgeExpiredNotes(ctx.db, Date.parse(ctx.now())); }), opts);
  // Intraday expected move every minute through the session (Cboe quotes are 15 minutes delayed).
  const live = job('live', () => refreshLiveMoves(ctx).then((ids) => { if (ids.length) onMoves(ids); }));
  for (const expr of US_CRONS.live) schedule(expr, live, opts);
  const shares = usSharesJob(ctx);
  if (shares) schedule('0 6 * * *', job('shares', shares), opts);
  schedule('0 23 * * *', job('sec', () => secSync(ctx).then(() => refreshSectors(ctx)).then(() => computePrevMoves(ctx, { from: addDays(ctx.today(), -730) }))), opts);
  return job;
}

/**
 * Warms the cache on start. Each step goes through the same guard as the scheduled jobs, so a step is
 * skipped (not run concurrently) while the scheduled job of that name is still going.
 */
export async function warmUp(ctx: JobContext, job: JobRunner): Promise<void> {
  await job('results', () => refreshResults(ctx).then(() => undefined))();
  await job('calendar', () => refreshCalendar(ctx))();
  // Share counts (live market cap) go first: the options snapshot below takes many minutes.
  const shares = usSharesJob(ctx);
  if (shares) await job('shares', shares)();
  await job('sectors', () => refreshSectors(ctx))();
  await job('moves', () => snapshotMoves(ctx))();
  await job('prevMoves', () => computePrevMoves(ctx))();
}
