import { describe, expect, it } from 'vitest';
import {
  parseInvestingEps,
  parseInvestingRevenue,
  parseInvestingSurprise,
  parseInvestingTiming
} from '../../src/sources/investingParser.js';

describe('investingParser', () => {
  it('parses EPS actual and estimate strings', () => {
    expect(parseInvestingEps('4.60\n/')).toBe(4.6);
    expect(parseInvestingEps('4.42')).toBe(4.42);
    expect(parseInvestingEps('-0.15\n/')).toBe(-0.15);
    expect(parseInvestingEps('-\n/')).toBeNull();
    expect(parseInvestingEps('-')).toBeNull();
    expect(parseInvestingEps('aa.aa')).toBeNull();
    expect(parseInvestingEps(null)).toBeNull();
  });

  it('parses Revenue strings with multipliers', () => {
    expect(parseInvestingRevenue('46.72B\n/')).toBe(46_720_000_000);
    expect(parseInvestingRevenue('7.2B')).toBe(7_200_000_000);
    expect(parseInvestingRevenue('500.5M')).toBe(500_500_000);
    expect(parseInvestingRevenue('320K')).toBe(320_000);
    expect(parseInvestingRevenue('1.95T')).toBe(1_950_000_000_000);
    expect(parseInvestingRevenue('-\n/')).toBeNull();
    expect(parseInvestingRevenue('-')).toBeNull();
    expect(parseInvestingRevenue(null)).toBeNull();
  });

  it('parses EPS surprise percentage', () => {
    expect(parseInvestingSurprise('+4.07%\n/')).toBe(4.07);
    expect(parseInvestingSurprise('-0.42%')).toBe(-0.42);
    expect(parseInvestingSurprise('0.00%\n/')).toBe(0);
    expect(parseInvestingSurprise('-\n/')).toBeNull();
  });

  it('parses Timing indicators', () => {
    expect(parseInvestingTiming('pre_market')).toBe('BMO');
    expect(parseInvestingTiming('before market')).toBe('BMO');
    expect(parseInvestingTiming('after market')).toBe('AMC');
    expect(parseInvestingTiming('post_market')).toBe('AMC');
    expect(parseInvestingTiming('')).toBe('UNKNOWN');
  });
});
