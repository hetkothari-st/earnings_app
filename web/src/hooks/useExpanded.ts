import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchExpanded, saveExpanded } from '../api';
import { readJson, writeJson } from '../lib/storage';

const KEY = 'expandedTickers';

/**
 * Tickers the signed-in user has expanded. The server list is the source of truth; until it answers
 * (or if it cannot be reached) the browser's saved list is used. On the first server load, an empty
 * server list is seeded once from the browser list, and the browser copy is then removed so it can
 * never leak into another account on the same browser.
 */
export function useExpanded(): { expanded: Set<string>; toggle: (symbol: string) => void } {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(readJson<string[]>(KEY, [])));
  const current = useRef(expanded);
  current.current = expanded;
  const synced = useRef(false);
  // Saves run one after another so the last toggle always wins on the server.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const enqueueSave = useCallback((symbols: string[]) => {
    queue.current = queue.current.then(() => saveExpanded(symbols)).catch(() => {});
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    fetchExpanded(ac.signal)
      .then((server) => {
        if (ac.signal.aborted) return;
        synced.current = true;
        const local = [...current.current];
        if (server.length === 0 && local.length > 0) enqueueSave(local);
        else setExpanded(new Set(server));
        try { localStorage.removeItem(KEY); } catch { /* storage blocked */ }
      })
      .catch(() => { /* Offline or signed out: keep the browser list. */ });
    return () => ac.abort();
  }, [enqueueSave]);

  const toggle = useCallback((symbol: string) => {
    const next = new Set(current.current);
    if (next.has(symbol)) next.delete(symbol);
    else next.add(symbol);
    current.current = next;
    setExpanded(next);
    if (synced.current) enqueueSave([...next]);
    else writeJson(KEY, [...next]);
  }, [enqueueSave]);

  return { expanded, toggle };
}
