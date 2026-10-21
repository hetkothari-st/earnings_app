import { previousReport, reportsNeedingPrevMove, setPrevMove } from '../db/repo.js';
import { addDays, sessionClose } from '../domain/marketCalendar.js';
import { reactionMove } from '../domain/reactionMove.js';
import type { PrevMoveBasis, Timing } from '../types.js';
import { type JobContext, guarded } from './context.js';

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
export async function computePrevMoves(ctx: JobContext, window: { from?: string } = {}): Promise<void> {
  const today = ctx.today();
  const recheckBefore = new Date(Date.parse(ctx.now()) - 20 * 3_600_000).toISOString();
  const cache = new Map<string, Map<string, number>>();
  for (const r of reportsNeedingPrevMove(ctx.db, window.from ?? addDays(today, -7), addDays(today, 30), recheckBefore)) {
    const prev = previousReport(ctx.db, r.symbolKey, r.reportDate);
    const resolved = prev ? resolveTiming(prev, r.timing) : null;
    if (!prev || !resolved) {
      setPrevMove(ctx.db, r.id, null, prev?.reportDate ?? null, null, ctx.now());
      continue;
    }
    // Nasdaq's history endpoint returns nothing for short windows, so fetch ~2 years once per symbol.
    let closes = cache.get(r.symbolKey);
    if (!closes) {
      closes = (await guarded(ctx, { name: 'nasdaq-prices', run: () => ctx.sources.dailyCloses(r.symbol, addDays(today, -800), today) }))?.value;
      if (closes) cache.set(r.symbolKey, closes);
    }
    if (!closes) continue; // fetch failed: retry next run
    const pct = reactionMove(closes, prev.reportDate, resolved.timing);
    setPrevMove(ctx.db, r.id, pct, prev.reportDate, pct == null ? null : resolved.basis, ctx.now());
  }
}
