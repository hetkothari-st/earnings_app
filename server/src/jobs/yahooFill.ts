import { inTransaction, mergeYahooFill, reportsMissingValues } from '../db/repo.js';
import { yahooFill } from '../sources/yahooEarnings.js';
import { type JobContext, guarded } from './context.js';

/**
 * Fills EPS actuals and revenue that Nasdaq/Finnhub left empty (notably US-listed foreign companies),
 * for reports dated in [from, to]. Yahoo is a backup source: it never overwrites a value.
 */
export async function refreshYahoo(ctx: JobContext, from: string, to: string): Promise<void> {
  const today = ctx.today();
  for (const r of reportsMissingValues(ctx.db, from, to, today)) {
    const summary = (await guarded(ctx, { name: 'yahoo', run: () => ctx.sources.yahooSummary(r.symbol) }))?.value;
    if (!summary) continue;
    const fill = yahooFill(summary, r);
    if (fill.epsActual == null && fill.revenueEstimate == null && fill.revenueActual == null) continue;
    inTransaction(ctx.db, () => mergeYahooFill(ctx.db, r.id, fill, ctx.now()));
  }
}
