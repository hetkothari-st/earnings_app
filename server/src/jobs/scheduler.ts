import { schedule } from 'node-cron';
import { recordSourceError } from '../db/repo.js';
import { CalendarCoverageError, ET } from '../domain/marketCalendar.js';
import type { JobContext } from './context.js';
import { refreshCalendar } from './refreshCalendar.js';
import { refreshLiveMoves } from './liveMoves.js';
import { refreshResults } from './refreshResults.js';
import { computePrevMoves } from './prevMoves.js';
import { refreshSectors } from './sectors.js';
import { secSync } from './secSync.js';
import { snapshotMoves } from './snapshotMoves.js';
import { purgeExpiredNotes } from '../notes/store.js';

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

/** Spec section 7. All cron expressions are evaluated in America/New_York. */
export function startScheduler(
  ctx: JobContext,
  onResults: (ids: number[]) => void = () => {},
  onMoves: (ids: number[]) => void = () => {},
): JobRunner {
  const job = createJobRunner(ctx);
  const opts = { timezone: ET };
  const results = job('results', () => refreshResults(ctx).then((ids) => { if (ids.length) onResults(ids); }));

  schedule('0 */2 * * *', job('calendar', () => refreshCalendar(ctx).then(() => snapshotMoves(ctx))), opts);
  // Every minute while releases land (BMO 6:00-10:59, AMC 16:00-19:59 ET), every 30 minutes in between.
  schedule('* 6-10 * * 1-5', results, opts);
  schedule('*/30 11-15 * * 1-5', results, opts);
  schedule('* 16-19 * * 1-5', results, opts);
  schedule('0 20 * * 1-5', results, opts);
  schedule('20 16 * * 1-5', job('moves', () => snapshotMoves(ctx)), opts);
  // Notes are permanently deleted 24 hours after the results; checked every 5 minutes.
  schedule('*/5 * * * *', job('notes', async () => { purgeExpiredNotes(ctx.db, Date.parse(ctx.now())); }), opts);
  // Intraday expected move every 3 minutes through the session (quotes are 15 minutes delayed).
  const live = job('live', () => refreshLiveMoves(ctx).then((ids) => { if (ids.length) onMoves(ids); }));
  schedule('*/3 9-15 * * 1-5', live, opts);
  schedule('0-15/3 16 * * 1-5', live, opts);
  schedule('0 23 * * *', job('sec', () => secSync(ctx).then(() => refreshSectors(ctx)).then(() => computePrevMoves(ctx))), opts);
  return job;
}

/**
 * Warms the cache on start. Each step goes through the same guard as the scheduled jobs, so a step is
 * skipped (not run concurrently) while the scheduled job of that name is still going.
 */
export async function warmUp(ctx: JobContext, job: JobRunner): Promise<void> {
  await job('results', () => refreshResults(ctx).then(() => undefined))();
  await job('calendar', () => refreshCalendar(ctx))();
  await job('sectors', () => refreshSectors(ctx))();
  await job('moves', () => snapshotMoves(ctx))();
  await job('prevMoves', () => computePrevMoves(ctx))();
}
