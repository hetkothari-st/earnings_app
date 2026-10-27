import { usAdrRows } from '../../db/adrRows.js';
import { reactionMovePct } from '../../india/domain/inMoves.js';
import { jpPastDates, jpReportsNeedingPrevMove, jpStocks, priorJpReleased, setJpPrevMove } from '../db/jpRepo.js';
import { addDaysJST, jpDateFromUs, jpReactionWindow, type JpTiming } from '../domain/jpCalendar.js';
import { yahooJpSymbol } from '../universe.js';
import { trackIn, type JpJobContext } from './context.js';

/** Ruling 10: at most this many daily-close fetches per (nightly) run. */
export const JP_PREV_MOVE_BUDGET = 800;
const TIER_A_DAYS = 180;
const MIN_DAYS = 45;
const MAX_DAYS = 140;

const daysBetween = (later: string, earlier: string) => (Date.parse(later) - Date.parse(earlier)) / 86_400_000;

/**
 * Close-to-close move after each stock's previous report, for rows dated `[today−1, today+14]` plus tier A (visible
 * ∪ watched) rows to +180 days, without a previous move and not checked in the last 20 h; at most `budget` close
 * fetches, nearest report first. The prior date is the latest released report this app has; else, at full level, the
 * ADR's US row as a JST date (US AMC → next day, before the Tokyo open: BMO; US BMO / DMH → same day, after the
 * Tokyo close: AMC); else a stored Yahoo past date. Every prior date, the app's own included, must lie 45–140 days
 * back. Known timing
 * gives basis 'known'; unknown timing is treated as AMC, basis 'assumed'. A prior from the ADR's US row is always
 * 'assumed': US-side timing cannot prove the Tokyo timing. A failed close fetch leaves the row to be
 * retried; a miss never blanks an earlier value.
 */
export async function computeJpPrevMoves(ctx: JpJobContext, opts: { budget?: number } = {}): Promise<void> {
  const today = ctx.todayJST();
  const now = ctx.now();
  const recheckBefore = new Date(Date.parse(now) - 20 * 3_600_000).toISOString();
  const tierA = new Set(ctx.tierA());
  const near = jpReportsNeedingPrevMove(ctx.db, addDaysJST(today, -1), addDaysJST(today, 14), recheckBefore);
  const watched = tierA.size === 0 ? [] : jpReportsNeedingPrevMove(ctx.db, addDaysJST(today, 15), addDaysJST(today, TIER_A_DAYS), recheckBefore)
    .filter((r) => tierA.has(r.code));
  const stocks = new Map(jpStocks(ctx.db).map((s) => [s.code, s]));
  let budget = opts.budget ?? JP_PREV_MOVE_BUDGET;

  for (const r of [...near, ...watched].sort((a, b) => a.reportDate.localeCompare(b.reportDate) || a.id - b.id)) {
    if (budget <= 0) break;
    const stock = stocks.get(r.code);
    if (!stock) continue;
    const inWindow = (d: string) => daysBetween(r.reportDate, d) >= MIN_DAYS && daysBetween(r.reportDate, d) <= MAX_DAYS;

    let prior: { date: string; timing: JpTiming; known: boolean } | null = null;
    const own = priorJpReleased(ctx.db, r.code, r.reportDate);
    // Outside 45–140 days it is not the previous quarter's release: fall through to the other sources.
    if (own && inWindow(own.reportDate)) prior = { date: own.reportDate, timing: own.timing, known: own.known };
    if (!prior && stock.level === 'full' && stock.adr) {
      const us = usAdrRows(ctx.db, stock.adr, addDaysJST(r.reportDate, -MAX_DAYS - 1), r.reportDate)
        .map((u) => ({ date: jpDateFromUs(u.reportDate, u.timing), timing: u.timing }))
        .filter((u) => inWindow(u.date))
        .sort((a, b) => b.date.localeCompare(a.date))[0];
      if (us) {
        const timing: JpTiming = us.timing === 'AMC' ? 'BMO' : us.timing === 'UNKNOWN' ? 'UNKNOWN' : 'AMC';
        prior = { date: us.date, timing, known: false };
      }
    }
    if (!prior) {
      const past = jpPastDates(ctx.db, r.code).find((d) => inWindow(d.date));
      if (past) prior = { date: past.date, timing: past.timing ?? 'UNKNOWN', known: past.timing != null };
    }
    if (!prior) { setJpPrevMove(ctx.db, r.id, null, now); continue; }

    const timing = prior.timing === 'UNKNOWN' ? 'AMC' : prior.timing;
    const w = jpReactionWindow(prior.date, timing);
    budget--;
    const closes = await trackIn(ctx, 'yahoo-jp-closes',
      () => ctx.yahooCloses(yahooJpSymbol(r.code), addDaysJST(w.before, -5), addDaysJST(w.after, 1)));
    if (!closes) continue; // fetch failed: retried next run
    const pct = reactionMovePct(closes, w);
    setJpPrevMove(ctx.db, r.id, pct == null ? null : { pct, date: prior.date, basis: prior.known ? 'known' : 'assumed' }, now);
  }
}
