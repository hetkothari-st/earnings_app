import { previousReport, reportsNeedingPrevMove, setPrevMove } from '../db/repo.js';
import { addDays, sessionClose } from '../domain/marketCalendar.js';
import { reactionMove } from '../domain/reactionMove.js';
import type { PrevMoveBasis, Timing } from '../types.js';
import { type JobContext, track } from './context.js';

/**
 * Timing to use for the previous report, and how sure we are of it:
 * stored timing -> exact; SEC 8-K accepted after that day's close -> AMC (inferred);
 * otherwise this quarter's timing (assumed). Nothing known -> null.
 */
function resolveTiming(
  prev: { reportDate: string; timing: Timing; secAcceptedAt: string | null },
  current: Timing,
): { timing: Timing; basis: PrevMoveBasis } | null {
  if (prev.timing !== 'UNKNOWN') return { timing: prev.timing, basis: 'known' };
  const a = prev.secAcceptedAt;
  if (a && a.slice(0, 10) === prev.reportDate && a.slice(11, 19) >= `${sessionClose(prev.reportDate)}:00`) {
    return { timing: 'AMC', basis: 'sec-inferred' };
  }
  if (current !== 'UNKNOWN') return { timing: current, basis: 'assumed' };
  return null;
}

/** For recent and upcoming reports: how the stock reacted to its previous report. */
export async function computePrevMoves(ctx: JobContext): Promise<void> {
  const today = ctx.today();
  const recheckBefore = new Date(Date.parse(ctx.now()) - 20 * 3_600_000).toISOString();
  for (const r of reportsNeedingPrevMove(ctx.db, addDays(today, -7), addDays(today, 30), recheckBefore)) {
    const prev = previousReport(ctx.db, r.symbolKey, r.reportDate);
    const resolved = prev ? resolveTiming(prev, r.timing) : null;
    if (!prev || !resolved) {
      setPrevMove(ctx.db, r.id, null, prev?.reportDate ?? null, null, ctx.now());
      continue;
    }
    const closes = await track(ctx, 'nasdaq-prices', () =>
      ctx.sources.dailyCloses(r.symbol, addDays(prev.reportDate, -10), addDays(prev.reportDate, 10)));
    if (!closes) continue; // fetch failed: retry next run
    const pct = reactionMove(closes, prev.reportDate, resolved.timing);
    setPrevMove(ctx.db, r.id, pct, prev.reportDate, pct == null ? null : resolved.basis, ctx.now());
  }
}
