import { DateTime } from 'luxon';

export interface JpPeriod {
  periodEnd: string;
  fiscalQuarter: 1 | 2 | 3 | 4;
  fyEnd: string;
}

const monthEnd = (year: number, month: number): string =>
  DateTime.utc(year, month, 1).endOf('month').toISODate()!;

/**
 * Latest quarter end strictly before `reportDate` (Ruling 4). Quarter ends are the fiscal-year-end
 * month and every third month after it; the fourth quarter is the full year.
 */
export function jpPeriodFor(reportDate: string, fyEndMonth: number): JpPeriod {
  const year = Number(reportDate.slice(0, 4));
  let best: { periodEnd: string; month: number; year: number } | null = null;
  for (let y = year - 1; y <= year; y++) {
    for (let k = 0; k < 4; k++) {
      const m = ((fyEndMonth - 1 + 3 * k) % 12) + 1;
      const e = monthEnd(y, m);
      if (e < reportDate && (!best || e > best.periodEnd)) best = { periodEnd: e, month: m, year: y };
    }
  }
  const monthsToFyEnd = (fyEndMonth - best!.month + 12) % 12; // 0, 3, 6 or 9
  const fiscalQuarter = (4 - monthsToFyEnd / 3) as 1 | 2 | 3 | 4;
  const fyEndAnchor = DateTime.utc(best!.year, best!.month, 1).plus({ months: monthsToFyEnd });
  return { periodEnd: best!.periodEnd, fiscalQuarter, fyEnd: monthEnd(fyEndAnchor.year, fyEndAnchor.month) };
}

/** "1Q FY27" / "2Q FY27" / "3Q FY27"; the fourth quarter is the full year, "FY27" (named by the year it ends in). */
export function jpPeriodLabel(p: JpPeriod): string {
  const fy = `FY${String(Number(p.fyEnd.slice(0, 4)) % 100).padStart(2, '0')}`;
  return p.fiscalQuarter === 4 ? fy : `${p.fiscalQuarter}Q ${fy}`;
}

/** Months of the fiscal year covered by a year-to-date figure through quarter `q`. */
export function ytdMonthsOf(q: 1 | 2 | 3 | 4): 3 | 6 | 9 | 12 {
  return (q * 3) as 3 | 6 | 9 | 12;
}
