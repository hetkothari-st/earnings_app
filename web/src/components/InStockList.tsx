import type { InReportDto } from '../../../server/src/india/api/types';
import type { InLivePriceDto, Note } from '../api';
import { changeClass, formatChange, formatDateHeading, formatEpsInr, formatInrCr } from '../lib/format';
import { liveCap, todayIst } from '../lib/liveCap';
import type { SortKey } from '../lib/sort';
import { byDate, Result } from './listParts';
import { NoteEditor } from './NoteEditor';
import { Star } from './Star';
import { Tags } from './Tags';

/** Expanded-list key for an Indian stock (keeps it apart from a US ticker with the same letters). */
export const inKey = (symbol: string) => `IN:${symbol}`;

interface Props {
  rows: InReportDto[];
  zone: string;
  expanded: Set<string>;
  sort: SortKey;
  onToggle: (key: string) => void;
  notes: Map<number, Note>;
  onSaveNote: (reportId: number, text: string) => Promise<void>;
  highlight?: Set<number>;
  prices?: Record<string, InLivePriceDto>;
  /** Watched symbols and the star handler; no stars are shown without the handler. */
  watched?: Set<string>;
  onWatch?: (symbol: string, on: boolean) => void;
}

const TIMING_SHORT = { BMO: 'Before open', AMC: 'After close', DMH: 'During market', UNKNOWN: 'Time not announced' } as const;
const IST = 'Asia/Kolkata';
const pct1 = (n: number) => (Math.round(n * 10 + 1e-9) / 10).toFixed(1);
const rupees = (n: number) => `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function clock(iso: string, zone: string): string {
  return new Date(iso).toLocaleTimeString('en-IN', { timeZone: zone, hour: 'numeric', minute: '2-digit' });
}

export function InStockList({ rows, zone, expanded, sort, onToggle, notes, onSaveNote, highlight, prices = {}, watched, onWatch }: Props) {
  if (rows.length === 0) return <p className="empty">No NSE F&amp;O results match this range and search.</p>;
  return (
    <div className="stock-days in-list">
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
                <InStock key={r.id} r={r} zone={zone} open={expanded.has(inKey(r.symbol))} isNew={highlight?.has(r.id) ?? false}
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

function InStock({ r, zone, open, isNew, onToggle, note, onSaveNote, price, watched, onWatch }: {
  r: InReportDto; zone: string; open: boolean; isNew: boolean; onToggle: (key: string) => void;
  note: Note | undefined; onSaveNote: (reportId: number, text: string) => Promise<void>; price: InLivePriceDto | undefined;
  watched: boolean; onWatch: ((symbol: string, on: boolean) => void) | undefined;
}) {
  return (
    <li className={`stock s-${r.timing.toLowerCase()}${onWatch ? ' has-star' : ''}${open ? ' open' : ''}${isNew ? ' just-updated' : ''}`}
      data-date={r.reportDate} data-timing={r.timing}>
      <button className="stock-head" aria-expanded={open} onClick={() => onToggle(inKey(r.symbol))}>
        <span className="dot" aria-hidden="true" />
        <span className="ticker">{r.symbol}</span>
        <span className="name">{r.name}</span>
        <span className="stock-price">
          {price ? (
            <>
              <span>{rupees(price.price)}</span>
              {price.changePct != null && <span className={`price-change ${changeClass(price.changePct)}`}>{formatChange(price.changePct)}</span>}{price.source === 'backup' && <span className="muted backup-mark">backup</span>}
            </>
          ) : null}
        </span>
        <span className="stock-when">{TIMING_SHORT[r.timing]}</span>
        <span className="chevron" aria-hidden="true">{open ? '−' : '+'}</span>
      </button>
      {onWatch && <Star symbol={r.symbol} on={watched} onToggle={onWatch} />}
      {open && <InDetails r={r} zone={zone} note={note} onSaveNote={onSaveNote} price={price} />}
    </li>
  );
}

function InDetails({ r, zone, note, onSaveNote, price }: {
  r: InReportDto; zone: string; note: Note | undefined;
  onSaveNote: (reportId: number, text: string) => Promise<void>; price: InLivePriceDto | undefined;
}) {
  const em = r.expectedMove;
  const live = r.liveMove;
  const cap = liveCap(r.reportDate, todayIst(), price?.price, r.sharesOutstanding, r.marketCap);
  const basis = r.basis === 'consolidated' ? 'Cons.' : r.basis === 'standalone' ? 'Stand.' : null;
  const revenueLabel = r.revenue.kind === 'total-income' ? 'Total income estimate / actual' : 'Revenue estimate / actual';
  return (
    <div className="stock-body">
      <dl className="lines">
        <dt>Stock</dt>
        <dd><strong>{r.symbol}</strong> {r.name} · NSE F&amp;O</dd>

        <dt>Result date</dt>
        <dd>
          {formatDateHeading(r.reportDate)}
          <span className="muted"> {r.dateStatus === 'confirmed' ? 'confirmed by NSE filing' : 'estimated (Yahoo), not yet announced on NSE'}</span>
          {r.rescheduledFrom && <span className="note-text"> (moved from {formatDateHeading(r.rescheduledFrom)})</span>}
        </dd>

        <dt>Release</dt>
        <dd>
          {r.releasedAt ? (
            <>
              {TIMING_SHORT[r.timing]}, {clock(r.releasedAt, IST)} IST
              {zone !== IST && <span className="muted"> ({clock(r.releasedAt, zone)} your time)</span>}
              <span className="muted"> · {r.timingSource === 'nse-announcement' ? 'NSE announcement' : 'NSE results filing'}</span>
            </>
          ) : 'Time not announced'}
        </dd>

        <dt>Sector</dt>
        <dd>{r.sector ? `${r.sector}${r.industry ? ` (${r.industry})` : ''}` : '—'}</dd>

        <dt>Market cap</dt>
        <dd>
          {cap != null
            ? <>{formatInrCr(cap)} <span className="muted">live</span></>
            : <>{formatInrCr(r.marketCap)}{r.marketCapAsOf && <span className="muted"> as of {formatDateHeading(r.marketCapAsOf)}</span>}</>}
        </dd>

        <dt>EPS estimate / actual</dt>
        <dd>
          <Result estimate={r.eps.estimate} actual={r.eps.actual} result={r.eps.result} surprisePct={r.eps.surprisePct}
            analysts={r.eps.analysts} format={formatEpsInr} preliminary={r.eps.preliminary} corrected={r.eps.corrected} />
          {basis && <span className="muted"> · {basis}</span>}
        </dd>

        <dt>{revenueLabel}</dt>
        <dd>
          <Result estimate={r.revenue.estimate} actual={r.revenue.actual} result={r.revenue.result} surprisePct={r.revenue.surprisePct}
            analysts={r.revenue.analysts} format={formatInrCr} preliminary={r.revenue.preliminary} corrected={r.revenue.corrected} />
          {basis && <span className="muted"> · {basis}</span>}
          {r.revenue.kind === 'total-income' && <span className="basis"> * bank: total income, not comparable with the revenue estimate</span>}
          {r.basis === 'standalone' && r.eps.estimate != null && <span className="basis"> * standalone figures, estimate basis may differ</span>}
        </dd>

        <dt>Net profit</dt>
        <dd>
          {formatInrCr(r.profit.actual)}
          <Tags preliminary={r.profit.preliminary} corrected={r.profit.corrected} />
          {basis && r.profit.actual != null && <span className="muted"> · {basis}</span>}
        </dd>

        <dt>Expected move</dt>
        <dd>
          {em ? (
            <>
              <span className={em.final ? undefined : 'provisional'}>{em.final ? '' : '≈'}±{pct1(em.movePct)}%</span>
              <span className="muted">
                {em.final ? ' at the last close before the release' : ` provisional, from the ${formatDateHeading(em.snapshotAt.slice(0, 10))} close`}
                {` · ${rupees(em.strike)} straddle, expiry ${formatDateHeading(em.expiry)}`}
              </span>
              {em.illiquid && <span className="warn" title="Wide or one-sided option quotes" aria-label="Wide or one-sided option quotes" role="img">⚠</span>}
            </>
          ) : '—'}
        </dd>

        <dt>Live expected move</dt>
        <dd>
          {live ? (
            <>
              ±{pct1(live.movePct)}%
              {live.changePp != null && live.changePp !== 0 && (
                <span className={`live-change ${changeClass(live.changePp)}`}>{live.changePp > 0 ? '+' : '−'}{Math.abs(live.changePp).toFixed(1)}</span>
              )}
              {live.quoteTime && <span className="muted"> as of {live.quoteTime.slice(11, 16)} IST</span>}
            </>
          ) : '—'}
        </dd>

        <dt>Previous move</dt>
        <dd>
          {r.previousMove ? (
            <>
              <span className={changeClass(r.previousMove.pct)}>{formatChange(r.previousMove.pct, 1)}</span>
              <span className="muted"> after the {formatDateHeading(r.previousMove.reportDate)} report</span>
              {r.previousMove.basis === 'assumed' && <span className="basis"> * release time not on record, assumed same as this quarter</span>}
            </>
          ) : '—'}
        </dd>

        <dt>Price</dt>
        <dd>
          {price ? (
            <>
              {rupees(price.price)}
              {price.changePct != null && <span className={changeClass(price.changePct)}> {formatChange(price.changePct)}</span>}
              <span className="muted"> real time (Kite), {clock(price.at, zone)}</span>
            </>
          ) : '—'}
        </dd>
      </dl>
      <NoteEditor reportId={r.id} zone={zone} note={note} onSave={onSaveNote} />
    </div>
  );
}
