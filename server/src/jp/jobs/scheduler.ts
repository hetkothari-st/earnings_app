import { schedule } from 'node-cron';
import { ET } from '../../domain/marketCalendar.js';
import type { JobRunner } from '../../jobs/scheduler.js';
import { jpPastDatesCount } from '../db/jpRepo.js';
import { JST } from '../domain/jpCalendar.js';
import { JP_DATE_SWEEP, refreshJpBulkCalendar, refreshJpCalendar } from './calendar.js';
import type { JpJobContext } from './context.js';
import { jpEdinetDates, refreshJpEdinet } from './edinetResults.js';
import { refreshJpEstimates } from './estimates.js';
import { refreshJpLiveMoves, snapshotJpMoves } from './moves.js';
import { refreshJpPastDates } from './pastDates.js';
import { computeJpPrevMoves } from './prevMoves.js';
import { refreshJpYahooResults } from './results.js';
import { sweepJpSec } from './secSweep.js';
import { refreshJpStocks } from './stocks.js';

/** Cron expressions in Asia/Tokyo, except the two marked ET (US option sessions). */
export const JP_CRONS = {
  /** EDINET code list and weekly batch quotes (name, cap). */
  stocks: '0 6 * * 1',
  /** Bulk past-dates sweep (Ruling 10: weekly). */
  pastDates: '0 3 * * 0',
  /** The rolling per-symbol date sweep, every `JP_DATE_SWEEP.everyMs` (10 min). */
  calendar: '*/10 * * * *',
  /** The bulk calendar supplement (Ruling 10: every 2 h). */
  bulkCalendar: '5 */2 * * *',
  estimates: '20 * * * *',
  /** Yahoo "results out", every 2 h (summaries are reused for `JP_RESULTS_MAX_AGE_MS`, 100 min). */
  results: '25 */2 * * *',
  /** EDINET today's list every 30 min 09:00–19:59 on weekdays; the last 7 days nightly (Ruling 13). */
  edinetToday: '*/30 9-19 * * 1-5',
  edinetBackfill: '0 2 * * *',
  /** Only with the SEC client. */
  secSweep: '20,50 * * * *',
  prevMoves: '30 1 * * *',
  /** ET */
  movesSnapshot: '20 16 * * 1-5',
  /** ET */
  liveMoves: '* 9-15 * * 1-5',
} as const;

/**
 * In the reporting seasons (most of the ~3,800 TSE companies report between the 20th of the month after a quarter
 * end and the 20th of the next) far more codes are near-term and due every 6 h, so the sweep takes more codes per
 * run: 90 per 10 min is 0.15 request/s, still a small share of the 1 request/s Japan Yahoo budget.
 */
export const JP_DATE_SWEEP_PEAK = {
  perRun: 90,
  /** [from, to] as MM-DD, inclusive. */
  windows: [['01-20', '02-20'], ['04-20', '05-20'], ['07-20', '08-20'], ['10-20', '11-20']] as const,
} as const;

/** Codes per date-sweep run on the JST date `today`. */
export function jpDateSweepPerRun(today: string): number {
  const md = today.slice(5);
  return JP_DATE_SWEEP_PEAK.windows.some(([from, to]) => md >= from && md <= to) ? JP_DATE_SWEEP_PEAK.perRun : JP_DATE_SWEEP.perRun;
}

export interface JpSchedulerHooks {
  onResults?: (ids: number[]) => void;
  onMoves?: (ids: number[]) => void;
  /** The universe was refreshed (the watchlist symbol index reloads Japan). */
  onStocks?: () => void;
}

const withIds = (fn: () => Promise<number[]>, hook?: (ids: number[]) => void) => async () => {
  const ids = await fn();
  if (ids.length) hook?.(ids);
};

const stocksJob = (ctx: JpJobContext, hooks: JpSchedulerHooks) => async () => {
  await refreshJpStocks(ctx);
  hooks.onStocks?.();
};

const calendarJob = (ctx: JpJobContext) => () => refreshJpCalendar(ctx, { perRun: jpDateSweepPerRun(ctx.todayJST()) });

/**
 * Japan jobs. Each job name (prefixed `jp-`) is guarded against overlapping runs by `job`; both EDINET schedules
 * share the name `jp-edinet`, so a document is never handled by two runs at once.
 */
export function startJpScheduler(ctx: JpJobContext, job: JobRunner, hooks: JpSchedulerHooks = {}): void {
  const jst = { timezone: JST };
  const et = { timezone: ET };

  schedule(JP_CRONS.stocks, job('jp-stocks', stocksJob(ctx, hooks)), jst);
  schedule(JP_CRONS.pastDates, job('jp-past-dates', async () => { await refreshJpPastDates(ctx); }), jst);
  schedule(JP_CRONS.calendar, job('jp-calendar', calendarJob(ctx)), jst);
  schedule(JP_CRONS.bulkCalendar, job('jp-bulk-calendar', () => refreshJpBulkCalendar(ctx)), jst);
  schedule(JP_CRONS.estimates, job('jp-estimates', () => refreshJpEstimates(ctx)), jst);
  schedule(JP_CRONS.results, job('jp-results', withIds(() => refreshJpYahooResults(ctx), hooks.onResults)), jst);
  schedule(JP_CRONS.edinetToday, job('jp-edinet', withIds(() => refreshJpEdinet(ctx, jpEdinetDates(ctx.todayJST(), 'today')), hooks.onResults)), jst);
  schedule(JP_CRONS.edinetBackfill, job('jp-edinet', withIds(() => refreshJpEdinet(ctx, jpEdinetDates(ctx.todayJST(), 'backfill')), hooks.onResults)), jst);
  if (ctx.secHttp) schedule(JP_CRONS.secSweep, job('jp-sec-sweep', withIds(() => sweepJpSec(ctx), hooks.onResults)), jst);
  schedule(JP_CRONS.prevMoves, job('jp-prev-moves', () => computeJpPrevMoves(ctx)), jst);
  schedule(JP_CRONS.movesSnapshot, job('jp-moves', withIds(() => snapshotJpMoves(ctx), hooks.onMoves)), et);
  schedule(JP_CRONS.liveMoves, job('jp-live-moves', withIds(() => refreshJpLiveMoves(ctx), hooks.onMoves)), et);
}

/**
 * On start: the universe first (everything depends on it), past dates only while none are stored, the date sweep
 * and its bulk supplement, Yahoo results, the SEC sweep, the EDINET 7-day backfill, estimates, previous moves, and
 * provisional expected moves (HK lesson: not only at the next 16:20 ET snapshot). Every Yahoo call goes through the
 * one Japan client (≤ 1 request/s), so the warm-up never adds to the rate, only to the queue.
 */
export async function warmUpJp(ctx: JpJobContext, job: JobRunner, hooks: JpSchedulerHooks = {}): Promise<void> {
  await job('jp-stocks', stocksJob(ctx, hooks))();
  if (jpPastDatesCount(ctx.db) === 0) await job('jp-past-dates', async () => { await refreshJpPastDates(ctx); })();
  await job('jp-calendar', calendarJob(ctx))();
  await job('jp-bulk-calendar', () => refreshJpBulkCalendar(ctx))();
  await job('jp-results', withIds(() => refreshJpYahooResults(ctx), hooks.onResults))();
  await job('jp-sec-sweep', withIds(() => sweepJpSec(ctx), hooks.onResults))();
  await job('jp-edinet', withIds(() => refreshJpEdinet(ctx, jpEdinetDates(ctx.todayJST(), 'backfill')), hooks.onResults))();
  await job('jp-estimates', () => refreshJpEstimates(ctx))();
  await job('jp-prev-moves', () => computeJpPrevMoves(ctx))();
  await job('jp-moves', withIds(() => snapshotJpMoves(ctx), hooks.onMoves))();
}
