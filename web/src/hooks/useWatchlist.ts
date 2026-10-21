import { useCallback, useEffect, useRef, useState } from 'react';
import { deleteWatch, fetchWatchlist, HttpError, putWatch } from '../api';
import type { Market } from '../lib/market';

export interface Watchlist {
  symbols: Set<string>;
  add: (symbol: string) => Promise<void>;
  remove: (symbol: string) => Promise<void>;
  /** Bumped each time the server confirms a change; views reload their rows on it. */
  version: number;
  /** A short message about the last failed change, cleared on the next change or after a few seconds. */
  error: string | null;
}

function describe(symbol: string, on: boolean, e: unknown): string {
  const status = e instanceof HttpError ? e.status : 0;
  if (on && status === 400) return `Could not add ${symbol}: not a listed symbol`;
  if (on && status === 409) return 'Watchlist is full (200)';
  return `Could not ${on ? 'add' : 'remove'} ${symbol}, try again`;
}

/** The signed-in user's watched symbols for one market. Changes show at once and are undone if the server refuses. */
export function useWatchlist(market: Market): Watchlist {
  const [symbols, setSymbols] = useState<Set<string>>(new Set());
  const [version, setVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const current = useRef(market);
  current.current = market;
  /** Toggles made before the first server list arrived; they win over it. */
  const touched = useRef(new Map<string, boolean>());
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    touched.current = new Map();
    setSymbols(new Set());
    fetchWatchlist(market).then((list) => {
      if (!alive) return;
      const next = new Set(list);
      for (const [s, on] of touched.current) { if (on) next.add(s); else next.delete(s); }
      touched.current = new Map();
      setSymbols(next);
    }).catch(() => {});
    return () => { alive = false; };
  }, [market]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const change = useCallback(async (symbol: string, on: boolean) => {
    const m = market;
    const apply = (want: boolean) => setSymbols((prev) => {
      if (current.current !== m) return prev;
      const next = new Set(prev);
      if (want) next.add(symbol); else next.delete(symbol);
      return next;
    });
    window.clearTimeout(timer.current);
    setError(null);
    touched.current.set(symbol, on);
    apply(on);
    try {
      await (on ? putWatch(m, symbol) : deleteWatch(m, symbol));
      if (current.current === m) setVersion((v) => v + 1);
    } catch (e) {
      touched.current.set(symbol, !on);
      apply(!on);
      if (current.current === m) {
        setError(describe(symbol, on, e));
        timer.current = window.setTimeout(() => setError(null), 6000);
      }
      throw e;
    }
  }, [market]);

  const add = useCallback((s: string) => change(s, true), [change]);
  const remove = useCallback((s: string) => change(s, false), [change]);
  return { symbols, add, remove, version, error };
}
