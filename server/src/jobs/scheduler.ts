import { schedule } from 'node-cron';
import { recordSourceError } from '../db/repo.js';
import { CalendarCoverageError, ET } from '../domain/marketCalendar.js';
import type { JobContext } from './context.js';
import { refreshCalendar } from './refreshCalendar.js';
import { refreshResults } from './refreshResults.js';
import { computePrevMoves } from './prevMoves.js';
import { refreshSectors } from './sectors.js';
import { secSync } from './secSync.js';
import { snapshotMoves } from './snapshotMoves.js';

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
export function startScheduler(ctx: JobContext): void {
  const job = createJobRunner(ctx);
  const opts = { timezone: ET };
  const results = job('results', () => refreshResults(ctx));

  schedule('0 */2 * * *', job('calendar', () => refreshCalendar(ctx).then(() => snapshotMoves(ctx))), opts);
  schedule('*/30 6-10 * * 1-5', results, opts);
  schedule('*/30 16-19 * * 1-5', results, opts);
  schedule('0 20 * * 1-5', results, opts);
  schedule('20 16 * * 1-5', job('moves', () => snapshotMoves(ctx)), opts);
  schedule('0 23 * * *', job('sec', () => secSync(ctx).then(() => refreshSectors(ctx)).then(() => computePrevMoves(ctx))), opts);
}
