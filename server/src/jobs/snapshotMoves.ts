import { reportsForSnapshot, saveExpectedMove } from '../db/repo.js';
import { computeExpectedMove } from '../domain/expectedMove.js';
import { isTradingDay, nextTradingDay } from '../domain/marketCalendar.js';
import { type JobContext, track } from './context.js';

/** Runs after the close (spec 7: 4:20 PM ET): today's AMC + next session's BMO/DMH/unknown. */
export async function snapshotMoves(ctx: JobContext): Promise<void> {
  const today = ctx.today();
  if (!isTradingDay(today)) return;
  for (const t of reportsForSnapshot(ctx.db, today, nextTradingDay(today))) {
    const chain = await track(ctx, 'cboe', () => ctx.sources.optionChain(t.symbol));
    if (!chain) continue;
    if (chain.asOfDate !== today) {
      // Delayed feed not yet rolled to today's close: pricing off a stale close would be wrong.
      await track(ctx, 'cboe', async () => { throw new Error(`${t.symbol} quotes not from ${today} (as of ${chain.asOfDate ?? 'unknown'})`); });
      continue;
    }
    const em = computeExpectedMove(chain, t.reportDate, t.timing);
    if (em) saveExpectedMove(ctx.db, t.id, { ...em, optionsVolume: chain.totalVolume ?? null }, ctx.now());
  }
}
