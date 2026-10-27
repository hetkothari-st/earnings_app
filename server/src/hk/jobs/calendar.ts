import { type HkStock, hkStocks, upsertHkCalendarRow, usAdrRows } from '../db/hkRepo.js';
import { addDaysHKT } from '../domain/hkCalendar.js';
import { hkDateFromUs } from '../domain/hkMoves.js';
import { hkPeriodFor, hkPeriodLabel } from '../domain/period.js';
import { guardedIn, type HkJobContext } from './context.js';

function writeEstimate(ctx: HkJobContext, stock: HkStock, reportDate: string): void {
  const { periodEnd, kind } = hkPeriodFor(reportDate, stock.cadence, stock.fyEndMonth);
  upsertHkCalendarRow(ctx.db, {
    code: stock.code, name: stock.name, periodEnd, periodKind: kind, periodLabel: hkPeriodLabel(periodEnd, kind, stock.fyEndMonth),
    reportDate, dateStatus: 'estimated',
  }, ctx.now());
}

/**
 * Estimated dates for every active stock. Yahoo's single next date counts only when it is today or later
 * (stale and ranged dates never create a row). Full level: the ADR's US row converted to an HK date
 * (Ruling 5), used when Yahoo agrees or has none; when they disagree nothing is written. A confirmed date
 * is never moved: the repo keeps it against an estimated one.
 */
export async function refreshHkCalendar(ctx: HkJobContext): Promise<void> {
  const today = ctx.todayHKT();
  for (const stock of hkStocks(ctx.db).filter((s) => s.active)) {
    const y = (await guardedIn(ctx, { name: 'yahoo-hk', run: () => ctx.yahoo(stock.yahooSymbol) }))?.value;
    const yahooDate = y?.nextDate && y.nextDate >= today ? y.nextDate : null;
    if (stock.level === 'full' && stock.adr) {
      const us = [...new Set(usAdrRows(ctx.db, stock.adr, addDaysHKT(today, -1), addDaysHKT(today, 120))
        .map((r) => hkDateFromUs(r.reportDate, r.timing)).filter((d) => d >= today))].sort();
      if (us.length > 0) {
        const date = yahooDate ? us.find((d) => d === yahooDate) : us[0];
        if (date) writeEstimate(ctx, stock, date);
        continue;
      }
    }
    if (yahooDate) writeEstimate(ctx, stock, yahooDate);
  }
}
