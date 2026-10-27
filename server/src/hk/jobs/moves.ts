import { computeExpectedMove } from '../../domain/expectedMove.js';
import { todayET } from '../../domain/marketCalendar.js';
import type { ExpectedMove, OptionChain } from '../../types.js';
import { hkReportsBetween, saveHkExpectedMove, saveHkLiveMove } from '../db/hkRepo.js';
import { addDaysHKT } from '../domain/hkCalendar.js';
import { firstUsSessionAfterHkRelease, lastUsCloseBeforeHk } from '../domain/hkMoves.js';
import { guardedIn, type HkJobContext } from './context.js';

type Pending = ReturnType<typeof hkReportsBetween>[number];

/** Full-level reports with an ADR, not yet released and not yet final, dated in [todayHKT, todayHKT+7]. */
function candidates(ctx: HkJobContext): (Pending & { adr: string })[] {
  const today = ctx.todayHKT();
  return hkReportsBetween(ctx.db, today, addDaysHKT(today, 7))
    .filter((r): r is Pending & { adr: string } => r.level === 'full' && r.adr != null && !r.releasedAt && !r.hasActual && !r.expectedFinal);
}

/** One chain per ADR per run. A blocked or failed fetch is null (stored values are kept). */
function chainLoader(ctx: HkJobContext) {
  const chains = new Map<string, Promise<OptionChain | null>>();
  return (adr: string) => {
    if (!chains.has(adr)) {
      chains.set(adr, (async () => (await guardedIn(ctx, { name: 'cboe', run: () => ctx.optionChain(adr) }))?.value ?? null)());
    }
    return chains.get(adr)!;
  };
}

/** Ruling 6: the straddle of the first expiry on or after the first US session that can react to the release. */
const moveFor = (chain: OptionChain, r: Pending): ExpectedMove | null =>
  computeExpectedMove(chain, firstUsSessionAfterHkRelease(r.reportDate, r.timing, r.releasedAt), 'BMO');

/**
 * Expected-move snapshot from the ADR's option chain. Quotes dated after the last US close before the HK date
 * already price in the release and are never used. Final when the quotes are from exactly that close.
 */
export async function snapshotHkMoves(ctx: HkJobContext): Promise<number[]> {
  const load = chainLoader(ctx);
  const now = ctx.now();
  const changed: number[] = [];
  for (const r of candidates(ctx)) {
    const chain = await load(r.adr);
    const lastClose = lastUsCloseBeforeHk(r.reportDate);
    if (!chain?.asOfDate || chain.asOfDate > lastClose) continue;
    const em = moveFor(chain, r);
    if (!em) continue;
    if (saveHkExpectedMove(ctx.db, r.id, { ...em, adr: r.adr, quoteDate: chain.asOfDate }, chain.asOfDate === lastClose, now)) changed.push(r.id);
  }
  return changed;
}

/** Live move (the US session before the HK release is today in ET): same computation on the current quotes. */
export async function refreshHkLiveMoves(ctx: HkJobContext): Promise<number[]> {
  const usToday = todayET(new Date(ctx.now()));
  const load = chainLoader(ctx);
  const now = ctx.now();
  const changed: number[] = [];
  for (const r of candidates(ctx).filter((c) => lastUsCloseBeforeHk(c.reportDate) === usToday)) {
    const chain = await load(r.adr);
    const em = chain && moveFor(chain, r);
    if (!chain || !em) continue;
    if (saveHkLiveMove(ctx.db, r.id, { movePct: em.movePct, illiquid: em.illiquid, quoteTime: chain.quoteTime ?? null }, now)) changed.push(r.id);
  }
  return changed;
}
