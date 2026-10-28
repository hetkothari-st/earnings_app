import { DateTime } from 'luxon';
import { schedule } from 'node-cron';
import { ET } from '../../domain/marketCalendar.js';
import type { JobRunner } from '../../jobs/scheduler.js';
import { europeDateSweepPerRun, type SweepTurns } from '../../sources/sweepTurns.js';
import { europePastDatesCount } from '../db/europeRepo.js';
import { refreshEuropeBulkCalendar, refreshEuropeCalendar } from './calendar.js';
import type { EuropeJobContext } from './context.js';
import { esefSinceFor, refreshEsefResults } from './esefResults.js';
import { refreshEuropeEstimates } from './estimates.js';
import { refreshEuropeLiveMoves, snapshotEuropeMoves } from './moves.js';
import { refreshEuropePastDates } from './pastDates.js';
import { computeEuropePrevMoves } from './prevMoves.js';
import { refreshEuropeYahooResults } from './results.js';
import { sweepEuropeSec } from './secSweep.js';
import { refreshDilaSignals, refreshPrnSignals } from './signals.js';
import { refreshEuropeStocks } from './stocks.js';

const LONDON = 'Europe/London';
const PARIS = 'Europe/Paris';

/** Cron expressions in Europe/London (UK) or Europe/Paris (EU), except where marked. */
export const EUROPE_CRONS = {
  /** Weekly universe, names and caps (and the gov.uk holidays for UK). */
  stocks: '0 5 * * 1',
  pastDates: '0 3 * * 0',
  /** The rolling date sweep every 10 min; EU 3 minutes after UK so their turns rarely queue. */
  calendar: { UK: '*/10 * * * *', EU: '3-59/10 * * * *' },
  bulkCalendar: '15 */2 * * *',
  estimates: '20,50 * * * *',
  results: '35 */2 * * *',
  /** London, weekdays; the job also checks 06:00–18:00 London itself. */
  prn: '*/2 6-17 * * 1-5',
  /** Paris; EU only. */
  dila: '*/15 7-19 * * *',
  /** since = the last seen date_added (less the margin), else today − 30. */
  esef: '0 2 * * *',
  /** Only with the SEC client. */
  secSweep: '25,55 * * * *',
  prevMoves: '40 1 * * *',
  /** ET */
  movesSnapshot: '20 16 * * 1-5',
  /** ET */
  liveMoves: '* 9-15 * * 1-5',
} as const;

/** The warm-up reads ESEF filings added this many days back (or from an older cursor). */
const WARM_ESEF_DAYS = 30;

export interface EuropeSchedulerHooks {
  /** Report ids whose results changed. PR Newswire runs over both markets, so its ids may be the other market's. */
  onResults?: (ids: number[]) => void;
  onMoves?: (ids: number[]) => void;
  /** The universe was refreshed (the watchlist symbol index reloads the market). */
  onStocks?: () => void;
  /** The date-sweep turn-taker (tests); default the process-wide `sweepTurns`. */
  turns?: SweepTurns;
}

const withIds = (fn: () => Promise<number[]>, hook?: (ids: number[]) => void) => async () => {
  const ids = await fn();
  if (ids.length) hook?.(ids);
};

const prefix = (ctx: EuropeJobContext) => (ctx.market === 'UK' ? 'uk' : 'eu');

/** 06:00–18:00 London: PR Newswire results releases come in UK/EU business hours. */
export function prnHours(nowIso: string): boolean {
  const h = DateTime.fromISO(nowIso, { zone: 'utc' }).setZone(LONDON).hour;
  return h >= 6 && h < 18;
}

function jobs(ctx: EuropeJobContext, hooks: EuropeSchedulerHooks) {
  return {
    stocks: async () => { await refreshEuropeStocks(ctx); hooks.onStocks?.(); },
    pastDates: async () => { await refreshEuropePastDates(ctx); },
    // Inside the date-sweep turn (refreshEuropeCalendar takes it), so JP, UK and EU never sweep side by side.
    calendar: () => refreshEuropeCalendar(ctx, { perRun: europeDateSweepPerRun(ctx.market, ctx.today()), turns: hooks.turns }),
    bulkCalendar: () => refreshEuropeBulkCalendar(ctx),
    estimates: () => refreshEuropeEstimates(ctx),
    results: withIds(() => refreshEuropeYahooResults(ctx), hooks.onResults),
    prn: withIds(async () => (prnHours(ctx.now()) ? refreshPrnSignals(ctx) : []), hooks.onResults),
    dila: withIds(() => refreshDilaSignals(ctx), hooks.onResults),
    esef: (since: string) => withIds(() => refreshEsefResults(ctx, since), hooks.onResults),
    secSweep: withIds(() => sweepEuropeSec(ctx), hooks.onResults),
    prevMoves: () => computeEuropePrevMoves(ctx),
    movesSnapshot: withIds(() => snapshotEuropeMoves(ctx), hooks.onMoves),
    liveMoves: withIds(() => refreshEuropeLiveMoves(ctx), hooks.onMoves),
  };
}

/**
 * One market's jobs (call once for UK, once for EU). Job names are prefixed `uk-` / `eu-`, each guarded against
 * overlapping runs by `job`.
 */
export function startEuropeScheduler(ctx: EuropeJobContext, job: JobRunner, hooks: EuropeSchedulerHooks = {}): void {
  const p = prefix(ctx);
  const local = { timezone: ctx.market === 'UK' ? LONDON : PARIS };
  const london = { timezone: LONDON };
  const paris = { timezone: PARIS };
  const et = { timezone: ET };
  const j = jobs(ctx, hooks);

  schedule(EUROPE_CRONS.stocks, job(`${p}-stocks`, j.stocks), local);
  schedule(EUROPE_CRONS.pastDates, job(`${p}-past-dates`, j.pastDates), local);
  schedule(EUROPE_CRONS.calendar[ctx.market], job(`${p}-calendar`, j.calendar), local);
  schedule(EUROPE_CRONS.bulkCalendar, job(`${p}-bulk-calendar`, j.bulkCalendar), local);
  schedule(EUROPE_CRONS.estimates, job(`${p}-estimates`, j.estimates), local);
  schedule(EUROPE_CRONS.results, job(`${p}-results`, j.results), local);
  schedule(EUROPE_CRONS.prn, job(`${p}-prn`, j.prn), london);
  if (ctx.market === 'EU' && ctx.dila) schedule(EUROPE_CRONS.dila, job(`${p}-dila`, j.dila), paris);
  schedule(EUROPE_CRONS.esef, job(`${p}-esef`, () => j.esef(esefSinceFor(ctx))()), local);
  if (ctx.secHttp) schedule(EUROPE_CRONS.secSweep, job(`${p}-sec-sweep`, j.secSweep), local);
  schedule(EUROPE_CRONS.prevMoves, job(`${p}-prev-moves`, j.prevMoves), local);
  schedule(EUROPE_CRONS.movesSnapshot, job(`${p}-moves`, j.movesSnapshot), et);
  schedule(EUROPE_CRONS.liveMoves, job(`${p}-live-moves`, j.liveMoves), et);
}

/** The ESEF `since` of the warm-up: 30 days back, or the cursor (less its margin) when that is older. */
export function warmEsefSince(ctx: EuropeJobContext): string {
  const cursor = esefSinceFor(ctx);
  const days = DateTime.fromISO(ctx.now(), { zone: 'utc' }).minus({ days: WARM_ESEF_DAYS }).toFormat('yyyy-MM-dd HH:mm:ss');
  return cursor < days ? cursor : days;
}

/**
 * On start: the universe first, past dates only while none are stored, the date sweep and its bulk supplement, Yahoo
 * results, the SEC sweep, ESEF (30 days), estimates, previous moves and the moves snapshot. Each step runs under the
 * job runner, which never throws: a failing source is recorded and the next step runs.
 */
export async function warmUpEurope(ctx: EuropeJobContext, job: JobRunner, hooks: EuropeSchedulerHooks = {}): Promise<void> {
  const p = prefix(ctx);
  const j = jobs(ctx, hooks);
  await job(`${p}-stocks`, j.stocks)();
  if (europePastDatesCount(ctx.db, ctx.market) === 0) await job(`${p}-past-dates`, j.pastDates)();
  await job(`${p}-calendar`, j.calendar)();
  await job(`${p}-bulk-calendar`, j.bulkCalendar)();
  await job(`${p}-results`, j.results)();
  await job(`${p}-sec-sweep`, j.secSweep)();
  await job(`${p}-esef`, () => j.esef(warmEsefSince(ctx))())();
  await job(`${p}-estimates`, j.estimates)();
  await job(`${p}-prev-moves`, j.prevMoves)();
  await job(`${p}-moves`, j.movesSnapshot)();
}

/** A warm-up that starts once `before` settles, failed or not (UK after Japan, EU after UK). */
export function warmUpEuropeAfter(before: Promise<unknown>, run: () => Promise<void>): Promise<void> {
  return before.catch(() => {}).then(run);
}
