import { DateTime } from 'luxon';
import { reactionWindow } from '../../domain/adrSessions.js';
import type { LocalTiming } from '../../domain/exchangeCalendar.js';
import { ET } from '../../domain/marketCalendar.js';
import { usAdrRows } from '../../db/adrRows.js';
import { reactionMovePct } from '../../india/domain/inMoves.js';
import { fetchAcceptance, fetchEarningsFilings } from '../../sources/sec.js';
import { parseFilingDocs } from '../../sources/secFeed.js';
import { classifySixK, pickReleaseDoc } from '../../sources/sixKClassify.js';
import type { Filing } from '../../types.js';
import {
  type EuropeStock, europePastDates, europeReportsNeedingPrevMove, europeStocks, priorEuropeReleased, setEuropePrevMove,
  storedBankHolidays,
} from '../db/europeRepo.js';
import { calendarFor } from '../domain/calendars.js';
import { europePeriodFor } from '../domain/period.js';
import { EXCHANGES, type ExchangeId } from '../exchanges.js';
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
 * The local timing an ADR's US row proves. Only US AMC does: after 16:00 ET every European session has closed and the
 * next local trading day's open is still ahead, so the release is before that open (`BMO`). US BMO / DMH / UNKNOWN
 * fall before or inside a European session and prove nothing (UNKNOWN).
 */
function localTimingFromUs(us: LocalTiming): LocalTiming {
  return us === 'AMC' ? 'BMO' : 'UNKNOWN';
}

/** True when the instant falls on `date` in the stock's exchange zone, before that session's open. */
function beforeLocalOpen(stock: Pick<EuropeStock, 'exchange'>, instant: DateTime, date: string): boolean {
  const ex = EXCHANGES[stock.exchange];
  const local = instant.setZone(ex.zone);
  return local.isValid && local.toISODate() === date && local.hour * 60 + local.minute < ex.openMin;
}

/**
 * Whether SEC proves a release before the local open on `date`: a results 6-K (8-K for 8-K filers) for the period
 * `date` closes, filed (ET) on `date` or the day before, accepted on `date` before the stock's session open. A results
 * filing accepted after the open proves nothing (the RNS may have come earlier). Full level with a CIK and a fiscal year
 * end only; any SEC failure is no proof.
 */
async function secProvesBmo(
  ctx: EuropeJobContext, stock: EuropeStock, date: string, filingsOf: (cik: number) => Promise<Filing[]>,
): Promise<boolean> {
  const http = ctx.secHttp;
  const cik = stock.cik;
  const fy = stock.fyEndMonth;
  if (!http || stock.level !== 'full' || cik == null || fy == null) return false;
  const periodEnd = europePeriodFor(date, fy).periodEnd;
  const dayBefore = DateTime.fromISO(date, { zone: 'utc' }).minus({ days: 1 }).toISODate()!;
  const profile = ctx.market === 'UK' ? 'uk' : 'eu';
  const ex = EXCHANGES[stock.exchange];
  const session = { zone: ex.zone, openMin: ex.openMin, closeMin: ex.closeMin };
  try {
    const filings = (await filingsOf(cik))
      .filter((f) => f.form === (stock.secForm ?? '6-K') && (f.filingDate === date || f.filingDate === dayBefore));
    for (const f of filings) {
      const docs = parseFilingDocs(await http.text(f.indexUrl), f.indexUrl);
      const picked = pickReleaseDoc(docs);
      if (!picked) continue;
      const classify = async (url: string) => classifySixK(await http.text(url), { profile, filedOn: date, fyEndMonth: fy, session });
      let kind = await classify(picked);
      const main = docs.find((d) => /^[68]-K(\/A)?$/i.test(d.type))?.url;
      if (kind.kind === 'other' && main && main !== picked) kind = await classify(main);
      if (kind.kind !== 'results' || kind.periodEnd !== periodEnd) continue;
      const accepted = DateTime.fromISO(await fetchAcceptance(http, cik, f.accession), { zone: ET });
      if (beforeLocalOpen(stock, accepted, date)) return true;
    }
  } catch (err) {
    console.warn(`[${profile}-prev-moves] ${stock.symbol}: SEC timing check failed: ${(err as Error).message}`);
  }
  return false;
}

/**
 * Close-to-close move after each stock's previous report (JP rules on the exchange's own calendar; LSE with the stored
 * gov.uk dates), for rows dated `[today−1, today+14]` plus tier A (visible ∪ watched) rows to +180 days, without a
 * previous move and not checked in the last 20 h; at most `budget` (600) close fetches, nearest report first. The prior
 * date is the latest released report this app has; else, at full level, the ADR's US row as a local date
 * (`europeLocalDateFromUs`: US AMC → the next local trading day); else a stored Yahoo past date. Every prior date must
 * lie 45–140 days back. Its timing must be known (controller ruling, Task 21: uncertain means blank): the stored timing
 * of the app's own release, or that release's SEC acceptance before the local open on its date (BMO); a US AMC row
 * (BMO on the next local trading day); a stated Yahoo past-date timing; else, at full level, a results 6-K accepted
 * before the local open on the prior date (`secProvesBmo`). Unknown timing → no previous move (blank), never an
 * assumed window. A failed close fetch leaves the row to be retried; a miss never blanks an earlier value.
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
  // One SEC filing list per CIK per run (the SEC timing check).
  const filingCache = new Map<number, Promise<Filing[]>>();
  const filingsOf = (cik: number): Promise<Filing[]> => {
    let p = filingCache.get(cik);
    if (!p) filingCache.set(cik, (p = fetchEarningsFilings(ctx.secHttp!, cik)));
    return p;
  };

  for (const r of [...near, ...watched].sort((a, b) => a.reportDate.localeCompare(b.reportDate) || a.id - b.id)) {
    if (budget <= 0) break;
    const stock = stocks.get(r.symbol);
    if (!stock) continue;
    const inWindow = (d: string) => daysBetween(r.reportDate, d) >= MIN_DAYS && daysBetween(r.reportDate, d) <= MAX_DAYS;

    let prior: { date: string; timing: LocalTiming } | null = null;
    const own = priorEuropeReleased(ctx.db, r.symbol, r.reportDate);
    // Outside 45–140 days it is not the previous period's release: fall through to the other sources.
    if (own && inWindow(own.reportDate)) {
      const secBmo = own.releasedSource === 'sec' && own.releasedAt != null
        && beforeLocalOpen(stock, DateTime.fromISO(own.releasedAt, { zone: 'utc' }), own.reportDate);
      prior = { date: own.reportDate, timing: own.known ? own.timing : secBmo ? 'BMO' : 'UNKNOWN' };
    }
    if (!prior && stock.level === 'full' && stock.adr) {
      const us = usAdrRows(ctx.db, stock.adr, addDaysEurope(ctx, r.reportDate, -MAX_DAYS - 1), r.reportDate)
        .map((u) => ({ date: europeLocalDateFromUs(ctx.db, stock.exchange, u.reportDate, u.timing), timing: localTimingFromUs(u.timing) }))
        .filter((u) => inWindow(u.date))
        .sort((a, b) => b.date.localeCompare(a.date))[0];
      if (us) prior = us;
    }
    if (!prior) {
      const past = europePastDates(ctx.db, r.symbol).find((d) => inWindow(d.date));
      if (past) prior = { date: past.date, timing: past.timing ?? 'UNKNOWN' };
    }
    if (prior && prior.timing === 'UNKNOWN' && await secProvesBmo(ctx, stock, prior.date, filingsOf)) prior = { ...prior, timing: 'BMO' };
    // No prior, or a prior whose timing is not known: blank (checked), never an assumed window.
    if (!prior || prior.timing === 'UNKNOWN') { setEuropePrevMove(ctx.db, r.id, null, now); continue; }

    const cal = calOf(stock.exchange);
    const w = reactionWindow(cal, prior.date, prior.timing);
    budget--;
    const closes = await trackIn(ctx, yahooSource(ctx, 'closes'),
      () => ctx.yahooCloses(r.symbol, cal.addDays(w.before, -5), cal.addDays(w.after, 1)));
    if (!closes) continue; // fetch failed: retried next run
    const pct = reactionMovePct(closes, w);
    setEuropePrevMove(ctx.db, r.id, pct == null ? null : { pct, date: prior.date, basis: 'known' }, now);
  }
}
