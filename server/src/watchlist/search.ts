import type { SecTicker } from '../sources/sec.js';
import type { Http } from '../sources/http.js';
import { fetchKiteInstruments } from '../india/sources/foList.js';
import type { SymbolEntry } from '../api/types.js';
import type { WatchMarket } from './store.js';

export type { SymbolEntry };

const words = (s: string) => s.toUpperCase().split(/[^A-Z0-9&]+/).filter(Boolean);

/** Exact symbol, then symbol prefix, then name word prefix. Ties: shorter symbol, then alphabetical. */
export function rankSymbols(entries: SymbolEntry[], q: string, limit = 20): SymbolEntry[] {
  const needle = q.trim().toUpperCase();
  if (!needle) return [];
  const scored: [number, SymbolEntry][] = [];
  for (const e of entries) {
    const sym = e.symbol.toUpperCase();
    const rank = sym === needle ? 0 : sym.startsWith(needle) ? 1 : words(e.name).some((w) => w.startsWith(needle)) ? 2 : -1;
    if (rank >= 0) scored.push([rank, e]);
  }
  scored.sort((a, b) => a[0] - b[0] || a[1].symbol.length - b[1].symbol.length || a[1].symbol.localeCompare(b[1].symbol));
  return scored.slice(0, limit).map(([, e]) => e);
}

/** In-memory symbol lists per market. Loaded in the background, never inside a request. */
export class SymbolIndex {
  private lists: Record<WatchMarket, SymbolEntry[]> = { US: [], IN: [] };
  private sets: Record<WatchMarket, Set<string>> = { US: new Set(), IN: new Set() };
  set(market: WatchMarket, entries: SymbolEntry[]): void {
    this.lists[market] = entries;
    this.sets[market] = new Set(entries.map((e) => e.symbol));
  }
  size(market: WatchMarket): number { return this.lists[market].length; }
  has(market: WatchMarket, symbol: string): boolean { return this.sets[market].has(symbol); }
  search(market: WatchMarket, q: string, limit = 20): SymbolEntry[] { return rankSymbols(this.lists[market], q, limit); }
}

export function usEntries(tickers: Map<string, SecTicker>): SymbolEntry[] {
  return [...tickers].map(([symbol, t]) => ({ symbol, name: t.name ?? '', exchange: t.exchange ?? '' }));
}

export async function loadInEntries(http: Http): Promise<SymbolEntry[]> {
  return (await fetchKiteInstruments(http, 'NSE'))
    .filter((i) => i.exchange === 'NSE' && i.segment === 'NSE' && i.instrumentType === 'EQ')
    .map((i) => ({ symbol: i.tradingsymbol, name: i.name, exchange: 'NSE' }));
}

/**
 * Loads the lists now and every 24 h. A failed load keeps the previous list; the timer does not keep the process alive.
 * Until a market is loaded its search is empty and PUT falls back to a format check.
 */
export function startSymbolRefresh(
  index: SymbolIndex,
  loaders: Partial<Record<WatchMarket, () => Promise<SymbolEntry[]>>>,
  intervalMs = 24 * 3_600_000,
): () => void {
  const run = () => {
    for (const m of ['US', 'IN'] as const) {
      const load = loaders[m];
      if (!load) continue;
      load().then(
        (list) => { if (list.length > 0) index.set(m, list); },
        (e) => console.warn(`symbol index ${m}:`, e instanceof Error ? e.message : e),
      );
    }
  };
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
