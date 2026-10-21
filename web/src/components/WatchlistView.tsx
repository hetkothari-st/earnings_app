import { useEffect, useState } from 'react';
import { DateTime } from 'luxon';
import type { InReportDto } from '../../../server/src/india/api/types';
import type { ReportDto } from '../../../server/src/api/types';
import { fetchWatchRows, type WatchRow } from '../api';
import type { Watchlist } from '../hooks/useWatchlist';
import { changeClass, formatChange, formatDateHeading, formatEps, formatEpsInr, formatInrCr, formatMoney } from '../lib/format';
import type { Market } from '../lib/market';
import { todayEt } from '../lib/time';
import { SymbolSearch } from './SymbolSearch';
import { Star } from './Star';
import { Tags } from './Tags';

type Price = { price: number; changePct: number | null; source?: string };
type Report = ReportDto | InReportDto;

interface Props {
  market: Market;
  prices: Record<string, Price>;
  watch: Watchlist;
  /** Changes whenever results or moves arrive on the live stream. */
  reloadKey?: number;
}

const rupees = (n: number) => `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct1 = (n: number) => (Math.round(n * 10 + 1e-9) / 10).toFixed(1);

function today(market: Market): string {
  return market === 'IN' ? DateTime.now().setZone('Asia/Kolkata').toISODate()! : todayEt();
}

function Figure({ label, actual, result, format, preliminary, corrected, basis }: {
  label: string; actual: number | null; result: string | null; format: (n: number | null) => string;
  preliminary: boolean; corrected: boolean; basis?: 'adjusted' | 'gaap' | null;
}) {
  if (actual == null) return null;
  const arrow = result === 'beat' ? ' ▲' : result === 'miss' ? ' ▼' : '';
  return (
    <span className="wl-fig">
      <span className="muted">{label} </span>
      <span className={`act ${result ?? ''}`}>{`${format(actual)}${arrow}`}</span>
      <Tags preliminary={preliminary} corrected={corrected} basis={basis} />
    </span>
  );
}

function Latest({ latest, market }: { latest: WatchRow['latest']; market: Market }) {
  if (!latest) return <span className="muted">—</span>;
  if ('source' in latest) {
    return <span className="wl-fig"><span className="muted">EPS </span>{(market === 'IN' ? formatEpsInr : formatEps)(latest.eps.actual)}<span className="muted"> from Yahoo</span></span>;
  }
  const r = latest as Report;
  const eps = market === 'IN' ? formatEpsInr : formatEps;
  const money = market === 'IN' ? formatInrCr : (n: number | null) => formatMoney(n, (r as ReportDto).revenue.currency);
  const basis = 'basis' in r.eps ? (r.eps as ReportDto['eps']).basis : null;
  const any = r.eps.actual != null || r.revenue.actual != null || ('profit' in r && r.profit.actual != null);
  if (!any) return <span className="muted">—</span>;
  return (
    <>
      <Figure label="EPS" actual={r.eps.actual} result={r.eps.result} format={eps} preliminary={r.eps.preliminary} corrected={r.eps.corrected} basis={basis} />
      <Figure label="Revenue" actual={r.revenue.actual} result={r.revenue.result} format={money} preliminary={r.revenue.preliminary} corrected={r.revenue.corrected} />
      {'profit' in r && <Figure label="Profit" actual={r.profit.actual} result={null} format={formatInrCr} preliminary={r.profit.preliminary} corrected={r.profit.corrected} />}
    </>
  );
}

export function WatchlistView({ market, prices, watch, reloadKey = 0 }: Props) {
  const [rows, setRows] = useState<WatchRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    fetchWatchRows(market, ac.signal)
      .then((r) => { setRows(r.rows); setError(null); })
      .catch((e: Error) => { if (!ac.signal.aborted) setError(e.message); });
    return () => ac.abort();
  }, [market, watch.version, reloadKey]);

  const t = today(market);
  const shown = (rows ?? []).filter((r) => watch.symbols.has(r.symbol));
  const money = (n: number) => (market === 'IN' ? rupees(n) : `$${n.toFixed(2)}`);

  return (
    <section className="watchlist" aria-label="Watchlist">
      <SymbolSearch market={market} onPick={(s) => { watch.add(s).catch(() => {}); }} />
      {error && <p className="warn-text">Could not load your watchlist: {error}</p>}
      {!error && rows === null && <p className="muted">Loading…</p>}
      {rows !== null && shown.length === 0 && <p className="empty">Nothing on your watchlist yet. Search above or tap a star on any stock.</p>}
      {shown.length > 0 && (
        <ul className="stocks watch-rows">
          {shown.map((r) => {
            const price = prices[r.symbol];
            const next = r.next;
            const em = next?.expectedMove;
            const latestDate = r.latest && r.latest.reportDate ? formatDateHeading(r.latest.reportDate) : '—';
            return (
              <li key={r.symbol} className="stock wl-row" data-symbol={market === 'US' ? r.symbol : undefined}>
                <span className="ticker">{r.symbol}</span>
                <span className="name wl-name">{r.name}</span>
                <span className="stock-price">
                  {price && (
                    <>
                      <span>{money(price.price)}</span>
                      {price.changePct != null && <span className={`price-change ${changeClass(price.changePct)}`}>{formatChange(price.changePct)}</span>}{price.source === 'backup' && <span className="muted backup-mark">backup</span>}
                    </>
                  )}
                </span>
                <span className="wl-next">
                  <span className="muted">Next </span>
                  <span data-testid="next-date">
                    {!next ? '—' : next.reportDate < t ? 'Results pending' : formatDateHeading(next.reportDate)}
                  </span>
                  {next?.dateStatus === 'estimated' && <span className="muted" data-testid="next-estimated"> estimated</span>}
                  {em && <span className={('provisional' in em && em.provisional) || ('final' in em && !em.final) ? 'provisional' : undefined}>{`±${pct1(em.movePct)}%`}</span>}
                </span>
                <span className="wl-latest">
                  <span className="muted">Latest </span>
                  <span data-testid="latest-date">{latestDate}</span>
                  <Latest latest={r.latest} market={market} />
                </span>
                <Star symbol={r.symbol} on onToggle={(s) => { watch.remove(s).catch(() => {}); }} />
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
