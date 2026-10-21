import type { SecTicker } from '../sources/sec.js';
import type { Http } from '../sources/http.js';
import { fetchKiteInstruments } from '../india/sources/foList.js';
import type { SymbolEntry } from '../api/types.js';
import type { Db } from '../db/repo.js';
import type { WatchMarket } from './store.js';

export type { SymbolEntry };

/** An index entry; `weight` (market cap) orders ties within a match class, `words` is precomputed. */
export type IndexEntry = SymbolEntry & { weight?: number; words?: string[] };

const words = (s: string) => s.toUpperCase().split(/[^A-Z0-9&]+/).filter(Boolean);

/**
 * Exact symbol, then symbol prefix, then name word prefix. Within a class: larger weight (market cap) first,
 * then shorter symbol, then alphabetical.
 */
export function rankSymbols(entries: IndexEntry[], q: string, limit = 20): SymbolEntry[] {
  const needle = q.trim().toUpperCase();
  if (!needle) return [];
  const scored: [number, IndexEntry][] = [];
  for (const e of entries) {
    const sym = e.symbol.toUpperCase();
    const rank = sym === needle ? 0 : sym.startsWith(needle) ? 1 : (e.words ?? words(e.name)).some((w) => w.startsWith(needle)) ? 2 : -1;
    if (rank >= 0) scored.push([rank, e]);
  }
  scored.sort((x, y) => x[0] - y[0] || (y[1].weight ?? 0) - (x[1].weight ?? 0)
    || x[1].symbol.length - y[1].symbol.length || x[1].symbol.localeCompare(y[1].symbol));
  return scored.slice(0, limit).map(([, e]) => ({ symbol: e.symbol, name: e.name, exchange: e.exchange }));
}

/** In-memory symbol lists per market. Loaded in the background, never inside a request. */
export class SymbolIndex {
  private lists: Record<WatchMarket, IndexEntry[]> = { US: [], IN: [] };
  private sets: Record<WatchMarket, Set<string>> = { US: new Set(), IN: new Set() };
  set(market: WatchMarket, entries: IndexEntry[]): void {
    this.lists[market] = entries.map((e) => ({ ...e, words: words(e.name) }));
    this.sets[market] = new Set(entries.map((e) => e.symbol));
  }
  size(market: WatchMarket): number { return this.lists[market].length; }
  has(market: WatchMarket, symbol: string): boolean { return this.sets[market].has(symbol); }
  search(market: WatchMarket, q: string, limit = 20): SymbolEntry[] { return rankSymbols(this.lists[market], q, limit); }
}

/** US weight = largest market cap seen for the symbol in reports. */
export function usEntries(tickers: Map<string, SecTicker>, db?: Db): IndexEntry[] {
  const caps = new Map<string, number>();
  if (db) {
    for (const r of db.prepare('SELECT symbol_key AS k, MAX(market_cap) AS cap FROM reports WHERE market_cap IS NOT NULL GROUP BY symbol_key').all() as { k: string; cap: number }[]) caps.set(r.k, r.cap);
  }
  return [...tickers].map(([symbol, t]) => ({ symbol, name: t.name ?? '', exchange: t.exchange ?? '', weight: caps.get(symbol) }));
}

/** India weight = in_stocks market cap; F&O stocks without one still rank above the rest (weight 1). */
export async function loadInEntries(http: Http, db?: Db): Promise<IndexEntry[]> {
  const w = new Map<string, number>();
  if (db) {
    for (const r of db.prepare('SELECT symbol, market_cap AS cap, active FROM in_stocks').all() as { symbol: string; cap: number | null; active: number }[]) w.set(r.symbol, r.cap ?? (r.active ? 1 : 0));
  }
  return (await fetchKiteInstruments(http, 'NSE'))
    .filter((i) => i.exchange === 'NSE' && i.segment === 'NSE' && i.instrumentType === 'EQ')
    .map((i) => ({ symbol: i.tradingsymbol, name: i.name, exchange: 'NSE', weight: w.get(i.tradingsymbol) }));
}

/**
 * Loads the lists now and every 24 h. A failed load keeps the previous list; the timer does not keep the process alive.
 * Until a market is loaded its search is empty and PUT falls back to a format check.
 */
export function startSymbolRefresh(
  index: SymbolIndex,
  loaders: Partial<Record<WatchMarket, () => Promise<IndexEntry[]>>>,
  intervalMs = 24 * 3_600_000,
  retryMs = 5 * 60_000,
): () => void {
  const timers = new Map<WatchMarket, NodeJS.Timeout>();
  let stopped = false;
  // Each market reloads daily; until its first successful load it retries every retryMs.
  const run = (m: WatchMarket) => {
    const load = loaders[m];
    if (!load || stopped) return;
    load().then(
      (list) => { if (list.length > 0) index.set(m, list); return list.length > 0; },
      (e) => { console.warn(`symbol index ${m}:`, e instanceof Error ? e.message : e); return false; },
    ).then((ok) => {
      if (stopped) return;
      const t = setTimeout(() => run(m), ok || index.size(m) > 0 ? intervalMs : retryMs);
      t.unref();
      timers.set(m, t);
    });
  };
  run('US');
  run('IN');
  return () => { stopped = true; for (const t of timers.values()) clearTimeout(t); };
}
