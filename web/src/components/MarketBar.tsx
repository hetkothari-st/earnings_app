import { useEffect, useState } from 'react';
import type { MarketIndexDto, MarketsResponse } from '../../../server/src/api/types';
import { apiFetch, type InMarket } from '../api';
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

/** Polls /api/markets every 15 s; renders nothing until the first answer. */
export function LiveMarketBar() {
  const [indices, setIndices] = useState<MarketIndexDto[] | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => apiFetch('/api/markets')
      .then((r) => (r.ok ? (r.json() as Promise<MarketsResponse>) : null))
      .then((b) => { if (alive && b) setIndices(b.indices); })
      .catch(() => {});
    load();
    const t = setInterval(load, 15_000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  return indices ? <MarketBar indices={indices} /> : null;
}

const IN_EXCHANGE: Record<string, string> = { SENSEX: 'BSE' };
const inLevel = (n: number | null) =>
  n == null ? '—' : n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * NIFTY 50, SENSEX, NIFTY BANK, NIFTY MIDCAP 100. `live` carries Kite ticks pushed over the live stream;
 * /api/in/markets (every 15 s) fills the rest and is the Yahoo fallback.
 */
export function IndiaMarketBar({ live = [] }: { live?: InMarket[] }) {
  const [polled, setIndices] = useState<InMarket[] | null>(null);
  const byName = new Map(live.map((m) => [m.index, m]));
  const indices = polled?.map((m) => byName.get(m.index) ?? m) ?? null;
  useEffect(() => {
    let alive = true;
    const load = () => apiFetch('/api/in/markets')
      .then((r) => (r.ok ? (r.json() as Promise<{ indices: InMarket[] }>) : null))
      .then((b) => { if (alive && b) setIndices(b.indices); })
      .catch(() => {});
    load();
    const t = setInterval(load, 15_000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  if (!indices) return null;
  return (
    <section className="markets markets-in" aria-label="Indian markets">
      {indices.map((m) => (
        <div key={m.index} className="market" title={m.source === 'yahoo' ? 'Delayed (Yahoo); live Kite price not available' : undefined}>
          <span className="market-exchange">{IN_EXCHANGE[m.index] ?? 'NSE'}</span>
          <span className="market-index">{m.index}{m.source === 'yahoo' ? ' · delayed' : ''}</span>
          <span className="market-level">{inLevel(m.price)}</span>
          <span className={`market-change ${changeClass(m.changePct)}`}>{formatChange(m.changePct)}</span>
        </div>
      ))}
    </section>
  );
}
