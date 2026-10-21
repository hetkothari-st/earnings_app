import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { describe, it, expect } from 'vitest';
import { parsePriorIntimation, parseIntegratedFiling } from '../../src/india/sources/xbrl.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/india');
const fixture = (name: string) => readFileSync(join(FIXTURES, name), 'utf-8');

describe('parsePriorIntimation', () => {
  it('extracts symbol and meeting date from GAIL prior intimation', () => {
    const xml = fixture('xbrl_prior_intimation_GAIL.xml');
    const pi = parsePriorIntimation(xml);
    expect(pi.symbol).toBeTruthy();
    expect(pi.meetingDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    if (pi.quarterEnd) expect(pi.quarterEnd).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    if (pi.quarterLabel) expect(pi.quarterLabel).toMatch(/^[A-Z][a-z]{2}\/\d{4}$/);
  });

  it('returns purposes from agenda fields', () => {
    const xml = fixture('xbrl_prior_intimation_GAIL.xml');
    const pi = parsePriorIntimation(xml);
    expect(pi.purposes.length).toBeGreaterThan(0);
  });

  it('throws SourceFormatError on non-XBRL input', () => {
    expect(() => parsePriorIntimation('<html><body>Error 503</body></html>')).toThrow('Not a valid XBRL document');
  });
});

describe('parseIntegratedFiling - Ind AS (TATACOMM consolidated)', () => {
  it('extracts symbol, report date, financials', () => {
    const xml = fixture('xbrl_indas_TATACOMM_Q2FY27_consolidated.xml');
    const f = parseIntegratedFiling(xml);
    expect(f.symbol).toBe('TATACOMM');
    expect(f.reportDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(f.nature).toBe('Consolidated');
    expect(f.isBank).toBe(false);
    expect(f.revenueKind).toBe('revenue-from-ops');
  });

  it('extracts P&L and EPS', () => {
    const xml = fixture('xbrl_indas_TATACOMM_Q2FY27_consolidated.xml');
    const f = parseIntegratedFiling(xml);
    // These may be null if absent in the fixture, but the fields must exist
    expect('profitLoss' in f).toBe(true);
    expect('eps' in f).toBe(true);
  });
});

describe('parseIntegratedFiling - Banking (UCOBANK standalone)', () => {
  it('detects banking variant', () => {
    const xml = fixture('xbrl_banking_UCOBANK_Q2FY27_standalone.xml');
    const f = parseIntegratedFiling(xml);
    expect(f.isBank).toBe(true);
    expect(f.revenueKind).toBe('total-income');
  });

  it('an NBFC (interest earned, but revenue from operations) is not a bank', () => {
    const f = parseIntegratedFiling(fixture('xbrl_nbfc_IRFC_Q2FY27_standalone.xml'));
    expect(f).toMatchObject({ symbol: 'IRFC', isBank: false, revenueKind: 'revenue-from-ops', revenueFromOperations: 78_664_100_000 });
  });

  it('throws SourceFormatError on non-XBRL', () => {
    expect(() => parseIntegratedFiling('<html>not xml</html>')).toThrow();
  });
});

describe('Consolidated wins over standalone (Review Focus #1)', () => {
  it('standalone and consolidated parse independently', () => {
    const consol = parseIntegratedFiling(fixture('xbrl_indas_TATACOMM_Q2FY27_consolidated.xml'));
    const stand = parseIntegratedFiling(fixture('xbrl_indas_TATACOMM_Q2FY27_standalone.xml'));
    // Both should have the same symbol
    expect(consol.symbol).toBe(stand.symbol);
    // Nature distinguishes them
    expect(consol.nature).toBe('Consolidated');
    expect(stand.nature).toBe('Standalone');
  });
});

describe('parseIntegratedFiling exact figures (quarter only, never year to date)', () => {
  const read = (f: string) => readFileSync(new URL(`../fixtures/india/${f}`, import.meta.url), 'utf8');

  it('TATACOMM consolidated Q2 FY27', () => {
    const f = parseIntegratedFiling(read('xbrl_indas_TATACOMM_Q2FY27_consolidated.xml'));
    expect(f).toMatchObject({
      symbol: 'TATACOMM', reportDate: '2026-10-15', periodStart: '2026-07-01', periodEnd: '2026-09-30',
      nature: 'Consolidated', revenueFromOperations: 66_878_900_000, profitLoss: 3_356_100_000, eps: 11.96,
      isBank: false, totalIncome: 67_043_000_000,
    });
  });

  it('UCO Bank: banking tags, total income as revenue', () => {
    const f = parseIntegratedFiling(read('xbrl_banking_UCOBANK_Q2FY27_standalone.xml'));
    expect(f).toMatchObject({
      symbol: 'UCOBANK', companyName: 'UCO Bank', periodEnd: '2026-09-30', nature: 'Standalone',
      isBank: true, revenueKind: 'total-income', interestEarned: 72_863_200_000, totalIncome: 81_740_800_000,
      profitLoss: 7_856_400_000, eps: 0.63, revenueFromOperations: null,
    });
  });

  it('a quarter figure missing from OneD stays null instead of taking the year-to-date value', () => {
    const xml = read('xbrl_indas_TATACOMM_Q2FY27_consolidated.xml')
      .replace(/<in-capmkt:RevenueFromOperations contextRef="OneD"[^<]*<\/in-capmkt:RevenueFromOperations>/, '');
    expect(parseIntegratedFiling(xml).revenueFromOperations).toBeNull();
  });
});

describe('parsePriorIntimation month names', () => {
  it('GAIL: "September" 2026 → quarter end 2026-09-30', () => {
    const pi = parsePriorIntimation(readFileSync(new URL('../fixtures/india/xbrl_prior_intimation_GAIL.xml', import.meta.url), 'utf8'));
    expect(pi).toMatchObject({ symbol: 'GAIL', meetingDate: '2026-10-30', quarterEnd: '2026-09-30', quarterLabel: 'Sep/2026' });
  });
});

describe('quarter label', () => {
  it('Sep/2026 from the period end (not "Sep/9")', () => {
    const f = parseIntegratedFiling(readFileSync(new URL('../fixtures/india/xbrl_indas_TATACOMM_Q2FY27_consolidated.xml', import.meta.url), 'utf8'));
    expect(f.quarterLabel).toBe('Sep/2026');
  });
});
