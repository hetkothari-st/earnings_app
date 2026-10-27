import type { JpFigureDto, JpLivePriceDto, JpReportDto } from '../../../server/src/jp/api/types';
import type { Note } from '../api';
import { changeClass, formatChange, formatDateHeading, formatJpEps, formatJpMoney, formatJpPrice, ytdLabel } from '../lib/format';
import type { SortKey } from '../lib/sort';
import { clock, CurrencyFigure, ExpectedMoveLine, LiveMoveLine, PreviousMoveLine, TIMING_SHORT } from './foreignParts';
import { byDate } from './listParts';
import { NoteEditor } from './NoteEditor';
import { Star } from './Star';

/** Expanded-list key for a Japan stock (keeps it apart from other markets' keys). */
export const jpKey = (code: string) => `JP:${code}`;

interface Props {
  rows: JpReportDto[];
  zone: string;
  expanded: Set<string>;
  sort: SortKey;
  onToggle: (key: string) => void;
  notes: Map<number, Note>;
  onSaveNote: (reportId: number, text: string) => Promise<void>;
  highlight?: Set<number>;
  prices?: Record<string, JpLivePriceDto>;
  /** Watched codes and the star handler; no stars are shown without the handler. */
  watched?: Set<string>;
  onWatch?: (symbol: string, on: boolean) => void;
}

const JST = 'Asia/Tokyo';
const NOT_COMPARED = '* different currency, basis or span from the estimate: not compared';
const BASIC_TITLE = 'Only Yahoo and EDINET data is available for this stock: no SEC results or option data';

export function JpStockList({ rows, zone, expanded, sort, onToggle, notes, onSaveNote, highlight, prices = {}, watched, onWatch }: Props) {
  if (rows.length === 0) return <p className="empty">No Japan results match this range and search.</p>;
  return (
    <div className="stock-days jp-list">
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
                <JpStock key={r.id} r={r} zone={zone} open={expanded.has(jpKey(r.symbol))} isNew={highlight?.has(r.id) ?? false}
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

function JpStock({ r, zone, open, isNew, onToggle, note, onSaveNote, price, watched, onWatch }: {
  r: JpReportDto; zone: string; open: boolean; isNew: boolean; onToggle: (key: string) => void;
  note: Note | undefined; onSaveNote: (reportId: number, text: string) => Promise<void>; price: JpLivePriceDto | undefined;
  watched: boolean; onWatch: ((symbol: string, on: boolean) => void) | undefined;
}) {
  return (
    <li className={`stock s-${r.timing.toLowerCase()}${onWatch ? ' has-star' : ''}${open ? ' open' : ''}${isNew ? ' just-updated' : ''}`}
      data-date={r.reportDate} data-timing={r.timing} data-symbol={r.symbol}>
      <button className="stock-head" aria-expanded={open} onClick={() => onToggle(jpKey(r.symbol))}>
        <span className="dot" aria-hidden="true" />
        <span className="ticker">{r.symbol}</span>
        <span className="name">
          {r.name}
          {r.level === 'basic' && <span className="basic-tag" title={BASIC_TITLE}>Basic data</span>}
        </span>
        <span className="stock-price">
          {price ? (
            <>
              <span>{formatJpPrice(price.price)}</span>
              {price.changePct != null && <span className={`price-change ${changeClass(price.changePct)}`}>{formatChange(price.changePct)}</span>}
              <span className="delayed">Delayed ~20 min</span>
            </>
          ) : null}
        </span>
        <span className="stock-when">{TIMING_SHORT[r.timing]}</span>
        <span className="chevron" aria-hidden="true">{open ? '−' : '+'}</span>
      </button>
      {onWatch && <Star symbol={r.symbol} on={watched} onToggle={onWatch} />}
      {open && <JpDetails r={r} zone={zone} note={note} onSaveNote={onSaveNote} price={price} />}
    </li>
  );
}

function JpDetails({ r, zone, note, onSaveNote, price }: {
  r: JpReportDto; zone: string; note: Note | undefined;
  onSaveNote: (reportId: number, text: string) => Promise<void>; price: JpLivePriceDto | undefined;
}) {
  const sourceOf = (f: JpFigureDto) => (f.actualSource === 'yahoo' ? 'Yahoo' : f.actualSource === 'edinet' ? 'EDINET' : null);
  const spanOf = (f: JpFigureDto) => (f.actualSpan === 'ytd' ? ytdLabel(f.ytdMonths) : null);
  const fromEdinet = r.eps.actualSource === 'edinet' || r.revenue.actualSource === 'edinet';
  return (
    <div className="stock-body">
      <dl className="lines">
        <dt>Stock</dt>
        <dd>
          <strong>{r.symbol}</strong> {r.name} · TSE
          {r.nameJa && <span className="muted"> {r.nameJa}</span>}
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
          {r.releasedAt && r.level !== 'full' ? (
            // Basic rows have no SEC filing: say only that the results are out.
            <>{r.timing !== 'UNKNOWN' && `${TIMING_SHORT[r.timing]}, `}Results out</>
          ) : r.releasedAt ? (
            // SEC acceptance is an upper bound on the release time, not the release time itself.
            <>
              {r.timing !== 'UNKNOWN' && `${TIMING_SHORT[r.timing]}, `}Filed with SEC by {clock(r.releasedAt, JST)} JST
              {zone !== JST && <span className="muted"> ({clock(r.releasedAt, zone)} your time)</span>}
              {r.level === 'full' && <span className="muted"> · the 6-K arrives 3.5–6 h after the Tokyo release</span>}
            </>
          ) : (
            <>
              {TIMING_SHORT[r.timing]}
              {r.level === 'full' && <span className="muted"> · SEC 6-K usually arrives 3.5–6 h after the Tokyo release</span>}
            </>
          )}
          {r.secDocUrl && <span className="muted"> · <a href={r.secDocUrl} target="_blank" rel="noreferrer">SEC 6-K</a></span>}
        </dd>

        <dt>Sector</dt>
        <dd>{r.sector ? `${r.sector}${r.industry ? ` (${r.industry})` : ''}` : r.industryJa ?? '—'}</dd>

        <dt>Market cap</dt>
        <dd>
          {formatJpMoney(r.marketCap, 'JPY')}
          {r.marketCapAsOf && <span className="muted"> as of {formatDateHeading(r.marketCapAsOf)}</span>}
        </dd>

        <dt>EPS estimate / actual</dt>
        <dd>
          <CurrencyFigure f={r.eps} fmt={formatJpEps} source={sourceOf(r.eps)} spanLabel={spanOf(r.eps)} notComparedText={NOT_COMPARED}
            extra={r.epsDiluted != null ? <span className="muted"> · diluted {formatJpEps(r.epsDiluted, r.eps.actualCurrency)}</span> : null} />
        </dd>

        <dt>Revenue estimate / actual</dt>
        <dd><CurrencyFigure f={r.revenue} fmt={formatJpMoney} source={sourceOf(r.revenue)} spanLabel={spanOf(r.revenue)} notComparedText={NOT_COMPARED} /></dd>

        {fromEdinet && (
          <>
            <dt>Source</dt>
            <dd className="muted">Source: EDINET (Financial Services Agency), edited</dd>
          </>
        )}

        <dt>Expected move</dt>
        <dd>
          <ExpectedMoveLine em={r.expectedMove} level={r.level} />
        </dd>

        <dt>Live expected move</dt>
        <dd><LiveMoveLine live={r.liveMove} /></dd>

        <dt>Previous move</dt>
        <dd><PreviousMoveLine pm={r.previousMove} /></dd>

        <dt>Price</dt>
        <dd>
          {price ? (
            <>
              {formatJpPrice(price.price)}
              {price.changePct != null && <span className={changeClass(price.changePct)}> {formatChange(price.changePct)}</span>}
              <span className="muted"> · delayed ~20 min (Yahoo), {clock(price.at, zone)}</span>
            </>
          ) : '—'}
        </dd>
      </dl>
      <NoteEditor reportId={r.id} zone={zone} note={note} onSave={onSaveNote} />
    </div>
  );
}
