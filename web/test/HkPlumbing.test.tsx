import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import App from '../src/App';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

let calls: { url: string; method: string; body?: string }[];

beforeEach(() => {
  calls = [];
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body as string | undefined });
    const path = url.split('?')[0];
    if (path === '/api/me') return json(200, { id: '1A', isAdmin: false });
    if (path === '/api/prefs') return init?.method === 'PUT' ? new Response(null, { status: 204 }) : json(200, { market: 'US' });
    if (path === '/api/expanded') return json(200, { symbols: [] });
    if (path === '/api/markets') return json(200, { indices: [] });
    if (path === '/api/earnings') return json(200, { rows: [], sources: [] });
    if (path === '/api/hk/earnings') return json(200, { rows: [] });
    if (path === '/api/hk/prices') return json(200, { prices: {} });
    if (path === '/api/notes') return json(200, { notes: [] });
    if (path === '/api/prices') return json(200, { prices: {} });
    if (path === '/api/watchlist') return json(200, { symbols: [] });
    return json(404, {});
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

test('Hong Kong button switches market and PUTs prefs', async () => {
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: 'Hong Kong' }));
  await waitFor(() => expect(calls.some((c) => c.url === '/api/prefs' && c.method === 'PUT' && c.body === '{"market":"HK"}')).toBe(true));
  await waitFor(() => expect(calls.some((c) => c.url.startsWith('/api/hk/earnings?'))).toBe(true));
  expect(screen.getByPlaceholderText('Find a code or company')).toBeTruthy();
  expect(screen.queryByLabelText('Market cap')).toBeNull();
  expect(await screen.findByText(/Times in HKT/)).toBeTruthy();
});

test('stored HK market is restored', async () => {
  localStorage.setItem('market', 'HK');
  render(<App />);
  await screen.findByRole('button', { name: 'Hong Kong' });
  expect(document.getElementById('market-hk')!.getAttribute('aria-pressed')).toBe('true');
});
