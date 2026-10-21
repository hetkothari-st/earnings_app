import { activeStocks, inReportsNeedingPrevMove, priorReleasedReport, setInPrevMove } from '../db/inRepo.js';
import { reactionMovePct, reactionWindow } from '../domain/inMoves.js';
import { addDaysIST, type InTiming } from '../domain/nseCalendar.js';
import { type InJobContext, trackIn } from './context.js';

/**
 * For recent and upcoming reports: the close-to-close move after the stock's previous report
 * (from reports this app captured). The earlier report's own timing is 'known'; without it this
 * quarter's timing is 'assumed'; with neither nothing is computed. Needs a Kite session for candles.
 */
export async function computeInPrevMoves(ctx: InJobContext): Promise<void> {
  if (!ctx.kiteSession()) return;
  const today = ctx.todayIST();
  const recheckBefore = new Date(Date.parse(ctx.now()) - 20 * 3_600_000).toISOString();
  const tokens = new Map(activeStocks(ctx.db).filter((s) => s.eqToken != null).map((s) => [s.symbol, s.eqToken!]));
  const now = ctx.now();
  for (const r of inReportsNeedingPrevMove(ctx.db, addDaysIST(today, -7), addDaysIST(today, 60), recheckBefore)) {
    const prior = priorReleasedReport(ctx.db, r.symbol, r.reportDate);
    const current = (ctx.db.prepare('SELECT timing FROM in_reports WHERE id = ?').get(r.id) as { timing: InTiming }).timing;
    const timing = prior?.known ? prior.timing : current;
    const token = tokens.get(r.symbol);
    if (!prior || timing === 'UNKNOWN' || token == null) {
      setInPrevMove(ctx.db, r.id, null, now);
      continue;
    }
    const w = reactionWindow(prior.reportDate, timing);
    const candles = await trackIn(ctx, 'kite-historical', () => ctx.kite.candles(token, addDaysIST(w.before, -3), addDaysIST(w.after, 1)));
    if (!candles) continue; // fetch failed: retry next run
    const pct = reactionMovePct(new Map(candles.map((c) => [c.date, c.close])), w);
    setInPrevMove(ctx.db, r.id, pct == null ? null : { pct, date: prior.reportDate, basis: prior.known ? 'known' : 'assumed' }, now);
  }
}
