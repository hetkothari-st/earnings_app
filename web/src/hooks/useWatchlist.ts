import { useCallback, useEffect, useRef, useState } from 'react';
import { deleteWatch, fetchWatchlist, putWatch } from '../api';
import type { Market } from '../lib/market';

export interface Watchlist {
  symbols: Set<string>;
  add: (symbol: string) => Promise<void>;
  remove: (symbol: string) => Promise<void>;
}

/** The signed-in user's watched symbols for one market. Changes show at once and are undone if the server refuses. */
export function useWatchlist(market: Market): Watchlist {
  const [symbols, setSymbols] = useState<Set<string>>(new Set());
  const current = useRef(market);
  current.current = market;

  useEffect(() => {
    let alive = true;
    setSymbols(new Set());
    fetchWatchlist(market).then((list) => { if (alive) setSymbols(new Set(list)); }).catch(() => {});
    return () => { alive = false; };
  }, [market]);

  const change = useCallback(async (symbol: string, on: boolean) => {
    const m = market;
    const apply = (want: boolean) => setSymbols((prev) => {
      if (current.current !== m) return prev;
      const next = new Set(prev);
      if (want) next.add(symbol); else next.delete(symbol);
      return next;
    });
    apply(on);
    try {
      await (on ? putWatch(m, symbol) : deleteWatch(m, symbol));
    } catch (e) {
      apply(!on);
      throw e;
    }
  }, [market]);

  const add = useCallback((s: string) => change(s, true), [change]);
  const remove = useCallback((s: string) => change(s, false), [change]);
  return { symbols, add, remove };
}
