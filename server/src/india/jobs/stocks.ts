import type { DatabaseSync } from 'node:sqlite';
import { matchableStocks, saveFoList, setEqTokens } from '../db/inRepo.js';
import { equityTokens, fetchFoList, fetchKiteInstruments } from '../sources/foList.js';
import { buildSymbolIndex } from '../sources/symbolMatch.js';
import { type InJobContext, guardedIn, trackIn } from './context.js';

/** The current F&O list plus watched stocks, in memory, for matching feed items to symbols. */
export interface FoCache {
  symbols: Set<string>;
  nameIndex: Map<string, string>;
  names: Map<string, string>;   // symbol -> F&O list name
}

let _cache: FoCache | null = null;

export function loadFoCache(db: DatabaseSync): FoCache | null {
  const stocks = matchableStocks(db); // F&O plus watched; names of watched stocks come from the Kite list
  _cache = stocks.length
    ? {
        symbols: new Set(stocks.map((s) => s.symbol)),
        nameIndex: buildSymbolIndex(stocks.map((s) => ({ symbol: s.symbol, name: s.name }))),
        names: new Map(stocks.map((s) => [s.symbol, s.name])),
      }
    : null;
  return _cache;
}

export function getFoCache(): FoCache | null {
  return _cache;
}

/** NSE F&O list (the universe) and Kite NSE equity tokens (for prices and candles). */
export async function refreshInStocks(ctx: InJobContext): Promise<void> {
  // Backup: the stored list stays.
  const list = (await guardedIn(ctx, { name: 'nse-fo-list', run: () => fetchFoList(ctx.http) }))?.value;
  if (list) saveFoList(ctx.db, list, ctx.now());
  const nse = await trackIn(ctx, 'kite-instruments', () => fetchKiteInstruments(ctx.http, 'NSE'));
  if (nse) setEqTokens(ctx.db, equityTokens(nse));
  loadFoCache(ctx.db);
}
