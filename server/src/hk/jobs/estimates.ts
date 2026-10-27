import { hkReportsBetween, hkStocks, setHkEstimates } from '../db/hkRepo.js';
import { addDaysHKT } from '../domain/hkCalendar.js';
import { guardedIn, type HkJobContext } from './context.js';

/**
 * Consensus for reports in [today-3, today+180]: only the Yahoo trend item whose period end equals the
 * report's. One currency per row: a revenue estimate in another currency than the row's is stored as null.
 */
export async function refreshHkEstimates(ctx: HkJobContext): Promise<void> {
  const today = ctx.todayHKT();
  const reports = hkReportsBetween(ctx.db, addDaysHKT(today, -3), addDaysHKT(today, 180));
  const byCode = new Map<string, typeof reports>();
  for (const r of reports) byCode.set(r.code, [...(byCode.get(r.code) ?? []), r]);
  for (const stock of hkStocks(ctx.db).filter((s) => s.active && byCode.has(s.code))) {
    const y = (await guardedIn(ctx, { name: 'yahoo-hk', run: () => ctx.yahoo(stock.yahooSymbol) }))?.value;
    if (!y) continue;
    for (const r of byCode.get(stock.code)!) {
      const t = y.trend.find((x) => x.periodEnd === r.periodEnd);
      if (!t) continue;
      const currency = t.eps != null ? t.epsCurrency : t.revenueCurrency;
      const revenueOk = t.revenue != null && t.revenueCurrency != null && t.revenueCurrency === currency;
      if (t.eps == null && !revenueOk) continue;
      setHkEstimates(ctx.db, r.id, {
        eps: t.eps, epsAnalysts: t.eps != null ? t.epsAnalysts : null,
        revenue: revenueOk ? t.revenue : null, revenueAnalysts: revenueOk ? t.revenueAnalysts : null, currency,
      }, ctx.now());
    }
  }
}
