import { useState } from 'react';
import type { EuropeFigureDto, EuropeLivePriceDto, EuropeReportDto, ExchangeId } from '../../../server/src/europe/api/types';
import type { Note } from '../api';
import { changeClass, formatChange, formatDateHeading, formatEuropeEps, formatEuropeMoney, formatEuropePrice, jpSpanLabel } from '../lib/format';
import type { SortKey } from '../lib/sort';
import { clock, CurrencyFigure, ExpectedMoveLine, LiveMoveLine, PreviousMoveLine, TIMING_SHORT } from './foreignParts';
import { byDate } from './listParts';
import { NoteEditor } from './NoteEditor';
import { Star } from './Star';

/** Expanded-list key for a UK or Europe stock (keeps it apart from other markets' keys). */
export const europeKey = (market: 'UK' | 'EU', symbol: string) => `${market}:${symbol}`;

interface Props {
  market: 'UK' | 'EU';
  rows: EuropeReportDto[];
  zone: string;
  expanded: Set<string>;
  sort: SortKey;
  onToggle: (key: string) => void;
  notes: Map<number, Note>;
  onSaveNote: (reportId: number, text: string) => Promise<void>;
  highlight?: Set<number>;
  prices?: Record<string, EuropeLivePriceDto>;
  /** Watched symbols and the star handler; no stars are shown without the handler. */
  watched?: Set<string>;
  onWatch?: (symbol: string, on: boolean) => void;
}

/** Each exchange's zone and country (as server/src/europe/exchanges.ts; the web imports server types only). */
const EXCHANGE: Record<ExchangeId, { zone: string; country: string }> = {
  LSE: { zone: 'Europe/London', country: 'GB' },
  PAR: { zone: 'Europe/Paris', country: 'FR' },
  AMS: { zone: 'Europe/Amsterdam', country: 'NL' },
  BRU: { zone: 'Europe/Brussels', country: 'BE' },
  LIS: { zone: 'Europe/Lisbon', country: 'PT' },
  DUB: { zone: 'Europe/Dublin', country: 'IE' },
  MIL: { zone: 'Europe/Rome', country: 'IT' },
  OSL: { zone: 'Europe/Oslo', country: 'NO' },
  XET: { zone: 'Europe/Berlin', country: 'DE' },
  SIX: { zone: 'Europe/Zurich', country: 'CH' },
  STO: { zone: 'Europe/Stockholm', country: 'SE' },
  CPH: { zone: 'Europe/Copenhagen', country: 'DK' },
  HEL: { zone: 'Europe/Helsinki', country: 'FI' },
  MAD: { zone: 'Europe/Madrid', country: 'ES' },
};

const NOT_COMPARED = '* different currency, basis or span from the estimate: not compared';
const BASIC_TITLE = 'Only Yahoo, ESEF and news-feed data is available for this stock: no SEC results or option data';
const UNKNOWN_TITLE = 'UK/EU companies usually release at 07:00 local; not confirmed for this row.';
const RELEASED_BY = { prn: 'PR Newswire', dila: 'DILA', sec: 'SEC 6-K', yahoo: 'Yahoo' } as const;
const EXCHANGE_KEY = 'eu-exchange';

/** 24-hour local clock in a zone: "07:02". */
const clock24 = (iso: string, zone: string) =>
  new Date(iso).toLocaleTimeString('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hour12: false });

function storedExchange(): string {
  try { return localStorage.getItem(EXCHANGE_KEY) ?? ''; } catch { return ''; }
}

export function EuropeStockList({ market, rows, zone, expanded, sort, onToggle, notes, onSaveNote, highlight, prices = {}, watched, onWatch }: Props) {
  const [chosen, setChosen] = useState<string>(storedExchange);
  if (rows.length === 0) return <p className="empty">No {market === 'UK' ? 'UK' : 'Europe'} results match this range and search.</p>;

  // EU only: the exchanges present in these rows, filtered client-side. A stored choice absent here shows everything.
  const present = new Map(rows.map((r) => [r.exchange, `${r.exchangeName} (${EXCHANGE[r.exchange]?.country ?? r.country ?? '?'})`]));
  const exchange = market === 'EU' && present.has(chosen as ExchangeId) ? chosen : '';
  const shown = exchange ? rows.filter((r) => r.exchange === exchange) : rows;
  const pick = (v: string) => {
    setChosen(v);
    try { localStorage.setItem(EXCHANGE_KEY, v); } catch { /* storage blocked: the choice lasts this visit */ }
  };

  return (
    <div className="stock-days europe-list">
      {market === 'EU' && (
        <div className="exchange-filter">
          <select value={exchange} onChange={(e) => pick(e.target.value)} aria-label="Exchange">
            <option value="">All exchanges</option>
            {[...present].sort(([, a], [, b]) => a.localeCompare(b)).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select>
        </div>
      )}
      {byDate(shown, sort).map(([date, list]) => {
        const heading = formatDateHeading(date);
        return (
          <section key={date} className="day" aria-label={heading}>
            <div className="day-head">
              <h2 className="day-heading">{heading}</h2>
              <span className="day-count">{list.length} report{list.length === 1 ? '' : 's'}</span>
            </div>
            <ul className="stocks">
              {list.map((r) => (
                <EuropeStock key={r.id} r={r} market={market} zone={zone} open={expanded.has(europeKey(market, r.symbol))}
                  isNew={highlight?.has(r.id) ?? false} onToggle={onToggle} note={notes.get(r.id)} onSaveNote={onSaveNote}
                  price={prices[r.symbol]} watched={watched?.has(r.symbol) ?? false} onWatch={onWatch} />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

/** "Real-time · Tradegate · EUR": the currency is the one the server sent with the price; none sent, none shown. */
export const realtimeLabel = (currency: string | null | undefined) => `Real-time · Tradegate${currency ? ` · ${currency}` : ''}`;

/** The venue next to a price: Tradegate is real-time; anything else is Yahoo, delayed. */
function Venue({ price }: { price: EuropeLivePriceDto }) {
  return price.venue === 'tradegate'
    ? <span className="realtime">{realtimeLabel(price.currency)}</span>
    : <span className="delayed">Delayed ~15 min</span>;
}

function EuropeStock({ r, market, zone, open, isNew, onToggle, note, onSaveNote, price, watched, onWatch }: {
  r: EuropeReportDto; market: 'UK' | 'EU'; zone: string; open: boolean; isNew: boolean; onToggle: (key: string) => void;
  note: Note | undefined; onSaveNote: (reportId: number, text: string) => Promise<void>; price: EuropeLivePriceDto | undefined;
  watched: boolean; onWatch: ((symbol: string, on: boolean) => void) | undefined;
}) {
  return (
    <li className={`stock s-${r.timing.toLowerCase()}${onWatch ? ' has-star' : ''}${open ? ' open' : ''}${isNew ? ' just-updated' : ''}`}
      data-date={r.reportDate} data-timing={r.timing} data-symbol={r.symbol}>
      <button className="stock-head" aria-expanded={open} onClick={() => onToggle(europeKey(market, r.symbol))}>
        <span className="dot" aria-hidden="true" />
        <span className="ticker">{r.symbol}</span>
        <span className="name">
          {r.name}
          {r.level === 'basic' && <span className="basic-tag" title={BASIC_TITLE}>Basic data</span>}
        </span>
        <span className="stock-price">
          {price ? (
            <>
              <span>{formatEuropePrice(price.price, price.currency)}</span>
              {price.changePct != null && <span className={`price-change ${changeClass(price.changePct)}`}>{formatChange(price.changePct)}</span>}
              <Venue price={price} />
            </>
          ) : null}
        </span>
        <span className="stock-when" title={r.timing === 'UNKNOWN' ? UNKNOWN_TITLE : undefined}>{TIMING_SHORT[r.timing]}</span>
        <span className="chevron" aria-hidden="true">{open ? '−' : '+'}</span>
      </button>
      {onWatch && <Star symbol={r.symbol} on={watched} onToggle={onWatch} />}
      {open && <EuropeDetails r={r} zone={zone} note={note} onSaveNote={onSaveNote} price={price} />}
    </li>
  );
}

function EuropeDetails({ r, zone, note, onSaveNote, price }: {
  r: EuropeReportDto; zone: string; note: Note | undefined;
  onSaveNote: (reportId: number, text: string) => Promise<void>; price: EuropeLivePriceDto | undefined;
}) {
  const local = EXCHANGE[r.exchange]?.zone ?? 'Europe/London';
  const sourceOf = (f: EuropeFigureDto) => (f.actualSource === 'yahoo' ? 'Yahoo' : f.actualSource === 'esef' ? 'ESEF annual report' : null);
  const spanOf = (f: EuropeFigureDto) => jpSpanLabel(r.fiscalQuarter, f);
  return (
    <div className="stock-body">
      <dl className="lines">
        <dt>Stock</dt>
        <dd>
          <strong>{r.symbol}</strong> {r.name} · {r.exchangeName}
          {r.level === 'full' && r.adrTicker && (
            <span className="muted"> · ADR {r.adrTicker}{r.adrRatio != null && ` (1 ADS = ${r.adrRatio} share${r.adrRatio === 1 ? '' : 's'})`}</span>
          )}
        </dd>

        <dt>Result date</dt>
        <dd>
          {formatDateHeading(r.reportDate)}
          <span className="muted"> {r.dateStatus === 'confirmed' ? 'confirmed' : 'estimated'}</span>
          {r.rescheduledFrom && <span className="note-text"> (moved from {formatDateHeading(r.rescheduledFrom)})</span>}
        </dd>

        <dt>Period</dt>
        <dd>{r.period ?? 'Period not stated'}</dd>

        <dt>Release</dt>
        <dd>
          {r.releasedAt ? (
            <>
              Results out
              {r.releasedSource && ` · ${RELEASED_BY[r.releasedSource]} ${clock24(r.releasedAt, local)}`}
              {zone !== local && <span className="muted"> ({clock(r.releasedAt, zone)} your time)</span>}
              {r.signal && <> · <a href={r.signal.url} target="_blank" rel="noreferrer">{r.signal.title}</a></>}
            </>
          ) : (
            <>
              <span title={r.timing === 'UNKNOWN' ? UNKNOWN_TITLE : undefined}>{TIMING_SHORT[r.timing]}</span>
              {r.level === 'full' && <span className="muted"> · SEC 6-K usually arrives within hours of the 07:00 release</span>}
            </>
          )}
          {r.secDocUrl && <span className="muted"> · <a href={r.secDocUrl} target="_blank" rel="noreferrer">SEC 6-K</a></span>}
          {r.esefUrl && <span className="muted"> · <a href={r.esefUrl} target="_blank" rel="noreferrer">ESEF filing</a></span>}
        </dd>

        <dt>Sector</dt>
        <dd>{r.sector ? `${r.sector}${r.industry ? ` (${r.industry})` : ''}` : '—'}</dd>

        <dt>Market cap</dt>
        <dd>
          {formatEuropeMoney(r.marketCap, r.marketCapCurrency)}
          {r.marketCapAsOf && <span className="muted"> as of {formatDateHeading(r.marketCapAsOf)}</span>}
        </dd>

        <dt>EPS estimate / actual</dt>
        <dd>
          <CurrencyFigure f={r.eps} fmt={formatEuropeEps} source={sourceOf(r.eps)} spanLabel={spanOf(r.eps)} notComparedText={NOT_COMPARED}
            extra={r.epsDiluted != null ? <span className="muted"> · diluted {formatEuropeEps(r.epsDiluted, r.eps.actualCurrency)}</span> : null} />
        </dd>

        <dt>Revenue estimate / actual</dt>
        <dd><CurrencyFigure f={r.revenue} fmt={formatEuropeMoney} source={sourceOf(r.revenue)} spanLabel={spanOf(r.revenue)} notComparedText={NOT_COMPARED} /></dd>

        <dt>Expected move</dt>
        <dd>
          <ExpectedMoveLine em={r.expectedMove} level={r.level} />
          {/* `underlying` is the US-listed ADR's close in US$, never the local line's price. */}
          {r.expectedMove && <span className="muted"> · ADR US${r.expectedMove.underlying.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>}
        </dd>

        <dt>Live expected move</dt>
        <dd><LiveMoveLine live={r.liveMove} /></dd>

        <dt>Previous move</dt>
        <dd><PreviousMoveLine pm={r.previousMove} /></dd>

        <dt>Price</dt>
        <dd>
          {price ? (
            <>
              {formatEuropePrice(price.price, price.currency)}
              {price.changePct != null && <span className={changeClass(price.changePct)}> {formatChange(price.changePct)}</span>}
              <span className="muted">
                {price.venue === 'tradegate' ? ` · real-time (Tradegate${price.currency ? `, ${price.currency}` : ''})` : ' · delayed ~15 min (Yahoo)'}, {clock(price.at, zone)}
              </span>
            </>
          ) : '—'}
        </dd>
      </dl>
      <NoteEditor reportId={r.id} zone={zone} note={note} onSave={onSaveNote} />
    </div>
  );
}
