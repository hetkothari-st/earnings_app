import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchHidden, saveHidden } from '../api';
import { readJson, writeJson } from '../lib/storage';

const KEY = 'hiddenTickers';

/**
 * Hidden tickers for the signed-in user. The server list is the source of truth; until it answers
 * (or if it cannot be reached) the browser's saved list is used. On the first server load, an
 * empty server list is seeded from the browser list once, and the browser copy is then removed.
 */
export function useHidden(): { hidden: Set<string>; toggle: (symbol: string) => void } {
  const [hidden, setHidden] = useState<Set<string>>(() => new Set(readJson<string[]>(KEY, [])));
  const current = useRef(hidden);
  current.current = hidden;
  const synced = useRef(false);
  // Saves run one after another so the last toggle always wins on the server.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const enqueueSave = useCallback((symbols: string[]) => {
    queue.current = queue.current.then(() => saveHidden(symbols)).catch(() => {});
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    fetchHidden(ac.signal)
      .then((server) => {
        if (ac.signal.aborted) return;
        synced.current = true;
        const local = [...current.current];
        if (server.length === 0 && local.length > 0) enqueueSave(local);
        else setHidden(new Set(server));
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
    setHidden(next);
    if (synced.current) enqueueSave([...next]);
    else writeJson(KEY, [...next]);
  }, [enqueueSave]);

  return { hidden, toggle };
}
