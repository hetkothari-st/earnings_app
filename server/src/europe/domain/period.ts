import { DateTime } from 'luxon';

export interface EuropePeriod {
  periodEnd: string;
  fiscalQuarter: 1 | 2 | 3 | 4;
  fyEnd: string;
}

const monthEnd = (year: number, month: number): string =>
  DateTime.utc(year, month, 1).endOf('month').toISODate()!;

/**
 * Latest quarter end strictly before `reportDate` (Ruling 7). Quarter ends are the fiscal-year-end month and every
 * third month after it; the fiscal year is named by the calendar year it ends in. This is the raw rule: a late
 * reporter (FY-Dec results on 2026-05-20 gives 2026-03-31) is handled by `period_confirmed`, not here.
 */
export function europePeriodFor(reportDate: string, fyEndMonth: number): EuropePeriod {
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

/** "Q1 FY26" / "H1 FY26" / "Q3 FY26"; the fourth quarter is the full year, "FY26". */
export function europePeriodLabel(p: EuropePeriod): string {
  const fy = `FY${String(Number(p.fyEnd.slice(0, 4)) % 100).padStart(2, '0')}`;
  if (p.fiscalQuarter === 4) return fy;
  return p.fiscalQuarter === 2 ? `H1 ${fy}` : `Q${p.fiscalQuarter} ${fy}`;
}
