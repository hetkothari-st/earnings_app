import type { BeatMiss } from '../../../server/src/api/types';
import { formatPct } from '../lib/format';
import { type SortKey, sortRows } from '../lib/sort';
import { Tags } from './Tags';

interface Dated {
  symbol: string;
  reportDate: string;
  marketCap: number | null;
  previousMove: { pct: number } | null;
}

/** Rows grouped by report date (oldest first), each group sorted by the chosen key. */
export function byDate<T extends Dated>(rows: T[], sort: SortKey): [string, T[]][] {
  const groups = new Map<string, T[]>();
  for (const r of rows) groups.set(r.reportDate, [...(groups.get(r.reportDate) ?? []), r]);
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([d, list]) => [d, sortRows(list, sort)]);
}

/** "estimate / actual" with beat/miss colour, tags, surprise and analyst count. `source` marks a Yahoo-sourced actual. */
export function Result({ estimate, actual, result, surprisePct, format, analysts, preliminary, corrected, source, formatActual, spanLabel }: {
  estimate: number | null; actual: number | null; result: BeatMiss | null; surprisePct: number | null;
  format: (n: number | null) => string; analysts: number | null; preliminary: boolean; corrected: boolean;
  source?: 'Yahoo' | 'EDINET' | 'ESEF annual report' | null;
  /** Cumulative-span note right after the actual, e.g. "YTD (9 months)". */
  spanLabel?: string | null;
  /** Formatter for the actual when it differs from the estimate's (HK: each side has its own currency). */
  formatActual?: (n: number | null) => string;
}) {
  const arrow = result === 'beat' ? ' ▲' : result === 'miss' ? ' ▼' : '';
  return (
    <>
      {format(estimate)} / <span className={`act ${result ?? ''}`}>{actual == null ? '—' : `${(formatActual ?? format)(actual)}${arrow}`}</span>
      {spanLabel && <span className="muted"> · {spanLabel}</span>}
      <Tags preliminary={preliminary} corrected={corrected} />
      {source && <span className="muted"> · from {source}</span>}
      {surprisePct != null && <span className="muted"> ({formatPct(surprisePct)})</span>}
      {analysts != null && estimate != null && <span className="muted"> · {analysts} analyst{analysts === 1 ? '' : 's'}</span>}
    </>
  );
}
