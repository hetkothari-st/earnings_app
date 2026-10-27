import { render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { StatusPage } from '../src/components/StatusPage';

const cov = (field: string, filled: number, total: number, min: number) =>
  ({ field, filled, total, pct: Math.round((filled / total) * 1000) / 10, min, ok: (filled / total) * 100 >= min });

const body = {
  sources: [
    { source: 'nasdaq', lastSuccessAt: '2026-10-21T10:00:00.000Z', lastError: null, lastErrorAt: null, state: 'ok', blockedUntil: null },
    { source: 'yahoo', lastSuccessAt: null, lastError: 'HTTP 429', lastErrorAt: '2026-10-21T09:00:00.000Z', state: 'blocked', blockedUntil: '2026-10-21T11:30:00.000Z' },
    { source: 'finnhub', lastSuccessAt: null, lastError: 'boom', lastErrorAt: '2026-10-21T09:00:00.000Z', state: 'backup', blockedUntil: null },
  ],
  counts: { reports: 10, withExpectedMove: 4, secVerified: 2 },
  coverage: { US: [cov('epsEstimate', 9, 10, 85), cov('timing', 3, 10, 70)], IN: [cov('marketCap', 10, 10, 95)], HK: [cov('adrTicker', 3, 4, 70)], JP: [cov('edinetCode', 5, 8, 50)] },
};

test('Hong Kong coverage table renders', async () => {
  mount();
  const row = (await screen.findByText('adrTicker')).closest('tr')!;
  expect(row.textContent).toContain('3/4');
  expect(row.closest('table')!.querySelector('caption')!.textContent).toContain('Hong Kong');
});

test('Japan coverage table renders', async () => {
  mount();
  const row = (await screen.findByText('edinetCode')).closest('tr')!;
  expect(row.textContent).toContain('5/8');
  expect(row.closest('table')!.querySelector('caption')!.textContent).toContain('Japan');
});

afterEach(() => vi.unstubAllGlobals());

function mount() {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
  render(<StatusPage />);
}

test('status page shows a blocked source with its retry time', async () => {
  mount();
  const row = (await screen.findByText('yahoo')).closest('tr')!;
  expect(within(row).getByText('blocked')).toBeTruthy();
  expect(row.textContent).toContain(`until ${new Date('2026-10-21T11:30:00.000Z').toLocaleString()}`);
  const ok = screen.getByText('nasdaq').closest('tr')!;
  expect(within(ok).getByText('ok')).toBeTruthy();
  expect(within(screen.getByText('finnhub').closest('tr')!).getByText('backup')).toBeTruthy();
});

test('status page shows coverage per field with its minimum and flags the ones below', async () => {
  mount();
  await waitFor(() => expect(screen.getByText('epsEstimate')).toBeTruthy());
  const eps = screen.getByText('epsEstimate').closest('tr')!;
  expect(eps.textContent).toContain('9/10');
  expect(eps.textContent).toContain('85%');
  expect(eps.className).not.toContain('below');
  expect(screen.getByText('timing').closest('tr')!.className).toContain('below');
});
