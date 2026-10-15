import { Fragment, type KeyboardEvent } from 'react';
import type { Flag, ReportDto, ResultPart, Timing } from '../../../server/src/api/types';
import { formatDateHeading, formatEps, formatPct, formatUsd } from '../lib/format';
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
const COLS = 9;

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
    <table className="earnings">
      <thead>
        <tr>
          <th scope="col" className="c-hide">Hide</th>
          <th scope="col">Release (ET)</th>
          <th scope="col">Your time ({tz})</th>
          <th scope="col">Company</th>
          <th scope="col">Exchange</th>
          <th scope="col" className="num">Market cap</th>
          <th scope="col" className="num">EPS est / act</th>
          <th scope="col" className="num">Revenue est / act</th>
          <th scope="col" className="num">Exp. move</th>
        </tr>
      </thead>
      {group(visible).map(([date, timings]) => (
        <tbody key={date}>
          <tr className="date-row"><th colSpan={COLS} scope="colgroup">{formatDateHeading(date)}</th></tr>
          {timings.map(([timing, list]) => (
            <Fragment key={timing}>
              <tr className="group-row"><th colSpan={COLS} scope="row">{GROUP_LABEL[timing]}</th></tr>
              {list.map((r) => (
                <Row key={r.id} r={r} zone={zone} isHidden={hidden.has(r.symbol)} onToggleHidden={onToggleHidden} onSelect={onSelect} />
              ))}
            </Fragment>
          ))}
        </tbody>
      ))}
    </table>
  );
}

function Row({ r, zone, isHidden, onToggleHidden, onSelect }: {
  r: ReportDto; zone: string; isHidden: boolean; onToggleHidden: (s: string) => void; onSelect: (r: ReportDto) => void;
}) {
  const t = describeTiming(r.reportDate, r.timing, r.sessionClose, zone);
  const flags = (field: Flag['field']) => r.flags.filter((f) => f.field === field);
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Enter') onSelect(r); };

  return (
    <tr className={isHidden ? 'row is-hidden' : 'row'} onClick={() => onSelect(r)} onKeyDown={onKey} tabIndex={0}>
      <td data-label="Hide" className="c-hide" onClick={(e) => e.stopPropagation()}>
        <input type="checkbox" aria-label={`Hide ${r.symbol}`} checked={isHidden} onChange={() => onToggleHidden(r.symbol)} />
      </td>
      <td data-label="Release (ET)">{t.et} <Warn flags={flags('timing')} /></td>
      <td data-label="Your time">
        {t.local}{t.nextDay && <sup className="plus1" title="Next day in your time zone">+1</sup>}
      </td>
      <td data-label="Company"><strong>{r.symbol}</strong> <span className="name">{r.name}</span></td>
      <td data-label="Exchange">{r.exchange ?? '—'}</td>
      <td data-label="Market cap" className="num">{formatUsd(r.marketCap)} <Warn flags={flags('marketCap')} /></td>
      <td data-label="EPS est / act" className="num"><Result part={r.eps} format={formatEps} /></td>
      <td data-label="Revenue est / act" className="num"><Result part={r.revenue} format={formatUsd} /></td>
      <td data-label="Exp. move" className="num">
        {r.expectedMove ? `±${r.expectedMove.movePct.toFixed(1)}%` : '—'} <Warn flags={flags('expectedMove')} />
      </td>
    </tr>
  );
}
