import type { HkFigureDto, HkLivePriceDto, HkReportDto } from '../../../server/src/hk/api/types';
import type { Note } from '../api';
import { changeClass, formatChange, formatDateHeading, formatHkEps, formatHkMoney, formatHkPrice } from '../lib/format';
import type { SortKey } from '../lib/sort';
import { byDate, Result } from './listParts';
import { NoteEditor } from './NoteEditor';
import { Star } from './Star';

/** Expanded-list key for a Hong Kong stock (keeps it apart from US and India keys). */
export const hkKey = (code: string) => `HK:${code}`;

interface Props {
  rows: HkReportDto[];
  zone: string;
  expanded: Set<string>;
  sort: SortKey;
  onToggle: (key: string) => void;
  notes: Map<number, Note>;
  onSaveNote: (reportId: number, text: string) => Promise<void>;
  highlight?: Set<number>;
  prices?: Record<string, HkLivePriceDto>;
  /** Watched codes and the star handler; no stars are shown without the handler. */
  watched?: Set<string>;
  onWatch?: (symbol: string, on: boolean) => void;
}

const TIMING_SHORT = { BMO: 'Before open', AMC: 'After close', DMH: 'During market', UNKNOWN: 'Time not announced' } as const;
const HKT = 'Asia/Hong_Kong';
const BASIC_TITLE = 'Only Yahoo data is available for this stock: no SEC results or option data';
const pct1 = (n: number) => (Math.round(n * 10 + 1e-9) / 10).toFixed(1);

function clock(iso: string, zone: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { timeZone: zone, hour: 'numeric', minute: '2-digit' });
}

export function HkStockList({ rows, zone, expanded, sort, onToggle, notes, onSaveNote, highlight, prices = {}, watched, onWatch }: Props) {
  if (rows.length === 0) return <p className="empty">No Hong Kong results match this range and search.</p>;
  return (
    <div className="stock-days hk-list">
      {byDate(rows, sort).map(([date, list]) => {
        const heading = formatDateHeading(date);
        return (
          <section key={date} className="day" aria-label={heading}>
            <div className="day-head">
              <h2 className="day-heading">{heading}</h2>
              <span className="day-count">{list.length} report{list.length === 1 ? '' : 's'}</span>
            </div>
            <ul className="stocks">
              {list.map((r) => (
                <HkStock key={r.id} r={r} zone={zone} open={expanded.has(hkKey(r.symbol))} isNew={highlight?.has(r.id) ?? false}
                  onToggle={onToggle} note={notes.get(r.id)} onSaveNote={onSaveNote} price={prices[r.symbol]}
                  watched={watched?.has(r.symbol) ?? false} onWatch={onWatch} />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function HkStock({ r, zone, open, isNew, onToggle, note, onSaveNote, price, watched, onWatch }: {
  r: HkReportDto; zone: string; open: boolean; isNew: boolean; onToggle: (key: string) => void;
  note: Note | undefined; onSaveNote: (reportId: number, text: string) => Promise<void>; price: HkLivePriceDto | undefined;
  watched: boolean; onWatch: ((symbol: string, on: boolean) => void) | undefined;
}) {
  return (
    <li className={`stock s-${r.timing.toLowerCase()}${onWatch ? ' has-star' : ''}${open ? ' open' : ''}${isNew ? ' just-updated' : ''}`}
      data-date={r.reportDate} data-timing={r.timing} data-symbol={r.symbol}>
      <button className="stock-head" aria-expanded={open} onClick={() => onToggle(hkKey(r.symbol))}>
        <span className="dot" aria-hidden="true" />
        <span className="ticker">{r.symbol}</span>
        <span className="name">
          {r.name}
          {r.level === 'basic' && <span className="basic-tag" title={BASIC_TITLE}>Basic data</span>}
        </span>
        <span className="stock-price">
          {price ? (
            <>
              <span>{formatHkPrice(price.price)}</span>
              {price.changePct != null && <span className={`price-change ${changeClass(price.changePct)}`}>{formatChange(price.changePct)}</span>}
              <span className="delayed">Delayed</span>
            </>
          ) : null}
        </span>
        <span className="stock-when">{TIMING_SHORT[r.timing]}</span>
        <span className="chevron" aria-hidden="true">{open ? '−' : '+'}</span>
      </button>
      {onWatch && <Star symbol={r.symbol} on={watched} onToggle={onWatch} />}
      {open && <HkDetails r={r} zone={zone} note={note} onSaveNote={onSaveNote} price={price} />}
    </li>
  );
}

/** EPS or revenue: each side in its own currency, and no colour when they cannot be compared. */
function Figure({ f, kind, r }: { f: HkFigureDto; kind: 'eps' | 'revenue'; r: HkReportDto }) {
  const fmt = kind === 'eps' ? formatHkEps : formatHkMoney;
  const notCompared = f.estimate != null && f.actual != null && f.result == null;
  return (
    <>
      <Result estimate={f.estimate} actual={f.actual} result={f.result} surprisePct={f.surprisePct} analysts={f.analysts}
        format={(n) => fmt(n, f.estimateCurrency)} formatActual={(n) => fmt(n, f.actualCurrency)}
        preliminary={false} corrected={false} source={f.actual != null && r.actualSource === 'yahoo' ? 'Yahoo' : null} />
      {kind === 'eps' && r.epsBasis === 'ads' && <span className="muted"> · per ADS</span>}
      {notCompared && <span className="basis"> * different currency or basis from the estimate: not compared</span>}
    </>
  );
}

function HkDetails({ r, zone, note, onSaveNote, price }: {
  r: HkReportDto; zone: string; note: Note | undefined;
  onSaveNote: (reportId: number, text: string) => Promise<void>; price: HkLivePriceDto | undefined;
}) {
  const em = r.expectedMove;
  const live = r.liveMove;
  return (
    <div className="stock-body">
      <dl className="lines">
        <dt>Stock</dt>
        <dd>
          <strong>{r.symbol}</strong> {r.name} · HKEX
          {r.level === 'full' && r.adrTicker && (
            <span className="muted"> · ADR {r.adrTicker}{r.adrRatio != null && ` (1 ADS = ${r.adrRatio} shares)`}</span>
          )}
        </dd>

        <dt>Result date</dt>
        <dd>
          {formatDateHeading(r.reportDate)}
          <span className="muted"> {r.dateStatus === 'confirmed' ? 'confirmed by SEC 6-K notice' : 'estimated'}</span>
          {r.rescheduledFrom && <span className="note-text"> (moved from {formatDateHeading(r.rescheduledFrom)})</span>}
        </dd>

        <dt>Period</dt>
        <dd>{r.period}</dd>

        <dt>Release</dt>
        <dd>
          {r.releasedAt ? (
            // SEC acceptance is an upper bound on the release time, not the release time itself.
            <>
              {r.timing !== 'UNKNOWN' && `${TIMING_SHORT[r.timing]}, `}Filed with SEC by {clock(r.releasedAt, HKT)} HKT
              {zone !== HKT && <span className="muted"> ({clock(r.releasedAt, zone)} your time)</span>}
            </>
          ) : TIMING_SHORT[r.timing]}
          {r.secDocUrl && <span className="muted"> · <a href={r.secDocUrl} target="_blank" rel="noreferrer">SEC 6-K</a></span>}
        </dd>

        <dt>Sector</dt>
        <dd>{r.sector ? `${r.sector}${r.industry ? ` (${r.industry})` : ''}` : '—'}</dd>

        <dt>Market cap</dt>
        <dd>
          {formatHkMoney(r.marketCap, 'HKD')}
          {r.marketCapAsOf && <span className="muted"> as of {formatDateHeading(r.marketCapAsOf)}</span>}
        </dd>

        <dt>EPS estimate / actual</dt>
        <dd><Figure f={r.eps} kind="eps" r={r} /></dd>

        <dt>Revenue estimate / actual</dt>
        <dd><Figure f={r.revenue} kind="revenue" r={r} /></dd>

        <dt>Expected move</dt>
        <dd>
          {em ? (
            <>
              <span className="muted">{em.adr} </span>
              <span className={em.final ? undefined : 'provisional'}>{em.final ? '' : '≈'}±{pct1(em.movePct)}%</span>
              <span className="muted"> · from ADR options, US$ straddle at {em.strike}, expiry {formatDateHeading(em.expiry)} (delayed)</span>
              {em.illiquid && <span className="warn" title="Wide or one-sided option quotes" aria-label="Wide or one-sided option quotes" role="img">⚠</span>}
            </>
          ) : r.level === 'basic' ? '— (no options data)' : '—'}
        </dd>

        <dt>Live expected move</dt>
        <dd>
          {live ? (
            <>
              ±{pct1(live.movePct)}%
              {live.changePp != null && live.changePp !== 0 && (
                <span className={`live-change ${changeClass(live.changePp)}`}>{live.changePp > 0 ? '+' : '−'}{Math.abs(live.changePp).toFixed(1)}</span>
              )}
              {live.quoteTime && <span className="muted"> as of {live.quoteTime.slice(11, 16)} ET, 15-minute delay</span>}
            </>
          ) : '—'}
        </dd>

        <dt>Previous move</dt>
        <dd>
          {r.previousMove ? (
            <>
              <span className={changeClass(r.previousMove.pct)}>{formatChange(r.previousMove.pct, 1)}</span>
              <span className="muted"> after the {formatDateHeading(r.previousMove.reportDate)} report</span>
              {r.previousMove.basis === 'assumed' && <span className="basis"> * release time not on record, assumed after the close</span>}
            </>
          ) : '—'}
        </dd>

        <dt>Price</dt>
        <dd>
          {price ? (
            <>
              {formatHkPrice(price.price)}
              {price.changePct != null && <span className={changeClass(price.changePct)}> {formatChange(price.changePct)}</span>}
              <span className="muted"> · delayed ~15 min (Yahoo), {clock(price.at, zone)}</span>
            </>
          ) : '—'}
        </dd>
      </dl>
      <NoteEditor reportId={r.id} zone={zone} note={note} onSave={onSaveNote} />
    </div>
  );
}
