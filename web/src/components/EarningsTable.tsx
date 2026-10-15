import { Fragment, type KeyboardEvent } from 'react';
import type { Flag, ReportDto, ResultPart, Timing } from '../../../server/src/api/types';
import { DateTime } from 'luxon';
import { changeClass, formatChange, formatDateHeading, formatEps, formatPct, formatUsd } from '../lib/format';
import { type SortKey, sortRows } from '../lib/sort';
import { describeTiming, zoneLabel } from '../lib/time';

interface Props {
  rows: ReportDto[];
  zone: string;
  /** Symbols whose rows are expanded; every other row shows symbol and name only. */
  expanded: Set<string>;
  sort: SortKey;
  onToggle: (symbol: string) => void;
  onSelect: (row: ReportDto) => void;
  /** Report ids whose results just arrived; flashed once. */
  highlight?: Set<number>;
}

const ORDER: Timing[] = ['BMO', 'DMH', 'AMC', 'UNKNOWN'];
const GROUP_LABEL: Record<Timing, string> = {
  BMO: 'Before open', DMH: 'During market', AMC: 'After close', UNKNOWN: 'Time not announced',
};
const COLS = 12;
const BASIS_NOTE: Record<'known' | 'sec-inferred' | 'assumed', string> = {
  known: '',
  'sec-inferred': ' Release time inferred as after the close from the SEC filing time.',
  assumed: ' Release time not on record; assumed same as this quarter.',
};
/** Expected move that fills the range bar completely. */
const MOVE_SCALE = 15;

function group(rows: ReportDto[]): [string, [Timing, ReportDto[]][]][] {
  const byDate = new Map<string, Map<Timing, ReportDto[]>>();
  for (const r of rows) {
    const d = byDate.get(r.reportDate) ?? new Map<Timing, ReportDto[]>();
    d.set(r.timing, [...(d.get(r.timing) ?? []), r]);
    byDate.set(r.reportDate, d);
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, m]) => [date, ORDER.filter((t) => m.has(t)).map((t) => [t, m.get(t)!] as [Timing, ReportDto[]])]);
}

export function Warn({ flags }: { flags: Flag[] }) {
  if (flags.length === 0) return null;
  const text = flags.map((f) => f.message).join('\n');
  return <span className="warn" title={text} aria-label={text} role="img">⚠</span>;
}

function Result({ part, format }: { part: ResultPart; format: (n: number | null) => string }) {
  const arrow = part.result === 'beat' ? ' ▲' : part.result === 'miss' ? ' ▼' : '';
  return (
    <>
      <span className="est">{format(part.estimate)}</span>
      <span className="sep"> / </span>
      <span className={`act ${part.result ?? ''}`} title={part.surprisePct == null ? undefined : `Surprise ${formatPct(part.surprisePct)}`}>
        {part.actual == null ? '—' : `${format(part.actual)}${arrow}`}
      </span>
    </>
  );
}

export function EarningsTable({ rows, zone, expanded, sort, onToggle, onSelect, highlight }: Props) {
  if (rows.length === 0) return <p className="empty">No earnings reports match this range and filter.</p>;
  const tz = zoneLabel(zone, rows[0]!.reportDate);
  const row = (r: ReportDto) => (
    <Row key={r.id} r={r} zone={zone} isExpanded={expanded.has(r.symbol)} isNew={highlight?.has(r.id) ?? false}
      onToggle={onToggle} onSelect={onSelect} />
  );

  return (
    <div className="table-wrap">
    <table className="earnings">
      <thead>
        <tr>
          <th scope="col" className="c-hide"><span className="sr-only">Expand</span></th>
          <th scope="col">Symbol</th>
          <th scope="col">Name</th>
          <th scope="col">Sector</th>
          <th scope="col">Date</th>
          <th scope="col">Time (ET)</th>
          <th scope="col">Your time ({tz})</th>
          <th scope="col" className="num">Previous move</th>
          <th scope="col" className="num">Expected move</th>
          <th scope="col" className="num">Market cap</th>
          <th scope="col" className="num">EPS est / act</th>
          <th scope="col" className="num">Revenue est / act</th>
        </tr>
      </thead>
      {sort !== 'date' ? (
        <tbody>{sortRows(rows, sort).map(row)}</tbody>
      ) : group(sortRows(rows, 'date')).map(([date, timings]) => (
        <tbody key={date}>
          <tr className="date-row"><th colSpan={COLS} scope="colgroup">{formatDateHeading(date)}</th></tr>
          {timings.map(([timing, list]) => (
            <Fragment key={timing}>
              <tr className={`group-row g-${timing.toLowerCase()}`}>
                <th colSpan={COLS} scope="row" id={`group-${date}-${timing}`}>
                  <span className="group-name">{GROUP_LABEL[timing]}</span>
                  <span className="group-count">{list.length} report{list.length === 1 ? '' : 's'}</span>
                </th>
              </tr>
              {list.map(row)}
            </Fragment>
          ))}
        </tbody>
      ))}
    </table>
    </div>
  );
}

function Row({ r, zone, isExpanded, isNew, onToggle, onSelect }: {
  r: ReportDto; zone: string; isExpanded: boolean; isNew: boolean; onToggle: (s: string) => void; onSelect: (r: ReportDto) => void;
}) {
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Enter') onSelect(r); };

  return (
    <tr className={`row s-${r.timing.toLowerCase()}${isExpanded ? '' : ' collapsed'}${isNew ? ' just-updated' : ''}`}
      onClick={() => onSelect(r)} onKeyDown={onKey} tabIndex={0}>
      <td data-label="Expand" className="c-hide" onClick={(e) => e.stopPropagation()}>
        <input type="checkbox" aria-label={`Expand ${r.symbol}`} checked={isExpanded} onChange={() => onToggle(r.symbol)} />
      </td>
      <td data-label="Symbol" className="symbol"><span className="ticker">{r.symbol}</span></td>
      <td data-label="Name" className="name-cell">
        <span className="name">{r.name}</span>
        {r.exchange && <span className="exchange">{r.exchange}</span>}
      </td>
      {isExpanded ? <Details r={r} zone={zone} /> : <td colSpan={COLS - 3} className="collapsed-rest" />}
    </tr>
  );
}

function Details({ r, zone }: { r: ReportDto; zone: string }) {
  const t = describeTiming(r.reportDate, r.timing, r.sessionClose, zone);
  const flags = (field: Flag['field']) => r.flags.filter((f) => f.field === field);
  return (
    <>
      <td data-label="Sector" className="sector">{r.sector ? <span title={r.industry ?? undefined}>{r.sector}</span> : '—'}</td>
      <td data-label="Date" className="date">{DateTime.fromISO(r.reportDate).setLocale('en-US').toFormat('d LLL')}</td>
      <td data-label="Time (ET)"><span><span className="dot" aria-hidden="true" />{t.et}</span> <Warn flags={flags('timing')} /></td>
      <td data-label="Your time">
        {t.local}{t.nextDay && <sup className="plus1" title="Next day in your time zone">+1</sup>}
      </td>
      <td data-label="Previous move" className="num">
        {r.previousMove ? (
          <>
            <span className={changeClass(r.previousMove.pct)}
              title={`Reaction to the ${formatDateHeading(r.previousMove.reportDate)} report.${BASIS_NOTE[r.previousMove.basis]}`}>
              {formatChange(r.previousMove.pct, 1)}
            </span>
            {r.previousMove.basis !== 'known' && <span className="basis" aria-hidden="true">*</span>}
          </>
        ) : '—'}
      </td>
      <td data-label="Expected move" className="num move">
        {r.expectedMove ? (
          <span className="move-inner">
            <span className="move-track" aria-hidden="true">
              <span className="move-range" style={{ width: `${Math.min(r.expectedMove.movePct / MOVE_SCALE, 1) * 100}%` }} />
            </span>
            <span className={r.expectedMove.provisional ? 'provisional' : undefined}
              title={r.expectedMove.provisional ? `Provisional: priced off the ${r.expectedMove.quoteDate ?? 'earlier'} close. Final value uses the last close before the release.` : undefined}>
              {r.expectedMove.provisional ? '≈' : ''}±{(Math.round(r.expectedMove.movePct * 10 + 1e-9) / 10).toFixed(1)}%
            </span>
          </span>
        ) : '—'} <Warn flags={flags('expectedMove')} />
      </td>
      <td data-label="Market cap" className="num">{formatUsd(r.marketCap)} <Warn flags={flags('marketCap')} /></td>
      <td data-label="EPS est / act" className="num"><Result part={r.eps} format={formatEps} /> <Warn flags={flags('eps')} /></td>
      <td data-label="Revenue est / act" className="num"><Result part={r.revenue} format={formatUsd} /></td>
    </>
  );
}
