import { isNseTradingDay, nextNseTradingDay, prevNseTradingDay, addDaysIST, type InTiming } from './nseCalendar.js';

/** Expected move from a Kite at-the-money straddle. */
export interface InExpectedMove {
  symbol: string;
  expiry: string;       // YYYY-MM-DD
  strike: number;
  callMid: number;
  putMid: number;
  underlying: number;
  movePct: number;
  illiquid: boolean;
  snapshotAt: string;   // ISO UTC
}

/** Best bid/ask of one option (0 = no order on that side). */
export interface OptionTop { strike: number; type: 'CE' | 'PE'; bid: number; ask: number }

/** First expiry that captures the reaction: before-open may use an expiry on the day, anything else needs a later one. */
export function chooseInExpiry(expiries: string[], reportDate: string, timing: InTiming): string | null {
  const sorted = [...new Set(expiries)].sort();
  return (timing === 'BMO' ? sorted.find((e) => e >= reportDate) : sorted.find((e) => e > reportDate)) ?? null;
}

const twoSided = (o: OptionTop | undefined): o is OptionTop => !!o && o.ask > 0 && o.bid >= 0 && o.ask >= o.bid;

/**
 * Straddle at the strike nearest the price among strikes quoted on both sides for call and put.
 * Null when nothing is quoted, the price is unknown, or that strike is more than 10% from the price
 * (then the straddle is mostly intrinsic value, not an earnings premium).
 */
export function computeInExpectedMove(
  quotes: OptionTop[], underlying: number, expiry: string, symbol: string,
): Omit<InExpectedMove, 'snapshotAt'> | null {
  if (!(underlying > 0)) return null;
  const pairs = new Map<number, { CE?: OptionTop; PE?: OptionTop }>();
  for (const q of quotes) pairs.set(q.strike, { ...pairs.get(q.strike), [q.type]: q });
  const strikes = [...pairs.entries()].filter(([, p]) => twoSided(p.CE) && twoSided(p.PE)).map(([k]) => k);
  if (strikes.length === 0) return null;
  const strike = strikes.reduce((best, k) => (Math.abs(k - underlying) < Math.abs(best - underlying) ? k : best));
  if (Math.abs(strike - underlying) / underlying > 0.1) return null;
  const { CE: call, PE: put } = pairs.get(strike) as { CE: OptionTop; PE: OptionTop };
  const callMid = (call.bid + call.ask) / 2;
  const putMid = (put.bid + put.ask) / 2;
  const illiquid = call.bid <= 0 || put.bid <= 0 || call.ask - call.bid > 0.3 * callMid || put.ask - put.bid > 0.3 * putMid;
  return {
    symbol, expiry, strike, callMid, putMid, underlying,
    movePct: Math.round(((callMid + putMid) / underlying) * 10000) / 100,
    illiquid,
  };
}

/**
 * The trading day whose close is the last one before the release: the result day itself for
 * after-close results (if it trades), else the trading day before it.
 */
export function finalSnapshotDay(reportDate: string, timing: InTiming): string {
  if (timing === 'AMC' && isNseTradingDay(reportDate)) return reportDate;
  return prevNseTradingDay(reportDate);
}

/** Close-to-close days around a report: before/during market → prev close to that day's close; after close → that close to the next. */
export function reactionWindow(reportDate: string, timing: Exclude<InTiming, 'UNKNOWN'>): { before: string; after: string } {
  if (timing === 'AMC') {
    const before = isNseTradingDay(reportDate) ? reportDate : prevNseTradingDay(reportDate);
    return { before, after: nextNseTradingDay(addDaysIST(reportDate, 1)) };
  }
  // Results on a non-trading day react at the next session.
  if (!isNseTradingDay(reportDate)) return { before: prevNseTradingDay(reportDate), after: nextNseTradingDay(reportDate) };
  return { before: prevNseTradingDay(reportDate), after: reportDate };
}

/** Percent change from one close to another, 2 decimals; null if either close is missing. */
export function reactionMovePct(closes: Map<string, number>, w: { before: string; after: string }): number | null {
  const a = closes.get(w.before);
  const b = closes.get(w.after);
  if (a == null || b == null || !(a > 0)) return null;
  return Math.round(((b - a) / a) * 10000) / 100;
}
