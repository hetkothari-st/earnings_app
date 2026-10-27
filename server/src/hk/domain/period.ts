import { DateTime } from 'luxon';

export type HkPeriodKind = 'Q' | 'H' | 'FY';

const monthEnd = (year: number, month: number): string =>
  DateTime.utc(year, month, 1).endOf('month').toISODate()!;

/**
 * Latest period end strictly before `reportDate`. Quarterly names: calendar quarter ends.
 * Half-yearly names: the fiscal-year-end month and six months later; the one in the
 * fiscal-year-end month is the full year (FY), the other the first half (H).
 */
export function hkPeriodFor(
  reportDate: string, cadence: 'Q' | 'H', fyEndMonth: number,
): { periodEnd: string; kind: HkPeriodKind } {
  const year = Number(reportDate.slice(0, 4));
  const months = cadence === 'Q' ? [3, 6, 9, 12] : [fyEndMonth, ((fyEndMonth + 5) % 12) + 1];
  let best: { periodEnd: string; month: number } | null = null;
  for (let y = year - 1; y <= year; y++) {
    for (const m of months) {
      const e = monthEnd(y, m);
      if (e < reportDate && (!best || e > best.periodEnd)) best = { periodEnd: e, month: m };
    }
  }
  const kind: HkPeriodKind = cadence === 'Q' ? 'Q' : best!.month === fyEndMonth ? 'FY' : 'H';
  return { periodEnd: best!.periodEnd, kind };
}

const yy = (year: number): string => String(year % 100).padStart(2, '0');

/** "Q3 26" (calendar quarter), "1H26" (fiscal year the half belongs to), "FY26" (year of the period end). */
export function hkPeriodLabel(periodEnd: string, kind: HkPeriodKind, fyEndMonth: number): string {
  const year = Number(periodEnd.slice(0, 4));
  const month = Number(periodEnd.slice(5, 7));
  if (kind === 'Q') return `Q${Math.ceil(month / 3)} ${yy(year)}`;
  if (kind === 'FY') return `FY${yy(year)}`;
  return `1H${yy(month <= fyEndMonth ? year : year + 1)}`;
}
