import { type AdrMoveRow, type AdrMovesDeps, refreshAdrLiveMoves, snapshotAdrMoves } from '../../jobs/adrMoves.js';
import { jpReportsBetween, saveJpExpectedMove, saveJpLiveMove, storedJpExpectedMove } from '../db/jpRepo.js';
import { addDaysJST } from '../domain/jpCalendar.js';
import { guardedIn, type JpJobContext } from './context.js';

/** The shared ADR expected-move jobs over the Japan tables (Ruling 9: HK Ruling 6 with the JST date). */
function jpMovesDeps(ctx: JpJobContext): AdrMovesDeps {
  return {
    db: ctx.db,
    now: () => ctx.now(),
    todayLocal: () => ctx.todayJST(),
    addDays: addDaysJST,
    optionChain: async (adr) => (await guardedIn(ctx, { name: 'cboe', run: () => ctx.optionChain(adr) }))?.value ?? null,
    // Full-level reports with an ADR, not yet released, with no actual and not yet final.
    candidates: (from, to) => jpReportsBetween(ctx.db, from, to)
      .filter((r) => r.level === 'full' && r.adr != null && !r.releasedAt && !r.hasEps && !r.hasRevenue && !r.expectedFinal)
      .map((r): AdrMoveRow => ({ id: r.id, reportDate: r.reportDate, timing: r.timing, releasedAt: r.releasedAt, adr: r.adr! })),
    stored: (id) => storedJpExpectedMove(ctx.db, id),
    saveExpected: (id, em, final, now) => saveJpExpectedMove(ctx.db, id, em, final, now),
    saveLive: (id, m, now) => saveJpLiveMove(ctx.db, id, m, now),
  };
}

/** ADR straddle snapshot for full-level Japan reports; final at the last US close before the Tokyo date. */
export async function snapshotJpMoves(ctx: JpJobContext): Promise<number[]> {
  return snapshotAdrMoves(jpMovesDeps(ctx));
}

/** Live move on the US session before the Tokyo release. */
export async function refreshJpLiveMoves(ctx: JpJobContext): Promise<number[]> {
  return refreshAdrLiveMoves(jpMovesDeps(ctx));
}
