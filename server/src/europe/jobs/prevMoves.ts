import { reactionWindow } from '../../domain/adrSessions.js';
import type { LocalTiming } from '../../domain/exchangeCalendar.js';
import { usAdrRows } from '../../db/adrRows.js';
import { reactionMovePct } from '../../india/domain/inMoves.js';
import {
  europePastDates, europeReportsNeedingPrevMove, europeStocks, priorEuropeReleased, setEuropePrevMove, storedBankHolidays,
} from '../db/europeRepo.js';
import { calendarFor } from '../domain/calendars.js';
import type { ExchangeId } from '../exchanges.js';
import { europeLocalDateFromUs } from './calendar.js';
import { trackIn, type EuropeJobContext } from './context.js';
import { addDaysEurope } from './estimates.js';
import { yahooSource } from './stocks.js';

/** Ruling 12: at most this many daily-close fetches per (nightly) run, per market. */
export const EUROPE_PREV_MOVE_BUDGET = 600;
const TIER_A_DAYS = 180;
const MIN_DAYS = 45;
const MAX_DAYS = 140;

const daysBetween = (later: string, earlier: string) => (Date.parse(later) - Date.parse(earlier)) / 86_400_000;

/**
 * The local timing an ADR's US row proves (every European close is after 09:30 ET, every European open before 16:00 ET
 * of the previous day): US AMC → the next local trading day, before the open (`BMO`); US BMO → the same local day, before the
 * close (its reaction window is the `BMO` one); US DMH / UNKNOWN → the same day, unknown (treated as AMC, assumed).
 */
function localTimingFromUs(us: LocalTiming): LocalTiming {
  return us === 'AMC' || us === 'BMO' ? 'BMO' : 'UNKNOWN';
}

/**
 * Close-to-close move after each stock's previous report (JP rules on the exchange's own calendar; LSE with the stored
 * gov.uk dates), for rows dated `[today−1, today+14]` plus tier A (visible ∪ watched) rows to +180 days, without a
 * previous move and not checked in the last 20 h; at most `budget` (600) close fetches, nearest report first. The prior
 * date is the latest released report this app has; else, at full level, the ADR's US row as a local date
 * (`europeLocalDateFromUs`: US AMC → the next local trading day); else a stored Yahoo past date. Every prior date must lie 45–140 days back. Known timing gives
 * basis 'known'; unknown timing is treated as AMC, basis 'assumed'. A prior from the ADR's US row is always 'assumed'.
 * A failed close fetch leaves the row to be retried; a miss never blanks an earlier value.
 */
export async function computeEuropePrevMoves(ctx: EuropeJobContext, opts: { budget?: number } = {}): Promise<void> {
  const today = ctx.today();
  const now = ctx.now();
  const recheckBefore = new Date(Date.parse(now) - 20 * 3_600_000).toISOString();
  const tierA = new Set(ctx.tierA());
  const near = europeReportsNeedingPrevMove(ctx.db, ctx.market, addDaysEurope(ctx, today, -1), addDaysEurope(ctx, today, 14), recheckBefore);
  const watched = tierA.size === 0 ? [] : europeReportsNeedingPrevMove(ctx.db, ctx.market, addDaysEurope(ctx, today, 15),
    addDaysEurope(ctx, today, TIER_A_DAYS), recheckBefore).filter((r) => tierA.has(r.symbol));
  const stocks = new Map(europeStocks(ctx.db, ctx.market).map((s) => [s.symbol, s]));
  const ukHolidays = ctx.market === 'UK' ? storedBankHolidays(ctx.db) : undefined;
  const calOf = (ex: ExchangeId) => calendarFor(ex, ex === 'LSE' ? ukHolidays : undefined);
  let budget = opts.budget ?? EUROPE_PREV_MOVE_BUDGET;

  for (const r of [...near, ...watched].sort((a, b) => a.reportDate.localeCompare(b.reportDate) || a.id - b.id)) {
    if (budget <= 0) break;
    const stock = stocks.get(r.symbol);
    if (!stock) continue;
    const inWindow = (d: string) => daysBetween(r.reportDate, d) >= MIN_DAYS && daysBetween(r.reportDate, d) <= MAX_DAYS;

    let prior: { date: string; timing: LocalTiming; known: boolean } | null = null;
    const own = priorEuropeReleased(ctx.db, r.symbol, r.reportDate);
    // Outside 45–140 days it is not the previous period's release: fall through to the other sources.
    if (own && inWindow(own.reportDate)) prior = { date: own.reportDate, timing: own.timing, known: own.known };
    if (!prior && stock.level === 'full' && stock.adr) {
      const us = usAdrRows(ctx.db, stock.adr, addDaysEurope(ctx, r.reportDate, -MAX_DAYS - 1), r.reportDate)
        .map((u) => ({ date: europeLocalDateFromUs(ctx.db, stock.exchange, u.reportDate, u.timing), timing: localTimingFromUs(u.timing) }))
        .filter((u) => inWindow(u.date))
        .sort((a, b) => b.date.localeCompare(a.date))[0];
      if (us) prior = { date: us.date, timing: us.timing, known: false };
    }
    if (!prior) {
      const past = europePastDates(ctx.db, r.symbol).find((d) => inWindow(d.date));
      if (past) prior = { date: past.date, timing: past.timing ?? 'UNKNOWN', known: past.timing != null };
    }
    if (!prior) { setEuropePrevMove(ctx.db, r.id, null, now); continue; }

    const timing = prior.timing === 'UNKNOWN' ? 'AMC' : prior.timing;
    const known = prior.known && prior.timing !== 'UNKNOWN';
    const cal = calOf(stock.exchange);
    const w = reactionWindow(cal, prior.date, timing);
    budget--;
    const closes = await trackIn(ctx, yahooSource(ctx, 'closes'),
      () => ctx.yahooCloses(r.symbol, cal.addDays(w.before, -5), cal.addDays(w.after, 1)));
    if (!closes) continue; // fetch failed: retried next run
    const pct = reactionMovePct(closes, w);
    setEuropePrevMove(ctx.db, r.id, pct == null ? null : { pct, date: prior.date, basis: known ? 'known' : 'assumed' }, now);
  }
}
