import { useEffect, useState } from 'react';
import type { MarketIndexDto, MarketsResponse } from '../../../server/src/api/types';
import { apiFetch } from '../api';
import { changeClass, formatChange } from '../lib/format';

const level = (n: number | null) =>
  n == null ? '—' : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Headline index of each of the world's five largest exchanges. */
export function MarketBar({ indices }: { indices: MarketIndexDto[] }) {
  return (
    <section className="markets" aria-label="World markets">
      {indices.map((m) => (
        <div key={m.symbol} className="market">
          <span className="market-exchange">{m.exchange}</span>
          <span className="market-index">{m.index}</span>
          <span className="market-level">{level(m.price)}</span>
          <span className={`market-change ${changeClass(m.changePct)}`}>{formatChange(m.changePct)}</span>
        </div>
      ))}
    </section>
  );
}

/** Polls /api/markets every minute; renders nothing until the first answer. */
export function LiveMarketBar() {
  const [indices, setIndices] = useState<MarketIndexDto[] | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => apiFetch('/api/markets')
      .then((r) => (r.ok ? (r.json() as Promise<MarketsResponse>) : null))
      .then((b) => { if (alive && b) setIndices(b.indices); })
      .catch(() => {});
    load();
    const t = setInterval(load, 60_000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  return indices ? <MarketBar indices={indices} /> : null;
}
