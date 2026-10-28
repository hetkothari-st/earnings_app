import { render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { EuropeMarketBar, HongKongMarketBar, IndiaMarketBar, JapanMarketBar, MarketBar } from '../src/components/MarketBar';

test('HK strip shows Hang Seng, HS China Enterprises, HS Tech with delayed label', async () => {
  const polled = [
    { index: 'Hang Seng', price: 25012.3, changePct: 0.5, asOf: 'x' },
    { index: 'HS China Enterprises', price: 9000.1, changePct: -0.2, asOf: 'x' },
    { index: 'HS Tech', price: 5500.55, changePct: 1.1, asOf: 'x' },
  ];
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ indices: polled }), { status: 200 })));
  const { rerender } = render(<HongKongMarketBar />);
  expect(await screen.findByText('Hang Seng · delayed')).toBeTruthy();
  expect(screen.getByText('HS China Enterprises · delayed')).toBeTruthy();
  expect(screen.getByText('HS Tech · delayed')).toBeTruthy();
  expect(screen.getAllByText('HKEX')).toHaveLength(3);
  expect(screen.getByText('25,012.30')).toBeTruthy();
  rerender(<HongKongMarketBar live={[{ index: 'Hang Seng', price: 25020, changePct: 0.53, asOf: 'y' }]} />);
  expect(screen.getByText('25,020.00')).toBeTruthy();
  expect(screen.getByText('5,500.55')).toBeTruthy();
  vi.unstubAllGlobals();
});

const idx = (exchange: string, index: string, price: number | null, changePct: number | null) =>
  ({ exchange, index, symbol: index, price, changePct, asOf: '2026-10-14T20:36:08.000Z', currency: 'USD' });

test('shows each exchange with its index level and signed change', () => {
  render(<MarketBar indices={[idx('NYSE', 'S&P 500', 7718.94, -1.11), idx('Japan Exchange', 'Nikkei 225', 64425.95, 0.42)]} />);
  expect(screen.getByText('7,718.94')).toBeTruthy();
  expect(screen.getByText('−1.11%').className).toContain('down');
  expect(screen.getByText('+0.42%').className).toContain('up');
  expect(screen.getByText('NYSE')).toBeTruthy();
});

test('an unavailable index shows a dash, never a zero', () => {
  render(<MarketBar indices={[idx('Euronext', 'Euronext 100', null, null)]} />);
  expect(screen.getByText('Euronext 100').parentElement!.textContent).toContain('—');
});

test('India strip: live Kite ticks replace the polled level at once', async () => {
  const polled = [
    { index: 'NIFTY 50', price: 22623.45, changePct: -0.82, asOf: 'x', source: 'kite' },
    { index: 'SENSEX', price: 73168.56, changePct: -0.73, asOf: 'x', source: 'kite' },
  ];
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ indices: polled }), { status: 200 })));
  const { rerender } = render(<IndiaMarketBar />);
  expect(await screen.findByText('22,623.45')).toBeTruthy();
  rerender(<IndiaMarketBar live={[{ index: 'NIFTY 50', price: 22630.1, changePct: -0.79, asOf: 'y', source: 'kite' }]} />);
  expect(screen.getByText('22,630.10')).toBeTruthy();
  expect(screen.getByText('73,168.56')).toBeTruthy(); // no tick yet: polled level stays
  vi.unstubAllGlobals();
});

test('JP strip shows Nikkei 225 and TOPIX (ETF 1306) with delayed label', async () => {
  const polled = [
    { index: 'Nikkei 225', price: 64425.95, changePct: 0.42, asOf: 'x' },
    { index: 'TOPIX (ETF 1306)', price: 3650.5, changePct: -0.3, asOf: 'x' },
  ];
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ indices: polled }), { status: 200 })));
  const { rerender } = render(<JapanMarketBar />);
  expect(await screen.findByText('Nikkei 225 · delayed')).toBeTruthy();
  expect(screen.getByText('TOPIX (ETF 1306) · delayed')).toBeTruthy();
  expect(screen.getAllByText('TSE')).toHaveLength(2);
  expect(screen.getByText('64,425.95')).toBeTruthy();
  rerender(<JapanMarketBar live={[{ index: 'Nikkei 225', price: 64500, changePct: 0.5, asOf: 'y' }]} />);
  expect(screen.getByText('64,500.00')).toBeTruthy();
  expect(screen.getByText('3,650.50')).toBeTruthy();
  vi.unstubAllGlobals();
});

test('UK strip shows FTSE 100, FTSE 250, FTSE AIM All-Share; EU strip shows 8 indices, delayed', async () => {
  const uk = [
    { index: 'FTSE 100', price: 9512.3, changePct: 0.2, asOf: 'x' },
    { index: 'FTSE 250', price: 21950.1, changePct: -0.1, asOf: 'x' },
    { index: 'FTSE AIM All-Share', price: 745.12, changePct: null, asOf: null },
  ];
  const eu = ['Euro Stoxx 50', 'DAX', 'CAC 40', 'AEX', 'IBEX 35', 'FTSE MIB', 'SMI', 'OMXS30']
    .map((index, i) => ({ index, price: 1000 + i, changePct: 0.1, asOf: 'x' }));
  const fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify({ indices: url === '/api/uk/markets' ? uk : eu }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  const { rerender, unmount } = render(<EuropeMarketBar market="UK" />);
  expect(await screen.findByText('FTSE 100 · delayed')).toBeTruthy();
  expect(screen.getByText('FTSE 250 · delayed')).toBeTruthy();
  expect(screen.getByText('FTSE AIM All-Share · delayed')).toBeTruthy();
  expect(screen.getByText('9,512.30')).toBeTruthy();
  rerender(<EuropeMarketBar market="UK" live={[{ index: 'FTSE 100', price: 9520, changePct: 0.28, asOf: 'y' }]} />);
  expect(screen.getByText('9,520.00')).toBeTruthy();
  expect(screen.getByText('21,950.10')).toBeTruthy();
  unmount();
  render(<EuropeMarketBar market="EU" />);
  expect(await screen.findByText('Euro Stoxx 50 · delayed')).toBeTruthy();
  expect(screen.getAllByText(/ · delayed$/)).toHaveLength(8);
  expect(fetchMock.mock.calls.some(([u]) => u === '/api/eu/markets')).toBe(true);
  vi.unstubAllGlobals();
});
