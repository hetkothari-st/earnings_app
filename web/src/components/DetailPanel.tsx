import type { ReportDto } from '../../../server/src/api/types';
import { formatDateHeading, formatEps, formatPct, formatUsd, formatUsdFull } from '../lib/format';
import { describeTiming } from '../lib/time';
import { Warn } from './EarningsTable';

const SEC_TEXT: Record<string, string> = {
  verified: '✓ Verified: 8-K filed before the open',
  consistent: '≈ Consistent with the 8-K filing time',
  derived: '✓ Timing taken from the 8-K filing time',
  contradicted: '⚠ Contradicted by the 8-K filing time',
  unverifiable: 'Not verifiable from the 8-K filing time',
};

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');

export function DetailPanel({ r, zone, onClose }: { r: ReportDto; zone: string; onClose: () => void }) {
  const t = describeTiming(r.reportDate, r.timing, r.sessionClose, zone);
  const em = r.expectedMove;
  return (
    <aside className="panel" aria-label={`${r.symbol} details`}>
      <button className="close" onClick={onClose} aria-label="Close">×</button>
      <h2>{r.symbol} <span className="name">{r.name}</span></h2>
      <p className="muted">{r.fiscalQuarter ? `Quarter ending ${r.fiscalQuarter} · ` : ''}{formatDateHeading(r.reportDate)}</p>
      {r.rescheduledFrom && <p className="warn-text">Rescheduled from {formatDateHeading(r.rescheduledFrom)}</p>}

      <section>
        <h3>Release time</h3>
        <p>{t.et} ET · {t.local}{t.nextDay ? ' (+1 day)' : ''} your time</p>
        <p className="muted">Timing source: {r.timingSource ?? 'none'}</p>
        {r.sec.check && <p>{SEC_TEXT[r.sec.check]}{r.sec.acceptedAt ? ` (accepted ${r.sec.acceptedAt.replace('T', ' ')} ET)` : ''}</p>}
        <Warn flags={r.flags.filter((f) => f.field === 'timing')} />
      </section>

      <section>
        <h3>Results</h3>
        <dl>
          <dt>EPS</dt>
          <dd>Est {formatEps(r.eps.estimate)} · Actual {formatEps(r.eps.actual)} · Surprise {formatPct(r.eps.surprisePct)}
            {r.eps.noOfEsts != null && ` · ${r.eps.noOfEsts} estimates`}</dd>
          <dt>Last year</dt>
          <dd>{r.eps.lastYear == null ? '—' : `${formatEps(r.eps.lastYear)}${r.eps.lastYearReportDate ? ` (reported ${formatDateHeading(r.eps.lastYearReportDate)})` : ''}`}</dd>
          <dt>Revenue</dt>
          <dd>Est {formatUsdFull(r.revenue.estimate)} · Actual {formatUsdFull(r.revenue.actual)} · Surprise {formatPct(r.revenue.surprisePct)}</dd>
          <dt>Market cap</dt>
          <dd>{formatUsd(r.marketCap)}{r.marketCapAsOf && ` (as of ${r.marketCapAsOf})`}</dd>
          <dt>Exchange</dt>
          <dd>{r.exchange ?? '—'} (primary listing)</dd>
        </dl>
      </section>

      <section>
        <h3>Options-implied move</h3>
        {em ? (
          <p>±{em.movePct.toFixed(2)}% — straddle at strike {em.strike} expiring {em.expiry}: call mid {em.callMid.toFixed(2)} + put mid {em.putMid.toFixed(2)}, stock {em.underlying.toFixed(2)}. Snapshot {when(em.snapshotAt)}.</p>
        ) : <p>—</p>}
        <p className="muted">Our calculation from Cboe delayed quotes; includes some non-earnings time value, so it may read slightly above vendor figures.</p>
      </section>

      <section>
        <h3>Official release</h3>
        {r.sec.docUrl ? (
          <p><a href={r.sec.docUrl} target="_blank" rel="noreferrer">8-K on SEC EDGAR</a> · <a href={r.sec.indexUrl ?? undefined} target="_blank" rel="noreferrer">Filing index (Exhibit 99.1)</a></p>
        ) : <p>—</p>}
      </section>

      <section>
        <h3>Sources</h3>
        <ul className="muted">
          <li>Calendar, EPS, market cap: Nasdaq, fetched {when(r.fetched.calendar)}</li>
          <li>Revenue: Finnhub, fetched {when(r.fetched.revenue)}</li>
          <li>Exchange, filing check: SEC EDGAR, checked {when(r.fetched.sec)}</li>
        </ul>
      </section>
    </aside>
  );
}
