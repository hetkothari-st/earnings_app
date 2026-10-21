import { activeStocks, inReportsBetween, setInEstimates, setStockProfile, upsertInCalendarRow } from '../db/inRepo.js';
import { addDaysIST } from '../domain/nseCalendar.js';
import { latestQuarterEndBefore, quarterLabel } from '../domain/quarter.js';
import { type InJobContext, guardedIn } from './context.js';

/**
 * Yahoo backup data for every F&O stock: sector, market cap, quarterly consensus (only for the
 * report whose quarter end matches) and, where NSE has not announced a date, Yahoo's estimated date.
 */
export async function refreshInEstimates(ctx: InJobContext, scope: 'all' | 'near' | 'far' = 'all'): Promise<void> {
  const today = ctx.todayIST();
  const nearEnd = addDaysIST(today, 7);
  const reports = inReportsBetween(ctx.db, addDaysIST(today, -3), addDaysIST(today, 120));
  const bySymbol = new Map<string, typeof reports>();
  for (const r of reports) bySymbol.set(r.symbol, [...(bySymbol.get(r.symbol) ?? []), r]);
  const now = ctx.now();
  for (const stock of activeStocks(ctx.db)) {
    // Hourly: stocks reporting within 7 days. Every 6 hours: the rest. Backup when Yahoo fails: the stored values.
    const isNear = (bySymbol.get(stock.symbol) ?? []).some((r) => r.reportDate >= today && r.reportDate <= nearEnd);
    if ((scope === 'near' && !isNear) || (scope === 'far' && isNear)) continue;
    const y = (await guardedIn(ctx, { name: 'yahoo-in', run: () => ctx.yahoo(stock.symbol) }))?.value;
    if (!y) continue;
    setStockProfile(ctx.db, stock.symbol, { sector: y.sector, industry: y.industry, marketCap: y.marketCap, asOf: y.marketCapAsOf }, now);
    const own = bySymbol.get(stock.symbol) ?? [];
    if (y.nextDate && y.nextDate >= today && !own.some((r) => r.reportDate >= today)) {
      const quarterEnd = latestQuarterEndBefore(y.nextDate);
      own.push({ id: upsertInCalendarRow(ctx.db, { symbol: stock.symbol, name: stock.name, quarterEnd,
        quarterLabel: quarterLabel(quarterEnd), reportDate: y.nextDate, dateStatus: 'estimated' }, now),
        symbol: stock.symbol, reportDate: y.nextDate, timing: 'UNKNOWN', quarterEnd });
    }
    for (const r of own) {
      const q = y.quarters.find((x) => x.periodEnd === r.quarterEnd);
      if (q) setInEstimates(ctx.db, r.id, { eps: q.eps, epsAnalysts: q.epsAnalysts, revenue: q.revenue, revenueAnalysts: q.revenueAnalysts }, now);
    }
  }
}
