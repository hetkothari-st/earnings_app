import { reactionMovePct } from '../../india/domain/inMoves.js';
import type { YahooPastDate } from '../../india/sources/yahooPastDates.js';
import {
  getHkReport, hkReportsBetween, hkReportsNeedingPrevMove, priorHkReleased, setHkPrevMove, setHkTiming, usAdrRows,
} from '../db/hkRepo.js';
import { addDaysHKT, type HkTiming } from '../domain/hkCalendar.js';
import { hkDateFromUs, hkReactionWindow } from '../domain/hkMoves.js';
import { yahooHkSymbol } from '../universe.js';
import { trackIn, type HkJobContext } from './context.js';

const daysBetween = (later: string, earlier: string) => (Date.parse(later) - Date.parse(earlier)) / 86_400_000;

/**
 * Close-to-close move after each stock's previous report, for reports in [today-7, today+60].
 * The prior report is the latest released one this app has; else, for full-level names, the ADR's US `reports` row
 * as an HK date (Ruling 5: US AMC -> next day before the HK open, BMO; US BMO / DMH -> same day after the HK close,
 * AMC); else a Yahoo past date (Yahoo's .HK past dates stop in May 2025, so basic names mostly stay blank). The US
 * and Yahoo dates must be inside the Ruling 15 window (45-140 days back for quarterly reports, 150-220 for
 * half-year / FY). Known BMO/DMH/AMC timing gives basis
 * 'known'; unknown timing is treated as AMC, basis 'assumed'. A failed fetch leaves the row to be retried;
 * a miss never blanks an earlier value.
 *
 * The same Yahoo answer also holds upcoming rows: a time-as-supplied row on a basic-level report's own date
 * sets its timing; otherwise the timing stays unknown ("Time not announced").
 */
export async function computeHkPrevMoves(ctx: HkJobContext): Promise<void> {
  const today = ctx.todayHKT();
  const now = ctx.now();
  const recheckBefore = new Date(Date.parse(now) - 20 * 3_600_000).toISOString();
  const pastDates = new Map<string, YahooPastDate[] | undefined>();
  const datesOf = async (code: string) => {
    if (!pastDates.has(code)) pastDates.set(code, await trackIn(ctx, 'yahoo-past-dates', () => ctx.yahooPastDates(yahooHkSymbol(code))));
    return pastDates.get(code);
  };

  // Timing "as supplied" for basic-level rows that have none.
  for (const r of hkReportsBetween(ctx.db, addDaysHKT(today, -1), addDaysHKT(today, 60))) {
    if (r.level !== 'basic' || r.timing !== 'UNKNOWN' || r.releasedAt) continue;
    const tas = (await datesOf(r.code))?.find((d) => d.date === r.reportDate && d.timing);
    if (tas?.timing) setHkTiming(ctx.db, r.id, tas.timing, 'yahoo');
  }

  for (const r of hkReportsNeedingPrevMove(ctx.db, addDaysHKT(today, -7), addDaysHKT(today, 60), recheckBefore)) {
    const report = getHkReport(ctx.db, r.id);
    if (!report) continue;
    let prior: { date: string; timing: HkTiming; known: boolean } | null = null;
    const own = priorHkReleased(ctx.db, r.code, r.reportDate);
    if (own) prior = { date: own.reportDate, timing: own.timing, known: own.known };
    const [lo, hi] = report.periodKind === 'Q' ? [45, 140] : [150, 220];
    const inWindow = (d: string) => daysBetween(r.reportDate, d) >= lo && daysBetween(r.reportDate, d) <= hi;
    if (!prior && report.level === 'full' && report.adr) {
      const us = usAdrRows(ctx.db, report.adr, addDaysHKT(r.reportDate, -hi - 1), r.reportDate)
        .map((u) => ({ date: hkDateFromUs(u.reportDate, u.timing), timing: u.timing }))
        .filter((u) => inWindow(u.date))
        .sort((a, b) => b.date.localeCompare(a.date))[0];
      if (us) {
        const timing: HkTiming = us.timing === 'AMC' ? 'BMO' : us.timing === 'UNKNOWN' ? 'UNKNOWN' : 'AMC';
        prior = { date: us.date, timing, known: timing !== 'UNKNOWN' };
      }
    }
    if (!prior) {
      const dates = await datesOf(r.code);
      if (dates === undefined) continue; // fetch failed: retry next run
      const y = dates.filter((d) => inWindow(d.date))
        .sort((a, b) => b.date.localeCompare(a.date))[0];
      if (y) prior = { date: y.date, timing: y.timing ?? 'UNKNOWN', known: y.timing != null };
    }
    if (!prior) { setHkPrevMove(ctx.db, r.id, null, now); continue; }

    const timing = prior.timing === 'UNKNOWN' ? 'AMC' : prior.timing;
    const w = hkReactionWindow(prior.date, timing);
    const closes = await trackIn(ctx, 'yahoo-hk-closes', () => ctx.yahooCloses(yahooHkSymbol(r.code), addDaysHKT(w.before, -5), addDaysHKT(w.after, 1)));
    if (!closes) continue; // fetch failed: retry next run
    const pct = reactionMovePct(closes, w);
    setHkPrevMove(ctx.db, r.id, pct == null ? null : { pct, date: prior.date, basis: prior.known ? 'known' : 'assumed' }, now);
  }
}
