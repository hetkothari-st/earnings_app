import { Fragment, type KeyboardEvent } from 'react';
import type { Flag, ReportDto, ResultPart, Timing } from '../../../server/src/api/types';
import { DateTime } from 'luxon';
import { changeClass, formatChange, formatCount, formatDateHeading, formatEps, formatPct, formatUsd } from '../lib/format';
import { describeTiming, zoneLabel } from '../lib/time';

interface Props {
  rows: ReportDto[];
  zone: string;
  hidden: Set<string>;
  showHidden: boolean;
  onToggleHidden: (symbol: string) => void;
  onSelect: (row: ReportDto) => void;
}

const ORDER: Timing[] = ['BMO', 'DMH', 'AMC', 'UNKNOWN'];
const GROUP_LABEL: Record<Timing, string> = {
  BMO: 'Before open', DMH: 'During market', AMC: 'After close', UNKNOWN: 'Time not announced',
};
const COLS = 12;
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

export function EarningsTable({ rows, zone, hidden, showHidden, onToggleHidden, onSelect }: Props) {
  const visible = rows.filter((r) => showHidden || !hidden.has(r.symbol));
  if (visible.length === 0) return <p className="empty">No earnings reports match this range and filter.</p>;
  const tz = zoneLabel(zone, visible[0]!.reportDate);

  return (
    <div className="table-wrap">
    <table className="earnings">
      <thead>
        <tr>
          <th scope="col" className="c-hide">Hide</th>
          <th scope="col">Symbol</th>
          <th scope="col">Name</th>
          <th scope="col">Date</th>
          <th scope="col">Time (ET)</th>
          <th scope="col">Your time ({tz})</th>
          <th scope="col" className="num">Previous move</th>
          <th scope="col" className="num">Expected move</th>
          <th scope="col" className="num">Options volume</th>
          <th scope="col" className="num">Market cap</th>
          <th scope="col" className="num">EPS est / act</th>
          <th scope="col" className="num">Revenue est / act</th>
        </tr>
      </thead>
      {group(visible).map(([date, timings]) => (
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
              {list.map((r) => (
                <Row key={r.id} r={r} zone={zone} isHidden={hidden.has(r.symbol)} onToggleHidden={onToggleHidden} onSelect={onSelect} />
              ))}
            </Fragment>
          ))}
        </tbody>
      ))}
    </table>
    </div>
  );
}

function Row({ r, zone, isHidden, onToggleHidden, onSelect }: {
  r: ReportDto; zone: string; isHidden: boolean; onToggleHidden: (s: string) => void; onSelect: (r: ReportDto) => void;
}) {
  const t = describeTiming(r.reportDate, r.timing, r.sessionClose, zone);
  const flags = (field: Flag['field']) => r.flags.filter((f) => f.field === field);
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Enter') onSelect(r); };

  return (
    <tr className={`row s-${r.timing.toLowerCase()}${isHidden ? ' is-hidden' : ''}`} onClick={() => onSelect(r)} onKeyDown={onKey} tabIndex={0}>
      <td data-label="Hide" className="c-hide" onClick={(e) => e.stopPropagation()}>
        <input type="checkbox" aria-label={`Hide ${r.symbol}`} checked={isHidden} onChange={() => onToggleHidden(r.symbol)} />
      </td>
      <td data-label="Symbol" className="symbol"><span className="ticker">{r.symbol}</span></td>
      <td data-label="Name" className="name-cell">
        <span className="name">{r.name}</span>
        {r.exchange && <span className="exchange">{r.exchange}</span>}
      </td>
      <td data-label="Date" className="date">{DateTime.fromISO(r.reportDate).setLocale('en-US').toFormat('d LLL')}</td>
      <td data-label="Time (ET)">{t.et} <Warn flags={flags('timing')} /></td>
      <td data-label="Your time">
        {t.local}{t.nextDay && <sup className="plus1" title="Next day in your time zone">+1</sup>}
      </td>
      <td data-label="Previous move" className="num">
        {r.previousMove
          ? <span className={changeClass(r.previousMove.pct)} title={`Reaction to the ${formatDateHeading(r.previousMove.reportDate)} report`}>{formatChange(r.previousMove.pct, 1)}</span>
          : '—'}
      </td>
      <td data-label="Expected move" className="num move">
        {r.expectedMove ? (
          <span className="move-inner">
            <span className="move-track" aria-hidden="true">
              <span className="move-range" style={{ width: `${Math.min(r.expectedMove.movePct / MOVE_SCALE, 1) * 100}%` }} />
            </span>
            <span>±{r.expectedMove.movePct.toFixed(1)}%</span>
          </span>
        ) : '—'} <Warn flags={flags('expectedMove')} />
      </td>
      <td data-label="Options volume" className="num">{formatCount(r.expectedMove?.optionsVolume)}</td>
      <td data-label="Market cap" className="num">{formatUsd(r.marketCap)} <Warn flags={flags('marketCap')} /></td>
      <td data-label="EPS est / act" className="num"><Result part={r.eps} format={formatEps} /> <Warn flags={flags('eps')} /></td>
      <td data-label="Revenue est / act" className="num"><Result part={r.revenue} format={formatUsd} /></td>
    </tr>
  );
}
