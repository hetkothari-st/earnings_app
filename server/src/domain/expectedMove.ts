import type { ExpectedMove, OptionChain, OptionQuote, Timing } from '../types.js';

const SYMBOL = /(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/;

export function parseOptionSymbol(symbol: string): { expiry: string; type: 'C' | 'P'; strike: number } | null {
  const m = SYMBOL.exec(symbol);
  if (!m) return null;
  const [, yy, mm, dd, type, strike] = m;
  return { expiry: `20${yy}-${mm}-${dd}`, type: type as 'C' | 'P', strike: Number(strike) / 1000 };
}

/** First expiry that captures the earnings reaction (spec 6.2 step 1). */
export function chooseExpiry(expiries: string[], reportDate: string, timing: Timing): string | null {
  const sorted = [...new Set(expiries)].sort();
  const found = timing === 'BMO' ? sorted.find((e) => e >= reportDate) : sorted.find((e) => e > reportDate);
  return found ?? null;
}

const mid = (o: OptionQuote) => (o.bid + o.ask) / 2;
const twoSided = (o: OptionQuote | undefined): o is OptionQuote => !!o && o.ask > 0 && o.bid >= 0 && o.ask >= o.bid;

export function computeExpectedMove(chain: OptionChain, reportDate: string, timing: Timing): ExpectedMove | null {
  const u = chain.underlying;
  if (!(u > 0)) return null;
  const expiry = chooseExpiry(chain.quotes.map((x) => x.expiry), reportDate, timing);
  if (!expiry) return null;

  const pairs = new Map<number, { call?: OptionQuote; put?: OptionQuote }>();
  for (const o of chain.quotes) {
    if (o.expiry !== expiry) continue;
    const p = pairs.get(o.strike) ?? {};
    if (o.type === 'C') p.call = o;
    else p.put = o;
    pairs.set(o.strike, p);
  }
  const strikes = [...pairs.entries()]
    .filter(([, p]) => twoSided(p.call) && twoSided(p.put))
    .map(([k]) => k)
    .sort((a, b) => a - b);
  if (strikes.length === 0) return null;

  let strike = strikes[0]!;
  for (const k of strikes) if (Math.abs(k - u) < Math.abs(strike - u)) strike = k;
  const pair = (k: number) => pairs.get(k) as { call: OptionQuote; put: OptionQuote };
  // Time value of the straddle at strike k (excludes intrinsic value |u - k|).
  const timeValue = (k: number) => mid(pair(k).call) + mid(pair(k).put) - Math.abs(u - k);
  const isIlliquid = (k: number) => {
    const { call, put } = pair(k);
    return call.bid <= 0 || put.bid <= 0 || call.ask - call.bid > 0.3 * mid(call) || put.ask - put.bid > 0.3 * mid(put);
  };

  // The at-the-money straddle at the exact price is estimated by interpolating time value between the
  // strikes either side of the price; off-strike intrinsic value would otherwise inflate the move.
  const below = strikes.filter((k) => k <= u).pop();
  const above = strikes.find((k) => k >= u);
  let tv: number;
  let used: number[];
  if (below != null && above != null && below !== above) {
    const w = (u - below) / (above - below);
    tv = timeValue(below) * (1 - w) + timeValue(above) * w;
    used = [below, above];
  } else {
    tv = timeValue(strike);
    used = [strike];
  }
  if (!(tv > 0)) return null;

  const { call, put } = pair(strike);
  return {
    expiry,
    strike,
    callMid: mid(call),
    putMid: mid(put),
    underlying: u,
    movePct: Math.round((tv / u) * 10000) / 100,
    illiquid: used.some(isIlliquid),
  };
}
