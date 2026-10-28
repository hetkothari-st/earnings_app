import { type AdrMoveRow, type AdrMovesDeps, refreshAdrLiveMoves, snapshotAdrMoves } from '../../jobs/adrMoves.js';
import { europeReportsBetween, saveEuropeExpectedMove, saveEuropeLiveMove, storedEuropeExpectedMove } from '../db/europeRepo.js';
import { calendarFor } from '../domain/calendars.js';
import { guardedIn, type EuropeJobContext } from './context.js';

/**
 * The shared ADR expected-move jobs over the Europe tables (HK Ruling 6, as Japan). The candidate window is the
 * market's today (London for UK, Paris for EU) + 7 days; each row keeps its own exchange's local report date and
 * timing, which `adrSessions` maps onto the US calendar. Chains come through `ctx.optionChain`, the 15-minute cache
 * over the shared Cboe client (≤ 0.5 req/s, one chain per ADR per run).
 */
function europeMovesDeps(ctx: EuropeJobContext): AdrMovesDeps {
  const cal = calendarFor(ctx.market === 'UK' ? 'LSE' : 'PAR');
  return {
    db: ctx.db,
    now: () => ctx.now(),
    todayLocal: () => ctx.today(),
    addDays: (d, n) => cal.addDays(d, n),
    optionChain: async (adr) => (await guardedIn(ctx, { name: 'cboe', run: () => ctx.optionChain(adr) }))?.value ?? null,
    // Full-level reports with an ADR, not yet released, with no actual and not yet final.
    candidates: (from, to) => europeReportsBetween(ctx.db, ctx.market, from, to)
      .filter((r) => r.level === 'full' && r.adr != null && !r.releasedAt && !r.hasEps && !r.hasRevenue && !r.expectedFinal)
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
