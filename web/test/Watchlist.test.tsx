import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Calendar } from '../src/components/Calendar';
import { formatDateHeading } from '../src/lib/format';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

type Calls = { url: string; method: string }[];
let calls: Calls;
let lists: Record<'US' | 'IN', string[]>;
let rowsBody: Record<'US' | 'IN', unknown[]>;
let putStatus: number;
let putGate: Promise<void> | null;

const usReport = (over: Record<string, unknown> = {}) => ({
  id: 1, symbol: 'TSM', name: 'Taiwan Semiconductor', reportDate: '2999-10-15', fiscalQuarter: 'Sep/2999', timing: 'BMO',
  expectedMove: { movePct: 6.19, provisional: false }, releasedAt: null,
  eps: { estimate: 1, actual: null, surprisePct: null, result: null, preliminary: false, corrected: false, basis: null },
  revenue: { estimate: 1, actual: null, surprisePct: null, result: null, preliminary: false, corrected: false, currency: 'USD' },
  ...over,
});

beforeEach(() => {
  localStorage.clear();
  calls = [];
  lists = { US: [], IN: ['RELIANCE'] };
  rowsBody = { US: [], IN: [] };
  putStatus = 204;
  putGate = null;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method });
    const [path, qs = ''] = url.split('?');
    const q = new URLSearchParams(qs);
    const mk = (q.get('market') ?? 'US') as 'US' | 'IN';
    if (path === '/api/prefs') return json(200, { market: localStorage.getItem('market') ?? 'US' });
    if (path === '/api/symbols') return json(200, { results: [{ symbol: 'TSM', name: 'Taiwan Semiconductor', exchange: 'NYSE' }] });
    if (path === '/api/watchlist') return json(200, { symbols: lists[mk] });
    if (path === '/api/watchlist/rows') return json(200, { rows: rowsBody[mk] });
    const m = /^\/api\/watchlist\/(US|IN)\/(.+)$/.exec(path!);
    if (m) {
      const sym = decodeURIComponent(m[2]!);
      if (method === 'PUT') {
        if (putGate) await putGate;
        if (putStatus !== 204) return json(putStatus, { error: 'no' });
      }
      const l = lists[m[1] as 'US' | 'IN'];
      if (method === 'PUT' && !l.includes(sym)) l.push(sym);
      if (method === 'DELETE') lists[m[1] as 'US' | 'IN'] = l.filter((s) => s !== sym);
      return new Response(null, { status: 204 });
    }
    if (path === '/api/earnings') return json(200, { rows: [usReport()], sources: [] });
    if (path === '/api/in/earnings') return json(200, { rows: [] });
    if (path === '/api/notes') return json(200, { notes: [] });
    if (path === '/api/expanded') return json(200, { symbols: [] });
    if (path === '/api/prices') return json(200, { prices: { TSM: { price: 123.45, prevClose: 120, changePct: 2.8, time: 0 } } });
    if (path === '/api/in/prices') return json(200, { prices: {} });
    return json(404, {});
  }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

test('search then pick adds to the list', async () => {
  render(<Calendar />);
  fireEvent.click(await screen.findByRole('button', { name: 'Watchlist' }));
  const box = await screen.findByRole('combobox', { name: /Add a stock/ });
  fireEvent.change(box, { target: { value: 'ts' } });
  const opt = await screen.findByRole('option', { name: /TSM/ });
  fireEvent.click(opt);
  await waitFor(() => expect(calls.some((c) => c.method === 'PUT' && c.url === '/api/watchlist/US/TSM')).toBe(true));
  expect(lists.US).toEqual(['TSM']);
});

test('star toggles and survives reload (server list)', async () => {
  const first = render(<Calendar />);
  const add = await screen.findByRole('button', { name: 'Add TSM to watchlist' });
  fireEvent.click(add);
  const remove = await screen.findByRole('button', { name: 'Remove TSM from watchlist' });
  expect(remove.className).toContain('on');
  await waitFor(() => expect(lists.US).toEqual(['TSM']));
  first.unmount();
  render(<Calendar />);
  expect(await screen.findByRole('button', { name: 'Remove TSM from watchlist' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Remove TSM from watchlist' }));
  await screen.findByRole('button', { name: 'Add TSM to watchlist' });
  await waitFor(() => expect(lists.US).toEqual([]));
});

test('watchlist view shows next date and live price; missing next date shows —', async () => {
  lists.US = ['TSM', 'AAPL'];
  rowsBody.US = [
    { symbol: 'TSM', name: 'Taiwan Semiconductor', next: usReport(), latest: usReport({
      id: 2, reportDate: '2026-07-16', releasedAt: 'x',
      eps: { estimate: 1, actual: 2.5, surprisePct: 5, result: 'beat', preliminary: true, corrected: false, basis: null } }) },
    { symbol: 'AAPL', name: 'Apple', next: null, latest: { source: 'yahoo', reportDate: null, fiscalQuarter: 'Jun/2026', periodEnd: '2026-06-30', eps: { actual: 1.4 } } },
  ];
  render(<Calendar />);
  fireEvent.click(await screen.findByRole('button', { name: 'Watchlist' }));
  const tsm = (await screen.findByText('Taiwan Semiconductor', { selector: '.wl-name' })).closest('li')!;
  expect(within(tsm).getByText(formatDateHeading('2999-10-15'))).toBeTruthy();
  expect(within(tsm).getByText('±6.2%')).toBeTruthy();
  expect(within(tsm).getByText('$123.45')).toBeTruthy();
  expect(within(tsm).getByText(/preliminary/)).toBeTruthy();
  expect(within(tsm).getByText('$2.50 ▲').className).toContain('beat');
  const aapl = screen.getByText('Apple', { selector: '.wl-name' }).closest('li')!;
  expect(within(aapl).getByTestId('next-date').textContent).toBe('—');
  expect(within(aapl).getByText(/from Yahoo/)).toBeTruthy();
  expect(within(aapl).getByTestId('latest-date').textContent).toBe('—');
});

test('an estimated next date (Yahoo backup) shows a muted marker; a confirmed one does not', async () => {
  lists.US = ['EST', 'CNF'];
  rowsBody.US = [
    { symbol: 'EST', name: 'Estimated Co', next: usReport({ dateStatus: 'estimated' }), latest: null },
    { symbol: 'CNF', name: 'Confirmed Co', next: usReport({ dateStatus: 'confirmed' }), latest: null },
  ];
  render(<Calendar />);
  fireEvent.click(await screen.findByRole('button', { name: 'Watchlist' }));
  const est = (await screen.findByText('Estimated Co', { selector: '.wl-name' })).closest('li')!;
  const cnf = screen.getByText('Confirmed Co', { selector: '.wl-name' }).closest('li')!;
  expect(within(est).getByTestId('next-estimated').textContent).toContain('estimated');
  expect(within(cnf).queryByTestId('next-estimated')).toBeNull();
});

test('a next date before today reads as results pending', async () => {
  lists.US = ['TSM'];
  rowsBody.US = [{ symbol: 'TSM', name: 'Taiwan Semiconductor', next: usReport({ reportDate: '2020-01-02' }), latest: null }];
  render(<Calendar />);
  fireEvent.click(await screen.findByRole('button', { name: 'Watchlist' }));
  expect(await screen.findByText('Results pending')).toBeTruthy();
});

test('India and US lists are separate', async () => {
  rowsBody.IN = [{ symbol: 'M&M', name: 'Mahindra', next: null, latest: null }];
  lists.IN = ['M&M'];
  render(<Calendar />);
  await screen.findByRole('button', { name: 'Add TSM to watchlist' });
  expect(calls.some((c) => c.url === '/api/watchlist?market=US')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'India' }));
  fireEvent.click(screen.getByRole('button', { name: 'Watchlist' }));
  expect(await screen.findByText('Mahindra', { selector: '.wl-name' })).toBeTruthy();
  expect(calls.some((c) => c.url === '/api/watchlist?market=IN')).toBe(true);
  expect(screen.queryByText('Taiwan Semiconductor', { selector: '.wl-name' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Remove M&M from watchlist' }));
  await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url === '/api/watchlist/IN/M%26M')).toBe(true));
  expect(lists.US).toEqual([]);
});

test('a refused add shows a message and the star goes back off', async () => {
  putStatus = 400;
  render(<Calendar />);
  fireEvent.click(await screen.findByRole('button', { name: 'Add TSM to watchlist' }));
  expect((await screen.findByRole('alert')).textContent).toBe('Could not add TSM: not a listed symbol');
  expect((await screen.findByRole('button', { name: 'Add TSM to watchlist' })).className).not.toContain('on');
});

test('rows are fetched again after the add is confirmed, so the new symbol shows', async () => {
  let release!: () => void;
  putGate = new Promise<void>((r) => { release = r; });
  render(<Calendar />);
  fireEvent.click(await screen.findByRole('button', { name: 'Watchlist' }));
  const box = await screen.findByRole('combobox', { name: /Add a stock/ });
  await screen.findByText(/Nothing on your watchlist/);
  fireEvent.change(box, { target: { value: 'ts' } });
  fireEvent.click(await screen.findByRole('option', { name: /TSM/ }));
  rowsBody.US = [{ symbol: 'TSM', name: 'Taiwan Semiconductor', next: null, latest: null }];
  const before = calls.filter((c) => c.url.startsWith('/api/watchlist/rows')).length;
  await new Promise((r) => setTimeout(r, 50));
  expect(calls.filter((c) => c.url.startsWith('/api/watchlist/rows')).length).toBe(before);
  release();
  expect(await screen.findByText('Taiwan Semiconductor', { selector: '.wl-name' })).toBeTruthy();
});
