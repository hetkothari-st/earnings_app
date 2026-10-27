import type { ReactNode } from 'react';
import type { HkFigureDto, HkReportDto } from '../../../server/src/hk/api/types';
import { changeClass, formatChange, formatDateHeading } from '../lib/format';
import { Result } from './listParts';

export const TIMING_SHORT = { BMO: 'Before open', AMC: 'After close', DMH: 'During market', UNKNOWN: 'Time not announced' } as const;

export type ForeignExpectedMove = NonNullable<HkReportDto['expectedMove']>;
type ForeignLiveMove = NonNullable<HkReportDto['liveMove']>;
type ForeignPreviousMove = NonNullable<HkReportDto['previousMove']>;

export const pct1 = (n: number) => (Math.round(n * 10 + 1e-9) / 10).toFixed(1);

export function clock(iso: string, zone: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { timeZone: zone, hour: 'numeric', minute: '2-digit' });
}

/** ADR-option expected move, or a dash (with a reason at the basic level). */
export function ExpectedMoveLine({ em, level }: { em: ForeignExpectedMove | null; level: 'full' | 'basic' }) {
  if (!em) return <>{level === 'basic' ? '— (no options data)' : '—'}</>;
  return (
    <>
      <span className="muted">{em.adr} </span>
      <span className={em.final ? undefined : 'provisional'}>{em.final ? '' : '≈'}±{pct1(em.movePct)}%</span>
      <span className="muted"> · from ADR options, US$ straddle at {em.strike}, expiry {formatDateHeading(em.expiry)} (delayed)</span>
      {em.illiquid && <span className="warn" title="Wide or one-sided option quotes" aria-label="Wide or one-sided option quotes" role="img">⚠</span>}
    </>
  );
}

export function LiveMoveLine({ live }: { live: ForeignLiveMove | null }) {
  if (!live) return <>—</>;
  return (
    <>
      ±{pct1(live.movePct)}%
      {live.changePp != null && live.changePp !== 0 && (
        <span className={`live-change ${changeClass(live.changePp)}`}>{live.changePp > 0 ? '+' : '−'}{Math.abs(live.changePp).toFixed(1)}</span>
      )}
      {live.quoteTime && <span className="muted"> as of {live.quoteTime.slice(11, 16)} ET, 15-minute delay</span>}
    </>
  );
}

export function PreviousMoveLine({ pm }: { pm: ForeignPreviousMove | null }) {
  if (!pm) return <>—</>;
  return (
    <>
      <span className={changeClass(pm.pct)}>{formatChange(pm.pct, 1)}</span>
      <span className="muted"> after the {formatDateHeading(pm.reportDate)} report</span>
      {pm.basis === 'assumed' && <span className="basis"> * release time not on record, assumed after the close</span>}
    </>
  );
}

/** EPS or revenue: each side in its own currency, and no colour when they cannot be compared. */
export function CurrencyFigure({ f, fmt, source, spanLabel, extra, notComparedText }: {
  f: HkFigureDto; fmt: (n: number | null, currency: string | null) => string;
  source?: 'Yahoo' | 'EDINET' | null; spanLabel?: string | null; extra?: ReactNode;
  /** Wording of the not-compared note (Japan adds span). */
  notComparedText?: string;
}) {
  const notCompared = f.estimate != null && f.actual != null && f.result == null;
  return (
    <>
      <Result estimate={f.estimate} actual={f.actual} result={f.result} surprisePct={f.surprisePct} analysts={f.analysts}
        format={(n) => fmt(n, f.estimateCurrency)} formatActual={(n) => fmt(n, f.actualCurrency)}
        preliminary={false} corrected={false} source={f.actual != null ? source ?? null : null} spanLabel={spanLabel} />
      {extra}
      {notCompared && <span className="basis"> {notComparedText ?? '* different currency or basis from the estimate: not compared'}</span>}
    </>
  );
}
