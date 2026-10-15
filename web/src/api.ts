import type { EarningsResponse, StatusResponse } from '../../server/src/api/types';

export async function fetchEarnings(
  p: { from: string; to: string; minCap: number | null; q: string },
  signal: AbortSignal,
): Promise<EarningsResponse> {
  const qs = new URLSearchParams({ from: p.from, to: p.to });
  if (p.minCap != null) qs.set('minCap', String(p.minCap));
  if (p.q.trim()) qs.set('q', p.q.trim());
  const res = await fetch(`/api/earnings?${qs}`, { signal });
  if (!res.ok) throw new Error(`Server returned ${res.status}`);
  return res.json() as Promise<EarningsResponse>;
}

export async function fetchStatus(): Promise<StatusResponse> {
  const res = await fetch('/api/status');
  if (!res.ok) throw new Error(`Server returned ${res.status}`);
  return res.json() as Promise<StatusResponse>;
}
