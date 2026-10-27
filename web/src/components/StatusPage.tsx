import { useEffect, useState } from 'react';
import type { CoverageRow, StatusResponse } from '../../../server/src/api/types';
import { fetchStatus } from '../api';

function CoverageTable({ market, rows }: { market: string; rows: CoverageRow[] }) {
  return (
    <table className="status coverage">
      <caption>{market}: filled over reports in the next 14 days (expected move: 7 days)</caption>
      <thead><tr><th>Field</th><th>Filled</th><th>Coverage</th><th>Minimum</th></tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.field} className={r.ok ? undefined : 'below'}>
            <td>{r.field}</td>
            <td>{r.filled}/{r.total}</td>
            <td>{r.pct}%</td>
            <td>{r.min}%</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function StatusPage() {
  const [data, setData] = useState<StatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { fetchStatus().then(setData).catch((e: Error) => setError(e.message)); }, []);
  if (error) return <main className="page"><p className="warn-text">Could not load status: {error}</p></main>;
  if (!data) return <main className="page"><p>Loading…</p></main>;
  return (
    <main className="page">
      <h1>Data source status</h1>
      <p>{data.counts.reports} reports · {data.counts.withExpectedMove} with expected move · {data.counts.secVerified} timing-checked against SEC</p>
      <table className="status">
        <thead><tr><th>Source</th><th>State</th><th>Last success</th><th>Last error</th><th>Error at</th></tr></thead>
        <tbody>
          {data.sources.map((s) => (
            <tr key={s.source}>
              <td>{s.source}</td>
              <td className={`state-${s.state ?? 'none'}`}>
                {s.state ?? '—'}
                {s.state === 'blocked' && s.blockedUntil && <span className="muted"> until {new Date(s.blockedUntil).toLocaleString()}</span>}
              </td>
              <td>{s.lastSuccessAt ? new Date(s.lastSuccessAt).toLocaleString() : '—'}</td>
              <td>{s.lastError ?? '—'}</td>
              <td>{s.lastErrorAt ? new Date(s.lastErrorAt).toLocaleString() : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <CoverageTable market="US" rows={data.coverage.US} />
      <CoverageTable market="India" rows={data.coverage.IN} />
      <CoverageTable market="Hong Kong" rows={data.coverage.HK} />
      <p><a href="/">← Back to calendar</a></p>
    </main>
  );
}
