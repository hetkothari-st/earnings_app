import type { Flag, ReportDto, ResultPart } from '../../../server/src/api/types';
import type { LivePrice, Note } from '../api';
import { changeClass, formatChange, formatDateHeading, formatEps, formatMoney, formatPct, formatUsd } from '../lib/format';
import { liveCap, todayEt } from '../lib/liveCap';
import { type SortKey, sortRows } from '../lib/sort';
import { describeTiming, zoneLabel } from '../lib/time';
import { NoteEditor } from './NoteEditor';
import { Star } from './Star';
import { Tags } from './Tags';

interface Props {
  rows: ReportDto[];
  zone: string;
  /** Symbols whose details are open; every other stock shows its name only. */
  expanded: Set<string>;
  sort: SortKey;
  onToggle: (symbol: string) => void;
  notes: Map<number, Note>;
  onSaveNote: (reportId: number, text: string) => Promise<void>;
  /** Report ids whose results just arrived; flashed once. */
  highlight?: Set<number>;
  /** Real-time prices by symbol. */
  prices?: Record<string, LivePrice>;
  /** Watched symbols and the star handler; no stars are shown without the handler. */
  watched?: Set<string>;
  onWatch?: (symbol: string, on: boolean) => void;
}

const TIMING_SHORT = { BMO: 'Before open', AMC: 'After close', DMH: 'During market', UNKNOWN: 'Time not announced' } as const;
const BASIS_NOTE = {
  known: '',
  'sec-inferred': 'release time inferred from the SEC filing',
  assumed: 'release time not on record, assumed same as this quarter',
} as const;
const SEC_TEXT: Record<string, string> = {
  verified: 'Confirmed: filed with the SEC before the open',
  consistent: 'Consistent with the SEC filing time',
  derived: 'Taken from the SEC filing time',
  contradicted: 'Contradicted by the SEC filing time',
  unverifiable: 'Not verifiable from the SEC filing time',
};

export function Warn({ flags }: { flags: Flag[] }) {
  if (flags.length === 0) return null;
  const text = flags.map((f) => f.message).join('\n');
  return <span className="warn" title={text} aria-label={text} role="img">⚠</span>;
}

const pct1 = (n: number) => (Math.round(n * 10 + 1e-9) / 10).toFixed(1);

type Part = ResultPart & { preliminary: boolean; corrected: boolean; basis?: 'adjusted' | 'gaap' | null };

function Result({ part, format }: { part: Part; format: (n: number | null) => string }) {
  const arrow = part.result === 'beat' ? ' ▲' : part.result === 'miss' ? ' ▼' : '';
  return (
    <>
      {format(part.estimate)} / <span className={`act ${part.result ?? ''}`}>{part.actual == null ? '—' : `${format(part.actual)}${arrow}`}</span>
      <Tags preliminary={part.preliminary} corrected={part.corrected} basis={part.basis} />
      {part.surprisePct != null && <span className="muted"> ({formatPct(part.surprisePct)})</span>}
    </>
  );
}

function byDate(rows: ReportDto[], sort: SortKey): [string, ReportDto[]][] {
  const groups = new Map<string, ReportDto[]>();
  for (const r of rows) groups.set(r.reportDate, [...(groups.get(r.reportDate) ?? []), r]);
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([d, list]) => [d, sortRows(list, sort)]);
}

export function StockList({ rows, zone, expanded, sort, onToggle, notes, onSaveNote, highlight, prices = {}, watched, onWatch }: Props) {
  if (rows.length === 0) return <p className="empty">No earnings reports match this range and filter.</p>;
  return (
    <div className="stock-days">
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
                <Stock key={r.id} r={r} zone={zone} open={expanded.has(r.symbol)} isNew={highlight?.has(r.id) ?? false}
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

function Stock({ r, zone, open, isNew, onToggle, note, onSaveNote, price, watched, onWatch }: {
  r: ReportDto; zone: string; open: boolean; isNew: boolean; onToggle: (s: string) => void;
  note: Note | undefined; onSaveNote: (reportId: number, text: string) => Promise<void>; price: LivePrice | undefined;
  watched: boolean; onWatch: ((symbol: string, on: boolean) => void) | undefined;
}) {
  return (
    <li className={`stock s-${r.timing.toLowerCase()}${onWatch ? ' has-star' : ''}${open ? ' open' : ''}${isNew ? ' just-updated' : ''}`}
      data-date={r.reportDate} data-timing={r.timing} data-symbol={r.symbol}>
      <button className="stock-head" aria-expanded={open} onClick={() => onToggle(r.symbol)}>
        <span className="dot" aria-hidden="true" />
        <span className="ticker">{r.symbol}</span>
        <span className="name">{r.name}</span>
        <span className="stock-price">
          {price ? (
            <>
              <span>${price.price.toFixed(2)}</span>
              {price.changePct != null && <span className={`price-change ${changeClass(price.changePct)}`}>{formatChange(price.changePct)}</span>}{price.source === 'backup' && <span className="muted backup-mark">backup</span>}
            </>
          ) : null}
        </span>
        <span className="stock-when">{TIMING_SHORT[r.timing]}</span>
        <span className="chevron" aria-hidden="true">{open ? '−' : '+'}</span>
      </button>
      {onWatch && <Star symbol={r.symbol} on={watched} onToggle={onWatch} />}
      {open && <Details r={r} zone={zone} note={note} onSaveNote={onSaveNote} price={price} />}
    </li>
  );
}

function Details({ r, zone, note, onSaveNote, price }: {
  r: ReportDto; zone: string; note: Note | undefined; onSaveNote: (reportId: number, text: string) => Promise<void>;
  price: LivePrice | undefined;
}) {
  const t = describeTiming(r.reportDate, r.timing, r.sessionClose, zone);
  const flags = (field: Flag['field']) => r.flags.filter((f) => f.field === field);
  const em = r.expectedMove;
  const live = r.liveMove;
  const cap = liveCap(r.reportDate, todayEt(), price?.price, r.sharesOutstanding, r.marketCap);
  return (
    <div className="stock-body">
      <dl className="lines">
        <dt>Stock</dt>
        <dd><strong>{r.symbol}</strong> {r.name}{r.exchange ? `, ${r.exchange}` : ''}</dd>
        <dt>Price</dt>
        <dd>
          {price ? (
            <>
              ${price.price.toFixed(2)}
              {price.changePct != null && <span className={changeClass(price.changePct)}> {formatChange(price.changePct)}</span>}
              <span className="muted"> real time, last trade {new Date(price.time).toLocaleTimeString('en-US', { timeZone: zone, hour: 'numeric', minute: '2-digit', second: '2-digit' })}</span>
            </>
          ) : '—'}
        </dd>
        <dt>Sector</dt>
        <dd>{r.sector ? `${r.sector}${r.industry ? ` (${r.industry})` : ''}` : '—'}</dd>
        <dt>Release</dt>
        <dd>{t.et}{r.timing !== 'UNKNOWN' ? ' ET' : ''}<Warn flags={flags('timing')} /></dd>
        <dt>Your time</dt>
        <dd>{t.local}{t.nextDay ? ' (next day)' : ''}{r.timing !== 'UNKNOWN' ? ` ${zoneLabel(zone, r.reportDate)}` : ''}</dd>
        <dt>Result date</dt>
        <dd>{formatDateHeading(r.reportDate)}{r.dateStatus === 'estimated' && <span className="muted"> estimated (Yahoo), not yet on the Nasdaq calendar</span>}{r.rescheduledFrom && <span className="note-text"> (moved from {formatDateHeading(r.rescheduledFrom)})</span>}</dd>
        <dt>Previous move</dt>
        <dd>
          {r.previousMove ? (
            <>
              <span className={changeClass(r.previousMove.pct)}>{formatChange(r.previousMove.pct, 1)}</span>
              <span className="muted"> after the {formatDateHeading(r.previousMove.reportDate)} report</span>
              {r.previousMove.basis !== 'known' && <span className="basis"> * {BASIS_NOTE[r.previousMove.basis]}</span>}
            </>
          ) : '—'}
        </dd>
        <dt>Expected move</dt>
        <dd>
          {em ? (
            <>
              <span className={em.provisional ? 'provisional' : undefined}>{em.provisional ? '≈' : ''}±{pct1(em.movePct)}%</span>
              <span className="muted">
                {em.provisional ? ` provisional, from the ${em.quoteDate ? formatDateHeading(em.quoteDate) : 'earlier'} close` : ' at the last close before the release'}
              </span>
            </>
          ) : '—'}<Warn flags={flags('expectedMove')} />
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
        <dt>Market cap</dt>
        <dd>
          {cap != null ? <>{formatUsd(cap)} <span className="muted">live</span></> : formatUsd(r.marketCap)}
          <Warn flags={flags('marketCap')} />
        </dd>
        <dt>EPS estimate / actual</dt>
        <dd><Result part={r.eps} format={formatEps} /><Warn flags={flags('eps')} /></dd>
        <dt>Revenue estimate / actual</dt>
        <dd><Result part={r.revenue} format={(n) => formatMoney(n, r.revenue.currency)} /></dd>
        <dt>Same quarter last year</dt>
        <dd>{r.eps.lastYear == null ? '—' : `EPS ${formatEps(r.eps.lastYear)}`}</dd>
        <dt>Official release</dt>
        <dd>
          {r.sec.docUrl
            ? <a href={r.sec.docUrl} target="_blank" rel="noreferrer">SEC filing</a>
            : <span className="muted">Linked once the company files with the SEC</span>}
          {r.sec.check && <span className="muted"> {SEC_TEXT[r.sec.check]}</span>}
        </dd>
      </dl>
      <NoteEditor reportId={r.id} zone={zone} note={note} onSave={onSaveNote} />
    </div>
  );
}
