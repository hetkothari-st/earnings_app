import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { CurrencyFigure, ExpectedMoveLine } from '../src/components/foreignParts';
import { formatJpEps } from '../src/lib/format';

const fig = { estimate: 100, analysts: 3, estimateCurrency: 'JPY', actual: 120, actualCurrency: 'JPY', surprisePct: 20, result: 'beat' as const };

describe('foreignParts', () => {
  test('CurrencyFigure shows span label and EDINET source', () => {
    render(<p data-testid="f"><CurrencyFigure f={fig} fmt={formatJpEps} source="EDINET" spanLabel="YTD (9 months)" extra={null} /></p>);
    const t = screen.getByTestId('f').textContent ?? '';
    expect(t).toContain('¥120.00');
    expect(t).toContain(' · YTD (9 months)');
    expect(t).toContain(' · from EDINET');
    expect(t.indexOf('YTD')).toBeLessThan(t.indexOf('EDINET'));
  });
  test('basic level without expected move shows — (no options data)', () => {
    render(<p data-testid="e"><ExpectedMoveLine em={null} level="basic" /></p>);
    expect(screen.getByTestId('e').textContent).toBe('— (no options data)');
    render(<p data-testid="e2"><ExpectedMoveLine em={null} level="full" /></p>);
    expect(screen.getByTestId('e2').textContent).toBe('—');
  });
});
