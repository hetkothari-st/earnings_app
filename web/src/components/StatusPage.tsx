import { useEffect, useState } from 'react';
import type { StatusResponse } from '../../../server/src/api/types';
import { fetchStatus } from '../api';

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
        <thead><tr><th>Source</th><th>Last success</th><th>Last error</th><th>Error at</th></tr></thead>
        <tbody>
          {data.sources.map((s) => (
            <tr key={s.source}>
              <td>{s.source}</td>
              <td>{s.lastSuccessAt ? new Date(s.lastSuccessAt).toLocaleString() : '—'}</td>
              <td>{s.lastError ?? '—'}</td>
              <td>{s.lastErrorAt ? new Date(s.lastErrorAt).toLocaleString() : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p><a href="/">← Back to calendar</a></p>
    </main>
  );
}
