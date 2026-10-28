import { useEffect, useState } from 'react';
import { DateTime } from 'luxon';
import type { InReportDto } from '../../../server/src/india/api/types';
import type { HkReportDto } from '../../../server/src/hk/api/types';
import type { JpReportDto } from '../../../server/src/jp/api/types';
import type { EuropeReportDto } from '../../../server/src/europe/api/types';
import type { ReportDto } from '../../../server/src/api/types';
import { fetchWatchRows, type WatchRow } from '../api';
import type { Watchlist } from '../hooks/useWatchlist';
import { changeClass, formatChange, formatDateHeading, formatEps, formatEpsInr, formatEuropeEps, formatEuropeMoney, formatEuropePrice, formatHkEps, formatHkMoney, formatHkPrice, formatInrCr, formatJpEps, formatJpMoney, formatJpPrice, formatMoney, jpSpanLabel } from '../lib/format';
import type { Market } from '../lib/market';
import { todayHkt, todayJst, todayLondon, todayParis } from '../lib/liveCap';
import { todayEt } from '../lib/time';
import { priceKey } from '../lib/ticker';
import { SymbolSearch } from './SymbolSearch';
import { Star } from './Star';
import { Tags } from './Tags';

/** `currency` and `venue` come with UK and Europe prices (Tradegate real-time in EUR, or Yahoo delayed). */
type Price = { price: number; changePct: number | null; source?: string; currency?: string | null; venue?: 'tradegate' | 'yahoo' };
type Report = ReportDto | InReportDto | HkReportDto | JpReportDto | EuropeReportDto;

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
  if (market === 'HK') return todayHkt();
  if (market === 'JP') return todayJst();
  if (market === 'UK') return todayLondon();
  if (market === 'EU') return todayParis();
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
  if (market === 'HK') {
    const h = r as HkReportDto;
    if (h.eps.actual == null && h.revenue.actual == null) return <span className="muted">—</span>;
    return (
      <>
        <Figure label="EPS" actual={h.eps.actual} result={h.eps.result} format={(n) => formatHkEps(n, h.eps.actualCurrency)} preliminary={false} corrected={false} />
        <Figure label="Revenue" actual={h.revenue.actual} result={h.revenue.result} format={(n) => formatHkMoney(n, h.revenue.actualCurrency)} preliminary={false} corrected={false} />
      </>
    );
  }
  if (market === 'JP') {
    const j = r as JpReportDto;
    if (j.eps.actual == null && j.revenue.actual == null) return <span className="muted">—</span>;
    const span = (f: JpReportDto['eps']) => jpSpanLabel(j.fiscalQuarter, f);
    return (
      <>
        <Figure label="EPS" actual={j.eps.actual} result={j.eps.result} format={(n) => formatJpEps(n, j.eps.actualCurrency)} preliminary={false} corrected={false} />
        {span(j.eps) && <span className="muted"> {span(j.eps)}</span>}
        {j.eps.actual != null && j.eps.actualSource === 'edinet' && <span className="muted"> from EDINET</span>}
        <Figure label="Revenue" actual={j.revenue.actual} result={j.revenue.result} format={(n) => formatJpMoney(n, j.revenue.actualCurrency)} preliminary={false} corrected={false} />
        {span(j.revenue) && <span className="muted"> {span(j.revenue)}</span>}
        {j.revenue.actual != null && j.revenue.actualSource === 'edinet' && <span className="muted"> from EDINET</span>}
        {(j.eps.actualSource === 'edinet' || j.revenue.actualSource === 'edinet') && (
          <span className="muted"> Source: EDINET (Financial Services Agency), edited</span>
        )}
      </>
    );
  }
  if (market === 'UK' || market === 'EU') {
    const e = r as EuropeReportDto;
    if (e.eps.actual == null && e.revenue.actual == null) return <span className="muted">—</span>;
    const span = (f: EuropeReportDto['eps']) => jpSpanLabel(e.fiscalQuarter, f);
    const from = (f: EuropeReportDto['eps']) => (f.actual == null ? null : f.actualSource === 'esef' ? 'ESEF annual report' : f.actualSource === 'yahoo' ? 'Yahoo' : null);
    return (
      <>
        <Figure label="EPS" actual={e.eps.actual} result={e.eps.result} format={(n) => formatEuropeEps(n, e.eps.actualCurrency)} preliminary={false} corrected={false} />
        {span(e.eps) && <span className="muted"> {span(e.eps)}</span>}
        {from(e.eps) && <span className="muted"> from {from(e.eps)}</span>}
        <Figure label="Revenue" actual={e.revenue.actual} result={e.revenue.result} format={(n) => formatEuropeMoney(n, e.revenue.actualCurrency)} preliminary={false} corrected={false} />
        {span(e.revenue) && <span className="muted"> {span(e.revenue)}</span>}
        {from(e.revenue) && <span className="muted"> from {from(e.revenue)}</span>}
      </>
    );
  }
  const r2 = r as ReportDto | InReportDto;
  const eps = market === 'IN' ? formatEpsInr : formatEps;
  const money = market === 'IN' ? formatInrCr : (n: number | null) => formatMoney(n, (r2 as ReportDto).revenue.currency);
  const basis = 'basis' in r2.eps ? (r2.eps as ReportDto['eps']).basis : null;
  const any = r2.eps.actual != null || r2.revenue.actual != null || ('profit' in r2 && r2.profit.actual != null);
  if (!any) return <span className="muted">—</span>;
  return (
    <>
      <Figure label="EPS" actual={r2.eps.actual} result={r2.eps.result} format={eps} preliminary={r2.eps.preliminary} corrected={r2.eps.corrected} basis={basis} />
      <Figure label="Revenue" actual={r2.revenue.actual} result={r2.revenue.result} format={money} preliminary={r2.revenue.preliminary} corrected={r2.revenue.corrected} />
      {'profit' in r2 && <Figure label="Profit" actual={r2.profit.actual} result={null} format={formatInrCr} preliminary={r2.profit.preliminary} corrected={r2.profit.corrected} />}
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
  const money = (p: Price) => (market === 'IN' ? rupees(p.price) : market === 'HK' ? formatHkPrice(p.price) : market === 'JP' ? formatJpPrice(p.price)
    : market === 'UK' || market === 'EU' ? formatEuropePrice(p.price, p.currency) : `$${p.price.toFixed(2)}`);

  return (
    <section className="watchlist" aria-label="Watchlist">
      <SymbolSearch market={market} onPick={(s) => { watch.add(s).catch(() => {}); }} />
      {error && <p className="warn-text">Could not load your watchlist: {error}</p>}
      {!error && rows === null && <p className="muted">Loading…</p>}
      {rows !== null && shown.length === 0 && <p className="empty">Nothing on your watchlist yet. Search above or tap a star on any stock.</p>}
      {shown.length > 0 && (
        <ul className="stocks watch-rows">
          {shown.map((r) => {
            const price = market === 'US' ? prices[priceKey(r.symbol)] : prices[r.symbol];
            const next = r.next;
            const em = next?.expectedMove;
            const latestDate = r.latest && r.latest.reportDate ? formatDateHeading(r.latest.reportDate) : '—';
            return (
              <li key={r.symbol} className="stock wl-row" data-symbol={market !== 'IN' ? r.symbol : undefined}>
                <span className="ticker">{r.symbol}</span>
                <span className="name wl-name">{r.name}</span>
                <span className="stock-price">
                  {price && (
                    <>
                      <span>{money(price)}</span>
                      {price.changePct != null && <span className={`price-change ${changeClass(price.changePct)}`}>{formatChange(price.changePct)}</span>}{price.source === 'backup' && <span className="muted backup-mark">backup</span>}
                      {price.venue === 'tradegate' && <span className="realtime">Real-time · Tradegate · EUR</span>}
                      {price.venue === 'yahoo' && <span className="delayed">Delayed ~15 min</span>}
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
