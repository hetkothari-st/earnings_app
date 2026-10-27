import { hkReportsBetween, mergeHkActuals } from '../db/hkRepo.js';
import { addDaysHKT } from '../domain/hkCalendar.js';
import { yahooHkSymbol } from '../universe.js';
import { guardedIn, type HkJobContext } from './context.js';

/**
 * Basic-level quarterly actuals from Yahoo (Ruling 7): reports dated [today-20, today] missing EPS or revenue
 * (a row that has EPS can still get its revenue; a stored figure is never re-read). EPS from earningsHistory in the
 * report's period-end month, revenue from the calendar quarter (`${q}Q${yyyy}`); a figure without a currency is
 * dropped. Half-year and FY names stay blank; full-level rows are never touched, nor SEC actuals. Returns changed ids.
 */
export async function refreshHkYahooResults(ctx: HkJobContext): Promise<number[]> {
  const today = ctx.todayHKT();
  const due = hkReportsBetween(ctx.db, addDaysHKT(today, -20), today)
    .filter((r) => r.level === 'basic' && r.periodKind === 'Q' && (!r.hasEps || !r.hasRevenue));
  const changed: number[] = [];
  for (const r of due) {
    const y = (await guardedIn(ctx, { name: 'yahoo-hk', run: () => ctx.yahoo(yahooHkSymbol(r.code)) }))?.value;
    if (!y) continue;
    const month = r.periodEnd.slice(0, 7);
    const eps = r.hasEps ? undefined : y.epsHistory.find((h) => h.periodEnd.slice(0, 7) === month && h.currency != null);
    const label = `${Math.ceil(Number(r.periodEnd.slice(5, 7)) / 3)}Q${r.periodEnd.slice(0, 4)}`;
    const rev = r.hasRevenue || y.financialCurrency == null ? undefined : y.revenueQuarters.find((q) => q.label === label);
    if (!eps && !rev) continue;
    const merged = mergeHkActuals(ctx.db, r.id, {
      eps: eps?.actual ?? null, epsCurrency: eps?.currency ?? null, epsBasis: eps ? 'share' : null,
      revenue: rev?.revenue ?? null, revenueCurrency: rev ? y.financialCurrency : null, source: 'yahoo',
    }, ctx.now());
    if (merged) changed.push(r.id);
  }
  return changed;
}
