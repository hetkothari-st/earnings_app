import { reportsInRange, saveLiveMove } from '../db/repo.js';
import { computeExpectedMove } from '../domain/expectedMove.js';
import { addDays, prevTradingDay } from '../domain/marketCalendar.js';
import type { Timing } from '../types.js';
import { type JobContext, track } from './context.js';

/** Last regular close before the release: AMC -> report day, otherwise the previous session. */
const lastCloseBefore = (reportDate: string, timing: Timing) => (timing === 'AMC' ? reportDate : prevTradingDay(reportDate));

/**
 * Intraday expected move for reports whose release is still ahead of today's close (AMC today,
 * BMO/DMH/unknown next session). After the release the options reprice, so tracking stops.
 * Returns the ids whose value changed, for the live push.
 */
export async function refreshLiveMoves(ctx: JobContext): Promise<number[]> {
  const today = ctx.today();
  const changed: number[] = [];
  for (const r of reportsInRange(ctx.db, today, addDays(today, 4))) {
    if (lastCloseBefore(r.reportDate, r.timing) !== today) continue;
    const chain = await track(ctx, 'cboe', () => ctx.sources.optionChain(r.symbol));
    if (!chain) continue;
    const em = computeExpectedMove(chain, r.reportDate, r.timing);
    if (!em) continue;
    if (saveLiveMove(ctx.db, r.id, { movePct: em.movePct, illiquid: em.illiquid, quoteTime: chain.quoteTime ?? null }, ctx.now())) {
      changed.push(r.id);
    }
  }
  return changed;
}
