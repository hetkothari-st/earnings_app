import { DateTime } from 'luxon';
import { useEffect } from 'react';
import type { ReportDto } from '../../../server/src/api/types';
import { formatDateHeading, formatEps, formatPct, formatUsd, formatUsdFull } from '../lib/format';
import { describeTiming, zoneLabel } from '../lib/time';
import { Warn } from './EarningsTable';

const SEC_TEXT: Record<string, string> = {
  verified: 'Confirmed: the SEC filing was accepted before the open.',
  consistent: 'Consistent with the SEC filing time.',
  derived: 'Taken from the SEC filing time; no other source gave a time.',
  contradicted: 'The SEC filing time contradicts this timing.',
  unverifiable: 'The SEC filing time cannot confirm this timing.',
};

const SOURCE_TEXT: Record<string, string> = { nasdaq: 'Nasdaq', finnhub: 'Finnhub', sec: 'SEC filing' };

export function DetailPanel({ r, zone, onClose }: { r: ReportDto; zone: string; onClose: () => void }) {
  const t = describeTiming(r.reportDate, r.timing, r.sessionClose, zone);
  const em = r.expectedMove;
  const when = (iso: string | null) =>
    iso ? DateTime.fromISO(iso).setZone(zone).setLocale('en-US').toFormat('d LLL, h:mm a') : 'not yet';

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <>
      <div className="scrim" onClick={onClose} aria-hidden="true" />
      <aside className={`panel s-${r.timing.toLowerCase()}`} aria-label={`${r.symbol} details`}>
        <button className="close icon" onClick={onClose} aria-label="Close">×</button>
        <p className="panel-ticker">{r.symbol}</p>
        <h2>{r.name}</h2>
        <p className="muted">
          {formatDateHeading(r.reportDate)}{r.fiscalQuarter ? `, quarter ending ${r.fiscalQuarter}` : ''}
        </p>
        {r.rescheduledFrom && <p className="note">Moved from {formatDateHeading(r.rescheduledFrom)}</p>}

        <section>
          <h3>Release time</h3>
          <dl>
            <dt>US Eastern</dt><dd>{t.et}</dd>
            <dt>Your time ({zoneLabel(zone, r.reportDate)})</dt><dd>{t.local}{t.nextDay ? ' (next day)' : ''}</dd>
            <dt>Source</dt><dd>{r.timingSource ? SOURCE_TEXT[r.timingSource] : 'None yet'}</dd>
            {r.sec.check && (
              <><dt>SEC check</dt><dd>{SEC_TEXT[r.sec.check]}{r.sec.acceptedAt && ` Accepted ${r.sec.acceptedAt.slice(11, 16)} ET.`}</dd></>
            )}
          </dl>
          <Warn flags={r.flags.filter((f) => f.field === 'timing')} />
        </section>

        <section>
          <h3>Results</h3>
          <dl>
            <dt>EPS estimate</dt><dd>{formatEps(r.eps.estimate)}{r.eps.noOfEsts != null && <span className="muted"> from {r.eps.noOfEsts} analysts</span>}</dd>
            <dt>EPS actual</dt><dd className={r.eps.result ?? ''}>{formatEps(r.eps.actual)}{r.eps.surprisePct != null && ` (${formatPct(r.eps.surprisePct)})`} <Warn flags={r.flags.filter((f) => f.field === 'eps')} /></dd>
            <dt>Same quarter last year</dt><dd>{formatEps(r.eps.lastYear)}{r.eps.lastYearReportDate && <span className="muted"> reported {formatDateHeading(r.eps.lastYearReportDate)}</span>}</dd>
            <dt>Revenue estimate</dt><dd>{formatUsdFull(r.revenue.estimate)}</dd>
            <dt>Revenue actual</dt><dd className={r.revenue.result ?? ''}>{formatUsdFull(r.revenue.actual)}{r.revenue.surprisePct != null && ` (${formatPct(r.revenue.surprisePct)})`}</dd>
            <dt>Market cap</dt><dd>{formatUsd(r.marketCap)}{r.marketCapAsOf && <span className="muted"> as of {r.marketCapAsOf}</span>}</dd>
            <dt>Exchange</dt><dd>{r.exchange ?? '—'} <span className="muted">(primary listing)</span></dd>
          </dl>
        </section>

        <section>
          <h3>Options-implied move</h3>
          {em ? (
            <>
              <p className="big-move">±{em.movePct.toFixed(2)}%</p>
              <p className="muted">
                Straddle at the {em.strike} strike expiring {formatDateHeading(em.expiry)}: call {em.callMid.toFixed(2)} plus put {em.putMid.toFixed(2)},
                against a close of {em.underlying.toFixed(2)}. Priced {when(em.snapshotAt)}.
              </p>
            </>
          ) : <p className="muted">Not available. It is calculated after the close before the report.</p>}
          <p className="fine">Our calculation from delayed Cboe quotes. It includes some time value unrelated to earnings, so it can read slightly above vendor figures.</p>
        </section>

        <section>
          <h3>Official release</h3>
          {r.sec.docUrl ? (
            <p className="links">
              <a href={r.sec.docUrl} target="_blank" rel="noreferrer">8-K filing on SEC EDGAR</a>
              <a href={r.sec.indexUrl ?? undefined} target="_blank" rel="noreferrer">All filing documents (press release is Exhibit 99.1)</a>
            </p>
          ) : <p className="muted">Linked once the company files its results with the SEC.</p>}
        </section>

        <section>
          <h3>Where this data comes from</h3>
          <dl className="fine">
            <dt>Calendar, EPS, market cap</dt><dd>Nasdaq, updated {when(r.fetched.calendar)}</dd>
            <dt>Revenue, EPS actual</dt><dd>Finnhub, updated {when(r.fetched.revenue)}</dd>
            <dt>Exchange, filing check</dt><dd>SEC EDGAR, checked {when(r.fetched.sec)}</dd>
          </dl>
        </section>
      </aside>
    </>
  );
}
