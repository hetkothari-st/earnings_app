import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import App from '../src/App';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

let calls: { url: string; method: string; body?: string }[];
let prefMarket: string | null;

beforeEach(() => {
  calls = [];
  prefMarket = 'US';
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body as string | undefined });
    const path = url.split('?')[0];
    if (path === '/api/me') return json(200, { id: '1A', isAdmin: false });
    if (path === '/api/prefs') return init?.method === 'PUT' ? new Response(null, { status: 204 }) : prefMarket ? json(200, { market: prefMarket }) : json(404, {});
    if (path === '/api/expanded') return json(200, { symbols: [] });
    if (path === '/api/markets') return json(200, { indices: [] });
    if (path === '/api/earnings') return json(200, { rows: [], sources: [] });
    if (path === '/api/uk/earnings' || path === '/api/eu/earnings') return json(200, { rows: [] });
    if (path === '/api/uk/prices' || path === '/api/eu/prices') return json(200, { prices: {} });
    if (path === '/api/uk/markets' || path === '/api/eu/markets') return json(200, { indices: [] });
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

test('UK button switches market, PUTs prefs and requests /api/uk/earnings', async () => {
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: 'UK' }));
  await waitFor(() => expect(calls.some((c) => c.url === '/api/prefs' && c.method === 'PUT' && c.body === '{"market":"UK"}')).toBe(true));
  await waitFor(() => expect(calls.some((c) => c.url.startsWith('/api/uk/earnings?'))).toBe(true));
  expect(calls.some((c) => c.url === '/api/uk/prices')).toBe(true);
  expect(screen.getByPlaceholderText('Find a ticker or company')).toBeTruthy();
  expect(screen.queryByLabelText('Market cap')).toBeNull();
  expect(await screen.findByText(/Times in London time\./)).toBeTruthy();
  expect(screen.getByText(/Tradegate \(real-time, EUR\), PR Newswire and ESEF filings via filings\.xbrl\.org/)).toBeTruthy();
  expect(screen.queryByText(/DILA/)).toBeNull();
});

test('Europe button requests /api/eu/earnings', async () => {
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: 'Europe' }));
  await waitFor(() => expect(calls.some((c) => c.url === '/api/prefs' && c.method === 'PUT' && c.body === '{"market":"EU"}')).toBe(true));
  await waitFor(() => expect(calls.some((c) => c.url.startsWith('/api/eu/earnings?'))).toBe(true));
  expect(calls.some((c) => c.url.startsWith('/api/uk/earnings'))).toBe(false);
  expect(await screen.findByText(/Times in each exchange's local time\./)).toBeTruthy();
  expect(screen.getByText(/DILA \(AMF regulated information\)/)).toBeTruthy();
});

test('stored EU market restored', async () => {
  localStorage.setItem('market', 'EU');
  prefMarket = null; // only the local copy
  render(<App />);
  await screen.findByRole('button', { name: 'Europe' });
  expect(document.getElementById('market-eu')!.getAttribute('aria-pressed')).toBe('true');
  expect(document.getElementById('market-uk')!.getAttribute('aria-pressed')).toBe('false');
  await waitFor(() => expect(calls.some((c) => c.url.startsWith('/api/eu/earnings?'))).toBe(true));
});
