import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Calendar } from '../src/components/Calendar';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

let calls: { url: string; method: string }[];
let list: string[];

const usReport = (over: Record<string, unknown> = {}) => ({
  id: 1, symbol: 'TSM', name: 'Taiwan Semiconductor', reportDate: '2999-10-15', fiscalQuarter: 'Sep/2999', timing: 'BMO',
  expectedMove: null, liveExpectedMove: null, previousMove: null, releasedAt: null, marketCap: null, sector: null, industry: null,
  sessionClose: '16:00', dateStatus: 'confirmed', rescheduledFrom: null, flags: [], sec: { docUrl: null, check: null },
  eps: { estimate: 1, actual: null, surprisePct: null, result: null, preliminary: false, corrected: false, basis: null, lastYear: null },
  revenue: { estimate: 1, actual: null, surprisePct: null, result: null, preliminary: false, corrected: false, currency: 'USD' },
  ...over,
});

/** Rows the server returns for the saved list: AAPL has an upcoming report, NEWCO has no date yet. */
const rowFor = (symbol: string) =>
  symbol === 'NEWCO'
    ? { symbol, name: 'New Co', next: null, latest: null }
    : { symbol, name: `${symbol} Inc`, next: usReport({ id: symbol.length, symbol, name: `${symbol} Inc` }), latest: null };

beforeEach(() => {
  localStorage.clear();
  calls = [];
  list = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method });
    const [path] = url.split('?');
    if (path === '/api/prefs') return json(200, { market: 'US' });
    if (path === '/api/symbols') return json(200, { results: [{ symbol: 'AAPL', name: 'AAPL Inc', exchange: 'NASDAQ' }] });
    if (path === '/api/watchlist') return json(200, { symbols: list });
    if (path === '/api/watchlist/rows') return json(200, { rows: list.map(rowFor) });
    const m = /^\/api\/watchlist\/US\/(.+)$/.exec(path!);
    if (m) {
      const sym = decodeURIComponent(m[1]!);
      if (method === 'PUT' && !list.includes(sym)) list.push(sym);
      if (method === 'DELETE') list = list.filter((s) => s !== sym);
      return new Response(null, { status: 204 });
    }
    // The normal calendar has TSM this week; "My stocks" must not show it unless it was picked.
    if (path === '/api/earnings') return json(200, { rows: [usReport()], sources: [] });
    if (path === '/api/notes') return json(200, { notes: [] });
    if (path === '/api/expanded') return json(200, { symbols: [] });
    if (path === '/api/prices') return json(200, { prices: {} });
    return json(404, {});
  }));
});
afterEach(() => { vi.unstubAllGlobals(); });

const pickView = async (label: string) => {
  const select = await screen.findByRole('combobox', { name: 'View' });
  fireEvent.change(select, { target: { value: label === 'My stocks' ? 'mine' : 'all' } });
};

test('US starts on the original view; "My stocks" starts empty and hides the calendar rows', async () => {
  render(<Calendar />);
  expect(await screen.findByText('Taiwan Semiconductor')).toBeTruthy();
  expect((screen.getByRole('combobox', { name: 'View' }) as HTMLSelectElement).value).toBe('all');
  await pickView('My stocks');
  expect(await screen.findByText(/No stocks added yet/)).toBeTruthy();
  expect(screen.queryByText('Taiwan Semiconductor')).toBeNull();
  expect(screen.queryByRole('tablist', { name: 'Period' })).toBeNull();
});

test('search, pick and the stock is saved and shown, and only picked stocks are shown', async () => {
  render(<Calendar />);
  await pickView('My stocks');
  const box = await screen.findByRole('combobox', { name: /Add a stock/ });
  fireEvent.change(box, { target: { value: 'aa' } });
  fireEvent.click(await screen.findByRole('option', { name: /AAPL/ }));
  await waitFor(() => expect(calls.some((c) => c.method === 'PUT' && c.url === '/api/watchlist/US/AAPL')).toBe(true));
  const section = await screen.findByRole('region', { name: 'My stocks' });
  expect(await within(section).findByText('AAPL Inc')).toBeTruthy();
  expect(within(section).queryByText('Taiwan Semiconductor')).toBeNull();
});

test('the chosen view and the saved stocks come back after a reload', async () => {
  list = ['AAPL'];
  const first = render(<Calendar />);
  await pickView('My stocks');
  await screen.findByText('AAPL Inc');
  first.unmount();
  render(<Calendar />);
  expect(await screen.findByText('AAPL Inc')).toBeTruthy();
  expect((screen.getByRole('combobox', { name: 'View' }) as HTMLSelectElement).value).toBe('mine');
});

test('a picked stock with no earnings date yet is listed and can be removed', async () => {
  list = ['NEWCO'];
  render(<Calendar />);
  await pickView('My stocks');
  expect(await screen.findByText('New Co')).toBeTruthy();
  expect(screen.getByText('No earnings date yet')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Remove NEWCO' }));
  await waitFor(() => expect(list).toEqual([]));
  expect(await screen.findByText(/No stocks added yet/)).toBeTruthy();
});

test('remove all asks first, then empties the list', async () => {
  list = ['AAPL', 'NEWCO'];
  render(<Calendar />);
  await pickView('My stocks');
  await screen.findByText('AAPL Inc');
  fireEvent.click(screen.getByRole('button', { name: 'Remove all' }));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(list).toEqual(['AAPL', 'NEWCO']);
  fireEvent.click(screen.getByRole('button', { name: 'Remove all' }));
  fireEvent.click(screen.getByRole('button', { name: 'Yes, remove all 2' }));
  await waitFor(() => expect(list).toEqual([]));
  expect(await screen.findByText(/No stocks added yet/)).toBeTruthy();
});
