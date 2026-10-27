import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import type { JpFigureDto, JpReportDto } from '../../server/src/jp/api/types';
import { JpStockList } from '../src/components/JpStockList';

const fig: JpFigureDto = {
  estimate: null, analysts: null, estimateCurrency: null, estimateSpan: null, actual: null, actualCurrency: null,
  actualSource: null, actualSpan: null, ytdMonths: null, surprisePct: null, result: null,
};
const dto = (over: Partial<JpReportDto>): JpReportDto => ({
  id: 3_000_000_001, market: 'JP', symbol: '7203', name: 'Toyota Motor', nameJa: 'トヨタ自動車', level: 'full', adrTicker: 'TM', adrRatio: 10,
  reportDate: '2026-11-05', dateStatus: 'confirmed', period: '2Q FY27', periodEnd: '2026-09-30', fiscalQuarter: 2, fyEnd: '2027-03-31',
  timing: 'BMO', timingSource: 'sec-notice', releasedAt: null, rescheduledFrom: null,
  sector: 'Consumer Cyclical', industry: 'Auto Manufacturers', industryJa: '輸送用機器', marketCap: 48.04e12, marketCapAsOf: '2026-11-04',
  secDocUrl: null, edinetDocId: null, eps: { ...fig }, epsDiluted: null, revenue: { ...fig },
  expectedMove: null, liveMove: null, previousMove: null, ...over,
});

const mount = (rows: JpReportDto[], expanded: string[] = [], extra: Partial<React.ComponentProps<typeof JpStockList>> = {}) =>
  render(<JpStockList rows={rows} zone="Asia/Tokyo" expanded={new Set(expanded)} sort="date" onToggle={vi.fn()}
    notes={new Map()} onSaveNote={vi.fn()} {...extra} />);

describe('JpStockList', () => {
  test('basic rows show Basic data; price shows Delayed ~20 min', () => {
    mount([dto({}), dto({ id: 3_000_000_002, symbol: '6758', name: 'Sony', level: 'basic', adrTicker: null, adrRatio: null })],
      [], { prices: { '7203': { price: 2845.5, prevClose: 2800, changePct: 1.62, at: '2026-11-04T06:00:00.000Z' } } });
    const tags = screen.getAllByText('Basic data');
    expect(tags).toHaveLength(1);
    expect(tags[0]!.getAttribute('title')).toContain('Only Yahoo and EDINET data');
    expect(screen.getByText('¥2,845.5')).toBeTruthy();
    expect(screen.getByText('Delayed ~20 min').className).toContain('delayed');
    expect(screen.getByText('+1.62%').className).toContain('up');
  });

  test('YTD (9 months) label and no colour for a YTD actual vs a quarter estimate', () => {
    const r = dto({
      eps: { ...fig, estimate: 60, estimateCurrency: 'JPY', estimateSpan: 'quarter', actual: 180, actualCurrency: 'JPY', actualSource: 'edinet', actualSpan: 'ytd', ytdMonths: 9 },
      revenue: { ...fig, estimate: 11e12, estimateCurrency: 'JPY', estimateSpan: 'quarter', actual: 33e12, actualCurrency: 'JPY', actualSource: 'edinet', actualSpan: 'ytd', ytdMonths: 9 },
    });
    mount([r], ['JP:7203']);
    const eps = screen.getByText('EPS estimate / actual').nextElementSibling!;
    expect(eps.textContent).toContain('YTD (9 months)');
    expect(eps.textContent).toContain('different currency, basis or span');
    expect(eps.textContent).not.toMatch(/[▲▼]/);
    expect(document.querySelector('.act.beat, .act.miss')).toBeNull();
    expect(screen.getByText('Revenue estimate / actual').nextElementSibling!.textContent).toContain('YTD (9 months)');
  });

  test('EDINET actual shows from EDINET and the credit line', () => {
    const r = dto({
      level: 'basic', adrTicker: null, adrRatio: null,
      eps: { ...fig, estimate: 200, estimateCurrency: 'JPY', estimateSpan: 'quarter', actual: 239.1, actualCurrency: 'JPY', actualSource: 'edinet', actualSpan: 'quarter', surprisePct: 19.5, result: 'beat' },
      epsDiluted: 238.5,
    });
    mount([r], ['JP:7203']);
    const eps = screen.getByText('EPS estimate / actual').nextElementSibling!;
    expect(eps.textContent).toContain('¥239.10');
    expect(eps.textContent).toContain('from EDINET');
    expect(eps.textContent).toContain('diluted ¥238.50');
    expect(screen.getByText('Source: EDINET (Financial Services Agency), edited')).toBeTruthy();
  });

  test('no credit line when no figure is from EDINET', () => {
    mount([dto({})], ['JP:7203']);
    expect(screen.queryByText(/Source: EDINET/)).toBeNull();
  });

  test('ADR ratio 0.2 prints as 1 ADS = 0.2 shares', () => {
    mount([dto({ adrRatio: 0.2 })], ['JP:7203']);
    expect(screen.getByText(/1 ADS = 0\.2 shares/)).toBeTruthy();
    expect(screen.getByText('トヨタ自動車')).toBeTruthy();
  });

  test('unreleased full-level row shows the 3.5–6 h note', () => {
    mount([dto({})], ['JP:7203']);
    expect(screen.getByText(/SEC 6-K usually arrives 3\.5–6 h after the Tokyo release/)).toBeTruthy();
  });

  test('released full-level row shows the SEC filing time and link', () => {
    mount([dto({ releasedAt: '2026-11-05T07:30:00.000Z', secDocUrl: 'https://www.sec.gov/x.htm' })], ['JP:7203']);
    expect(screen.getByText(/Filed with SEC by 4:30 PM JST/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'SEC 6-K' })).toBeTruthy();
  });

  test('expanded key is JP:<code>', () => {
    const { rerender } = mount([dto({})], ['7203']);
    expect(screen.queryByText('EPS estimate / actual')).toBeNull();
    rerender(<JpStockList rows={[dto({})]} zone="Asia/Tokyo" expanded={new Set(['JP:7203'])} sort="date" onToggle={vi.fn()}
      notes={new Map()} onSaveNote={vi.fn()} />);
    expect(screen.getByText('EPS estimate / actual')).toBeTruthy();
  });
});
