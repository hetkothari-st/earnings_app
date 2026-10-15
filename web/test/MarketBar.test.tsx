import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { MarketBar } from '../src/components/MarketBar';

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
