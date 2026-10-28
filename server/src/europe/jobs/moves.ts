import { DateTime } from 'luxon';
import type { ExchangeCalendar } from '../../domain/exchangeCalendar.js';
import { type AdrMoveRow, type AdrMovesDeps, refreshAdrLiveMoves, snapshotAdrMoves } from '../../jobs/adrMoves.js';
import {
  europeReportsBetween, saveEuropeExpectedMove, saveEuropeLiveMove, storedBankHolidays, storedEuropeExpectedMove,
} from '../db/europeRepo.js';
import { calendarFor } from '../domain/calendars.js';
import type { ExchangeId } from '../exchanges.js';
import { guardedIn, type EuropeJobContext } from './context.js';

/**
 * The shared ADR expected-move jobs over the Europe tables (HK Ruling 6, as Japan). Each row uses its own exchange's
 * calendar (`calendarFor`, with the stored gov.uk dates for LSE): its candidate window is that exchange's today + 7
 * days, read at `ctx.now()` in the exchange's zone, so a Helsinki row is not judged by Paris's date. The row's local
 * report date and timing are mapped onto the US calendar by `adrSessions`. Chains come through `ctx.optionChain`, the
 * 15-minute cache over the shared Cboe client (≤ 0.5 req/s, one chain per ADR per run).
 */
function europeMovesDeps(ctx: EuropeJobContext): AdrMovesDeps {
  const lseHolidays = storedBankHolidays(ctx.db);
  const cals = new Map<ExchangeId, ExchangeCalendar>();
  const calOf = (ex: ExchangeId): ExchangeCalendar => {
    let c = cals.get(ex);
    if (!c) cals.set(ex, (c = calendarFor(ex, ex === 'LSE' ? lseHolidays : undefined)));
    return c;
  };
  /** The exchange's [today, today + 7] at the job's clock. */
  const inWindow = (ex: ExchangeId, reportDate: string): boolean => {
    const cal = calOf(ex);
    const today = DateTime.fromISO(ctx.now(), { zone: 'utc' }).setZone(cal.zone).toISODate()!;
    return reportDate >= today && reportDate <= cal.addDays(today, 7);
  };
  return {
    db: ctx.db,
    now: () => ctx.now(),
    todayLocal: () => ctx.today(),
    // Calendar-day arithmetic for the coarse market window; it is widened by a day each side and each row is then
    // checked on its own exchange's window (zones in Europe differ by at most a day from the market's date).
    addDays: (d, n) => DateTime.fromISO(d, { zone: 'utc' }).plus({ days: n }).toISODate()!,
    optionChain: async (adr) => (await guardedIn(ctx, { name: 'cboe', run: () => ctx.optionChain(adr) }))?.value ?? null,
    // Full-level reports with an ADR, not yet released, with no actual and not yet final.
    candidates: (from, to) => europeReportsBetween(
      ctx.db, ctx.market,
      DateTime.fromISO(from, { zone: 'utc' }).minus({ days: 1 }).toISODate()!, DateTime.fromISO(to, { zone: 'utc' }).plus({ days: 1 }).toISODate()!,
    )
      .filter((r) => r.level === 'full' && r.adr != null && !r.releasedAt && !r.hasEps && !r.hasRevenue && !r.expectedFinal)
      .filter((r) => inWindow(r.exchange, r.reportDate))
      .map((r): AdrMoveRow => ({ id: r.id, reportDate: r.reportDate, timing: r.timing, releasedAt: r.releasedAt, adr: r.adr! })),
    stored: (id) => storedEuropeExpectedMove(ctx.db, id),
    saveExpected: (id, em, final, now) => saveEuropeExpectedMove(ctx.db, id, em, final, now),
    saveLive: (id, m, now) => saveEuropeLiveMove(ctx.db, id, m, now),
  };
}

/** ADR straddle snapshot for full-level UK / EU reports; final at the last US close before the local date. */
export async function snapshotEuropeMoves(ctx: EuropeJobContext): Promise<number[]> {
  return snapshotAdrMoves(europeMovesDeps(ctx));
}

/** Live move on the US session before the local release. */
export async function refreshEuropeLiveMoves(ctx: EuropeJobContext): Promise<number[]> {
  return refreshAdrLiveMoves(europeMovesDeps(ctx));
}
