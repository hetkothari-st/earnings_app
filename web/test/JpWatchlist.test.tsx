import { render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { useMarket } from '../src/hooks/useMarket';
import { WatchlistView } from '../src/components/WatchlistView';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

const fig = {
  estimate: null, analysts: null, estimateCurrency: null, estimateSpan: null, actual: null, actualCurrency: null,
  actualSource: null, actualSpan: null, ytdMonths: null, surprisePct: null, result: null,
};
const latest = {
  id: 3_000_000_001, market: 'JP', symbol: '7203', name: 'Toyota Motor', reportDate: '2026-08-05',
  eps: { ...fig, estimate: 200, estimateCurrency: 'JPY', actual: 239.1, actualCurrency: 'JPY', actualSource: 'edinet', actualSpan: 'ytd', ytdMonths: 6 },
  revenue: { ...fig },
};
const watch = { symbols: new Set(['7203']), version: 0, add: vi.fn(), remove: vi.fn(), error: null } as never;

test('JP watchlist: EDINET actual shows the EDINET marker and the credit line', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) =>
    url.startsWith('/api/watchlist/rows') ? json(200, { rows: [{ symbol: '7203', name: 'Toyota Motor', next: null, latest }] }) : json(404, {})));
  render(<WatchlistView market="JP" prices={{}} watch={watch} />);
  const row = (await screen.findByText('Toyota Motor')).closest('li')!;
  await waitFor(() => expect(row.textContent).toContain('¥239.10'));
  expect(row.textContent).toContain('from EDINET');
  expect(row.textContent).toContain('YTD (6 months)');
  expect(screen.getByText('Source: EDINET (Financial Services Agency), edited')).toBeTruthy();
});

test('useMarket accepts a server-side JP pref', async () => {
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async () => json(200, { market: 'JP' })));
  const { result } = renderHook(() => useMarket());
  await waitFor(() => expect(result.current.market).toBe('JP'));
  expect(localStorage.getItem('market')).toBe('JP');
});
