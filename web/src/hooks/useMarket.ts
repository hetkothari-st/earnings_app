import { useCallback, useEffect, useRef, useState } from 'react';
import { type Market, getStoredMarket, isMarket, setStoredMarket } from '../lib/market';
import { apiFetch } from '../api';

export function useMarket(): { market: Market; setMarket: (m: Market) => void } {
  const [market, setMarketState] = useState<Market>(() => getStoredMarket() ?? 'US');
  // A choice made on this page wins over a server answer that arrives after it.
  const picked = useRef(false);

  // The server remembers the choice per user; the local copy only avoids a flash on load.
  useEffect(() => {
    let alive = true;
    apiFetch('/api/prefs')
      .then((r) => (r.ok ? (r.json() as Promise<{ market: Market }>) : null))
      .then((body) => {
        if (alive && !picked.current && body && isMarket(body.market)) {
          setMarketState(body.market);
          setStoredMarket(body.market);
        }
      })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const setMarket = useCallback((m: Market) => {
    picked.current = true;
    setMarketState(m);
    setStoredMarket(m);
    // Persist to server (best-effort)
    apiFetch('/api/prefs', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ market: m }),
    }).catch(() => {});
  }, []);

  return { market, setMarket };
}
