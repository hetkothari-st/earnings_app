import { type AdrMoveRow, type AdrMovesDeps, refreshAdrLiveMoves, snapshotAdrMoves } from '../../jobs/adrMoves.js';
import { hkReportsBetween, saveHkExpectedMove, saveHkLiveMove } from '../db/hkRepo.js';
import { addDaysHKT } from '../domain/hkCalendar.js';
import { guardedIn, type HkJobContext } from './context.js';

/** The shared ADR expected-move jobs over the HK tables. */
function hkMovesDeps(ctx: HkJobContext): AdrMovesDeps {
  return {
    db: ctx.db,
    now: () => ctx.now(),
    todayLocal: () => ctx.todayHKT(),
    addDays: addDaysHKT,
    optionChain: async (adr) => (await guardedIn(ctx, { name: 'cboe', run: () => ctx.optionChain(adr) }))?.value ?? null,
    // Full-level reports with an ADR, not yet released and not yet final.
    candidates: (from, to) => hkReportsBetween(ctx.db, from, to)
      .filter((r) => r.level === 'full' && r.adr != null && !r.releasedAt && !r.hasActual && !r.expectedFinal)
      .map((r): AdrMoveRow => ({ id: r.id, reportDate: r.reportDate, timing: r.timing, releasedAt: r.releasedAt, adr: r.adr! })),
    stored: (id) => {
      const s = ctx.db.prepare('SELECT quote_date AS quoteDate, final FROM hk_expected_moves WHERE report_id = ?').get(id) as
        { quoteDate: string; final: number } | undefined;
      return s ? { quoteDate: s.quoteDate, final: s.final === 1 } : null;
    },
    saveExpected: (id, em, final, now) => saveHkExpectedMove(ctx.db, id, em, final, now),
    saveLive: (id, m, now) => saveHkLiveMove(ctx.db, id, m, now),
  };
}

/**
 * Expected-move snapshot from the ADR's option chain. Quotes dated after the last US close before the HK date
 * already price in the release and are never used. Final when the quotes are from exactly that close.
 */
export async function snapshotHkMoves(ctx: HkJobContext): Promise<number[]> {
  return snapshotAdrMoves(hkMovesDeps(ctx));
}

/** Live move (the US session before the HK release is today in ET): same computation on the current quotes. */
export async function refreshHkLiveMoves(ctx: HkJobContext): Promise<number[]> {
  return refreshAdrLiveMoves(hkMovesDeps(ctx));
}
