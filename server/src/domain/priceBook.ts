export interface LivePrice {
  price: number;
  prevClose: number | null;
  changePct: number | null; // vs previous close, 2 decimals
  time: number;             // ms epoch of the trade or quote
}

export interface Trade { s: string; p: number; t: number }

const change = (price: number, prev: number | null) =>
  prev && prev > 0 ? Math.round(((price - prev) / prev) * 10000) / 100 : null;

/** Latest price per symbol, from the live trade stream and quote snapshots. */
export class PriceBook {
  private prices = new Map<string, LivePrice>();
  private closes = new Map<string, number>();

  setPrevClose(symbol: string, prevClose: number): void {
    this.closes.set(symbol, prevClose);
    const p = this.prices.get(symbol);
    if (p) this.prices.set(symbol, { ...p, prevClose, changePct: change(p.price, prevClose) });
  }

  /** Seeds from a quote snapshot (e.g. before the first trade, or outside market hours). */
  setQuote(symbol: string, q: { price: number; prevClose: number; time: number }): void {
    this.closes.set(symbol, q.prevClose);
    const p = this.prices.get(symbol);
    if (p && p.time >= q.time) return;
    this.prices.set(symbol, { price: q.price, prevClose: q.prevClose, changePct: change(q.price, q.prevClose), time: q.time });
  }

  /** Applies trades; returns the symbols whose price changed. Older trades never overwrite newer ones. */
  applyTrades(trades: Trade[]): string[] {
    const changed = new Set<string>();
    for (const tr of trades) {
      const cur = this.prices.get(tr.s);
      if (cur && cur.time > tr.t) continue;
      if (cur && cur.price === tr.p) { cur.time = tr.t; continue; }
      const prev = this.closes.get(tr.s) ?? null;
      this.prices.set(tr.s, { price: tr.p, prevClose: prev, changePct: change(tr.p, prev), time: tr.t });
      changed.add(tr.s);
    }
    return [...changed];
  }

  get(symbol: string): LivePrice | undefined {
    return this.prices.get(symbol);
  }

  has(symbol: string): boolean {
    return this.closes.has(symbol);
  }

  snapshot(symbols: Iterable<string>): Record<string, LivePrice> {
    const out: Record<string, LivePrice> = {};
    for (const s of symbols) {
      const p = this.prices.get(s);
      if (p) out[s] = p;
    }
    return out;
  }
}
