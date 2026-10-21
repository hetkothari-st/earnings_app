import { reportsForSnapshot, saveExpectedMove } from '../db/repo.js';
import { computeExpectedMove } from '../domain/expectedMove.js';
import { addDays, prevTradingDay } from '../domain/marketCalendar.js';
import type { Timing } from '../types.js';
import { type JobContext, guarded } from './context.js';

/** The last regular close before the release: BMO/DMH/unknown -> previous session, AMC -> report day. */
function lastCloseBefore(reportDate: string, timing: Timing): string {
  return timing === 'AMC' ? reportDate : prevTradingDay(reportDate);
}

/**
 * Expected move for reports in the next week. Quotes from the last close before the release give the final
 * value; an earlier close gives a provisional one that later runs replace. Quotes from after the release
 * are never used, and a final value is never overwritten.
 */
export async function snapshotMoves(ctx: JobContext, days = 7): Promise<void> {
  const today = ctx.today();
  for (const t of reportsForSnapshot(ctx.db, today, addDays(today, days))) {
    const chain = (await guarded(ctx, { name: 'cboe', run: () => ctx.sources.optionChain(t.symbol) }))?.value;
    if (!chain?.asOfDate) continue;
    const target = lastCloseBefore(t.reportDate, t.timing);
    if (chain.asOfDate > target) continue;                       // release already priced in
    if (t.quoteDate && chain.asOfDate <= t.quoteDate) continue;   // nothing newer than what we have
    const em = computeExpectedMove(chain, t.reportDate, t.timing);
    if (em) {
      saveExpectedMove(ctx.db, t.id, {
        ...em, optionsVolume: chain.totalVolume ?? null, provisional: chain.asOfDate < target, quoteDate: chain.asOfDate,
      }, ctx.now());
    }
  }
}
