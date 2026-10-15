import { previousReport, reportsNeedingPrevMove, setPrevMove } from '../db/repo.js';
import { addDays } from '../domain/marketCalendar.js';
import { reactionMove } from '../domain/reactionMove.js';
import { type JobContext, track } from './context.js';

/** For recent and upcoming reports: how the stock reacted to its previous report. */
export async function computePrevMoves(ctx: JobContext): Promise<void> {
  const today = ctx.today();
  const recheckBefore = new Date(Date.parse(ctx.now()) - 20 * 3_600_000).toISOString();
  for (const r of reportsNeedingPrevMove(ctx.db, addDays(today, -7), addDays(today, 30), recheckBefore)) {
    const prev = previousReport(ctx.db, r.symbolKey, r.reportDate);
    if (!prev || prev.timing === 'UNKNOWN') {
      setPrevMove(ctx.db, r.id, null, prev?.reportDate ?? null, ctx.now());
      continue;
    }
    const closes = await track(ctx, 'nasdaq-prices', () =>
      ctx.sources.dailyCloses(r.symbol, addDays(prev.reportDate, -10), addDays(prev.reportDate, 10)));
    if (!closes) continue; // fetch failed: retry next run
    setPrevMove(ctx.db, r.id, reactionMove(closes, prev.reportDate, prev.timing), prev.reportDate, ctx.now());
  }
}
