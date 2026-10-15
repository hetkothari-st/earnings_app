import { schedule } from 'node-cron';
import { ET } from '../domain/marketCalendar.js';
import type { JobContext } from './context.js';
import { refreshCalendar } from './refreshCalendar.js';
import { refreshResults } from './refreshResults.js';
import { secSync } from './secSync.js';
import { snapshotMoves } from './snapshotMoves.js';

/** Spec section 7. All cron expressions are evaluated in America/New_York. */
export function startScheduler(ctx: JobContext): void {
  const running = new Set<string>();
  const job = (name: string, fn: () => Promise<void>) => async () => {
    if (running.has(name)) return; // previous run still going
    running.add(name);
    const started = Date.now();
    try {
      await fn();
      console.log(`[job ${name}] done in ${Math.round((Date.now() - started) / 1000)}s`);
    } catch (err) {
      console.error(`[job ${name}]`, err);
    } finally {
      running.delete(name);
    }
  };
  const opts = { timezone: ET };
  const results = job('results', () => refreshResults(ctx));

  schedule('0 */2 * * *', job('calendar', () => refreshCalendar(ctx)), opts);
  schedule('*/30 6-10 * * 1-5', results, opts);
  schedule('*/30 16-19 * * 1-5', results, opts);
  schedule('0 20 * * 1-5', results, opts);
  schedule('20 16 * * 1-5', job('moves', () => snapshotMoves(ctx)), opts);
  schedule('0 23 * * *', job('sec', () => secSync(ctx)), opts);
}
