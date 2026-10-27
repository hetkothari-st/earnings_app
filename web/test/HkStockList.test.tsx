import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import type { HkReportDto } from '../../server/src/hk/api/types';
import { HkStockList } from '../src/components/HkStockList';

const fig = { estimate: null, analysts: null, estimateCurrency: null, actual: null, actualCurrency: null, surprisePct: null, result: null };
const dto = (over: Partial<HkReportDto>): HkReportDto => ({
  id: 2_000_000_001, market: 'HK', symbol: '9988', name: 'Alibaba Group', level: 'full', adrTicker: 'BABA', adrRatio: 8,
  reportDate: '2026-11-13', dateStatus: 'confirmed', period: 'Q2 26', periodEnd: '2026-09-30', periodKind: 'Q',
  timing: 'BMO', timingSource: 'sec-6k', releasedAt: '2026-11-13T00:30:00.000Z', rescheduledFrom: null,
  sector: 'Consumer Cyclical', industry: 'Internet Retail', marketCap: 3.2e12, marketCapAsOf: '2026-11-12',
  currency: 'CNY', epsBasis: 'share', actualSource: 'sec', secDocUrl: 'https://www.sec.gov/Archives/edgar/data/1577552/x-index.htm',
  eps: { ...fig }, revenue: { ...fig }, expectedMove: null, liveMove: null, previousMove: null, ...over,
});

const mount = (rows: HkReportDto[], expanded: string[] = [], extra: Partial<React.ComponentProps<typeof HkStockList>> = {}) =>
  render(<HkStockList rows={rows} zone="Asia/Hong_Kong" expanded={new Set(expanded)} sort="date" onToggle={vi.fn()}
    notes={new Map()} onSaveNote={vi.fn()} {...extra} />);

describe('HkStockList', () => {
  test('basic rows show the Basic data tag, full rows do not', () => {
    mount([dto({}), dto({ id: 2_000_000_002, symbol: '0700', name: 'Tencent', level: 'basic', adrTicker: null, adrRatio: null })]);
    const tags = screen.getAllByText('Basic data');
    expect(tags).toHaveLength(1);
    expect(tags[0]!.getAttribute('title')).toContain('Only Yahoo data');
    expect(screen.getByRole('button', { name: /9988/ }).textContent).not.toContain('Basic data');
  });

  test('price shows Delayed', () => {
    mount([dto({})], [], { prices: { '9988': { price: 612.5, prevClose: 600, changePct: 2.08, at: '2026-11-12T07:55:00.000Z' } } });
    expect(screen.getByText('HK$612.50')).toBeTruthy();
    expect(screen.getByText('Delayed').className).toContain('delayed');
    expect(screen.getByText('+2.08%').className).toContain('up');
    expect(screen.getByRole('listitem').getAttribute('data-symbol')).toBe('9988');
  });

  test('every money value shows its currency', () => {
    const r = dto({
      eps: { ...fig, estimate: 1.2, estimateCurrency: 'HKD', actual: 1.1, actualCurrency: 'CNY' },
      revenue: { ...fig, estimate: 240e9, estimateCurrency: 'HKD', actual: 247_652_000_000, actualCurrency: 'CNY' },
    });
    mount([r], ['HK:9988']);
    const eps = screen.getByText('EPS estimate / actual').nextElementSibling!;
    expect(eps.textContent).toContain('HK$1.20');
    expect(eps.textContent).toContain('RMB¥1.10');
    const rev = screen.getByText('Revenue estimate / actual').nextElementSibling!;
    expect(rev.textContent).toContain('HK$240.0B');
    expect(rev.textContent).toContain('RMB¥247.7B');
    expect(rev.textContent).toContain('different currency or basis');
    expect(document.querySelector('.act.beat, .act.miss')).toBeNull();
    expect(rev.textContent).not.toMatch(/[▲▼]/);
  });

  test('per ADS label and from Yahoo tag', () => {
    const r = dto({
      level: 'basic', epsBasis: 'ads', actualSource: 'yahoo', currency: 'USD',
      eps: { ...fig, estimate: 0.5, estimateCurrency: 'USD', actual: 0.55, actualCurrency: 'USD', surprisePct: 10, result: 'beat' },
    });
    mount([r], ['HK:9988']);
    const eps = screen.getByText('EPS estimate / actual').nextElementSibling!;
    expect(eps.textContent).toContain('per ADS');
    expect(eps.textContent).toContain('from Yahoo');
    expect(eps.textContent).toContain('US$0.55');
    expect(eps.querySelector('.act')!.className).toContain('beat');
  });

  test('provisional expected move shows ≈ and the ADR', () => {
    const r = dto({
      expectedMove: { adr: 'BABA', expiry: '2026-11-20', strike: 130, callMid: 6, putMid: 5.5, underlying: 128, movePct: 9.1, illiquid: false, final: false, quoteDate: '2026-11-11', snapshotAt: '2026-11-11T21:00:00.000Z' },
    });
    mount([r], ['HK:9988']);
    const text = screen.getByText('Expected move').nextElementSibling!.textContent!;
    expect(text).toContain('≈±9.1%');
    expect(text).toContain('from ADR options');
    expect(text).toContain('BABA');
    expect(text).toContain('US$ straddle at 130');
    expect(text).toContain('(delayed)');
  });

  test('basic level shows no options data for the expected move', () => {
    mount([dto({ level: 'basic', adrTicker: null, adrRatio: null })], ['HK:9988']);
    expect(screen.getByText('Expected move').nextElementSibling!.textContent).toContain('no options data');
  });

  test('details show stock line, SEC notice status, release time and 6-K link', () => {
    mount([dto({})], ['HK:9988']);
    expect(screen.getByText(/ADR BABA \(1 ADS = 8 shares\)/)).toBeTruthy();
    expect(screen.getByText(/confirmed by SEC 6-K notice/)).toBeTruthy();
    expect(screen.getByText('Q2 26')).toBeTruthy();
    const link = screen.getByRole('link', { name: /SEC 6-K/ });
    expect(link.getAttribute('href')).toContain('sec.gov');
    expect(screen.getByText('HK$3.20T', { exact: false })).toBeTruthy();
  });

  test('expanded key is HK:<code>', () => {
    const onToggle = vi.fn();
    mount([dto({})], [], { onToggle });
    fireEvent.click(screen.getByRole('button', { name: /9988/ }));
    expect(onToggle).toHaveBeenCalledWith('HK:9988');
  });
});
