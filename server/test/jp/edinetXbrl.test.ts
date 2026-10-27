import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { parseEdinetXbrl } from '../../src/jp/sources/edinetXbrl.js';

const fxPath = (n: string) => new URL(`../fixtures/jp/edinet/${n}`, import.meta.url);

interface Expected {
  file: string;
  docTypeCode: '120' | '160';
  periodEnd: string;
  revenue: number | null;
  epsBasic: number | null;
  epsDiluted: number | null;
  ytdMonths: 6 | 12;
  standard: 'jgaap' | 'ifrs' | 'usgaap';
  consolidated: boolean;
}

const expected = (JSON.parse(readFileSync(fxPath('expected.json'), 'utf8')) as { documents: Expected[] }).documents;

// ---- Inline mini-instances (test inputs) ----

const ctx = (id: string, start: string, end: string, member?: string) => `
  <xbrli:context id="${id}">
    <xbrli:entity><xbrli:identifier scheme="http://disclosure.edinet-fsa.go.jp">E99999-000</xbrli:identifier></xbrli:entity>
    <xbrli:period><xbrli:startDate>${start}</xbrli:startDate><xbrli:endDate>${end}</xbrli:endDate></xbrli:period>
    ${member ? `<xbrli:scenario><xbrldi:explicitMember dimension="jppfs_cor:ConsolidatedOrNonConsolidatedAxis">${member}</xbrldi:explicitMember></xbrli:scenario>` : ''}
  </xbrli:context>`;

const UNITS = `
  <xbrli:unit id="JPY"><xbrli:measure>iso4217:JPY</xbrli:measure></xbrli:unit>
  <xbrli:unit id="USD"><xbrli:measure>iso4217:USD</xbrli:measure></xbrli:unit>
  <xbrli:unit id="JPYPerShares"><xbrli:divide><xbrli:unitNumerator><xbrli:measure>iso4217:JPY</xbrli:measure></xbrli:unitNumerator><xbrli:unitDenominator><xbrli:measure>xbrli:shares</xbrli:measure></xbrli:unitDenominator></xbrli:divide></xbrli:unit>`;

function mini(o: { start?: string; end?: string; standard?: string; consolidated?: boolean; body: string; contexts: string }): string {
  const start = o.start ?? '2025-04-01';
  const end = o.end ?? '2026-03-31';
  return `<?xml version="1.0" encoding="UTF-8"?>
<xbrli:xbrl xmlns:xbrli="http://www.xbrl.org/2003/instance" xmlns:xbrldi="http://xbrl.org/2006/xbrldi" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:iso4217="http://www.xbrl.org/2003/iso4217" xmlns:jpdei_cor="x" xmlns:jpcrp_cor="y" xmlns:jppfs_cor="z">
  <xbrli:context id="FilingDateInstant">
    <xbrli:entity><xbrli:identifier scheme="http://disclosure.edinet-fsa.go.jp">E99999-000</xbrli:identifier></xbrli:entity>
    <xbrli:period><xbrli:instant>2026-06-25</xbrli:instant></xbrli:period>
  </xbrli:context>
  ${o.contexts}
  ${UNITS}
  <jpdei_cor:AccountingStandardsDEI contextRef="FilingDateInstant">${o.standard ?? 'Japan GAAP'}</jpdei_cor:AccountingStandardsDEI>
  <jpdei_cor:WhetherConsolidatedFinancialStatementsArePreparedDEI contextRef="FilingDateInstant">${o.consolidated === false ? 'false' : 'true'}</jpdei_cor:WhetherConsolidatedFinancialStatementsArePreparedDEI>
  <jpdei_cor:CurrentFiscalYearStartDateDEI contextRef="FilingDateInstant">${start}</jpdei_cor:CurrentFiscalYearStartDateDEI>
  <jpdei_cor:CurrentPeriodEndDateDEI contextRef="FilingDateInstant">${end}</jpdei_cor:CurrentPeriodEndDateDEI>
  ${o.body}
</xbrli:xbrl>`;
}

const FY = { docTypeCode: '120' as const, periodEnd: '2026-03-31' };

describe('parseEdinetXbrl', () => {
  it('every corpus document matches its hand-read values exactly', () => {
    expect(expected.length).toBeGreaterThanOrEqual(6);
    for (const e of expected) {
      const xml = gunzipSync(readFileSync(fxPath(e.file))).toString('utf8');
      const got = parseEdinetXbrl(xml, { docTypeCode: e.docTypeCode, periodEnd: e.periodEnd });
      const where = `${e.file}: ${JSON.stringify(got)}`;
      expect(got.revenue === e.revenue, `revenue ${where}`).toBe(true);
      expect(got.epsBasic === e.epsBasic, `epsBasic ${where}`).toBe(true);
      expect(got.epsDiluted === e.epsDiluted, `epsDiluted ${where}`).toBe(true);
      expect(got.ytdMonths === e.ytdMonths, `ytdMonths ${where}`).toBe(true);
      expect(got.standard === e.standard, `standard ${where}`).toBe(true);
      expect(got.consolidated === e.consolidated, `consolidated ${where}`).toBe(true);
      expect(got.currency === 'JPY', `currency ${where}`).toBe(true);
    }
  });

  it('bank: ordinary income never revenue', () => {
    const xml = mini({
      contexts: ctx('CurrentYearDuration', '2025-04-01', '2026-03-31'),
      body: `
        <jpcrp_cor:OrdinaryIncomeSummaryOfBusinessResults contextRef="CurrentYearDuration" unitRef="JPY" decimals="-6">14620843000000</jpcrp_cor:OrdinaryIncomeSummaryOfBusinessResults>
        <jppfs_cor:OrdinaryIncome contextRef="CurrentYearDuration" unitRef="JPY" decimals="-6">3410192000000</jppfs_cor:OrdinaryIncome>
        <jppfs_cor:OrdinaryIncomeBNK contextRef="CurrentYearDuration" unitRef="JPY" decimals="-6">14620843000000</jppfs_cor:OrdinaryIncomeBNK>
        <jpcrp_cor:BasicEarningsLossPerShareSummaryOfBusinessResults contextRef="CurrentYearDuration" unitRef="JPYPerShares" decimals="2">213.16</jpcrp_cor:BasicEarningsLossPerShareSummaryOfBusinessResults>`,
    });
    const got = parseEdinetXbrl(xml, FY);
    expect(got.revenue).toBeNull();
    expect(got.epsBasic).toBe(213.16);
    expect(got.ytdMonths).toBe(12);
  });

  it('context chosen by period, not id', () => {
    const xml = mini({
      contexts:
        ctx('Foo', '2025-04-01', '2026-03-31') +
        // Right dates but a dimension member: never read.
        ctx('CurrentYearDuration', '2025-04-01', '2026-03-31', 'jppfs_cor:NonConsolidatedMember') +
        // Prior year: never read.
        ctx('Bar', '2024-04-01', '2025-03-31'),
      body: `
        <jppfs_cor:NetSales contextRef="CurrentYearDuration" unitRef="JPY" decimals="-6">999000000</jppfs_cor:NetSales>
        <jppfs_cor:NetSales contextRef="Bar" unitRef="JPY" decimals="-6">888000000</jppfs_cor:NetSales>
        <jppfs_cor:NetSales contextRef="Foo" unitRef="JPY" decimals="-6">1234000000</jppfs_cor:NetSales>
        <jpcrp_cor:NetSalesSummaryOfBusinessResults contextRef="Foo" unitRef="JPY" decimals="-6">1234000000</jpcrp_cor:NetSalesSummaryOfBusinessResults>
        <jppfs_cor:BasicEarningsLossPerShare contextRef="CurrentYearDuration" unitRef="JPYPerShares" decimals="2">1.00</jppfs_cor:BasicEarningsLossPerShare>
        <jppfs_cor:BasicEarningsLossPerShare contextRef="Foo" unitRef="JPYPerShares" decimals="2">12.34</jppfs_cor:BasicEarningsLossPerShare>`,
    });
    const got = parseEdinetXbrl(xml, FY);
    expect(got.revenue).toBe(1234000000);
    expect(got.epsBasic).toBe(12.34);
    expect(got.consolidated).toBe(true);

    // Without the plain context, the member context alone gives blank.
    const memberOnly = mini({
      contexts: ctx('CurrentYearDuration', '2025-04-01', '2026-03-31', 'jppfs_cor:NonConsolidatedMember'),
      body: `<jppfs_cor:NetSales contextRef="CurrentYearDuration" unitRef="JPY" decimals="-6">999000000</jppfs_cor:NetSales>`,
    });
    expect(parseEdinetXbrl(memberOnly, FY).revenue).toBeNull();
  });

  it('non-consolidated variant only when no consolidated statements are prepared', () => {
    const contexts = ctx('A', '2025-04-01', '2026-03-31', 'jppfs_cor:NonConsolidatedMember');
    const body = `<jppfs_cor:NetSales contextRef="A" unitRef="JPY" decimals="-6">47058000000</jppfs_cor:NetSales>`;
    const non = parseEdinetXbrl(mini({ consolidated: false, contexts, body }), FY);
    expect(non.revenue).toBe(47058000000);
    expect(non.consolidated).toBe(false);
    expect(parseEdinetXbrl(mini({ consolidated: true, contexts, body }), FY).revenue).toBeNull();
  });

  it('non-JPY unit → blank', () => {
    const xml = mini({
      contexts: ctx('C', '2025-04-01', '2026-03-31'),
      body: `
        <jppfs_cor:NetSales contextRef="C" unitRef="USD" decimals="-6">5000000</jppfs_cor:NetSales>
        <jppfs_cor:BasicEarningsLossPerShare contextRef="C" unitRef="JPY" decimals="2">12.34</jppfs_cor:BasicEarningsLossPerShare>`,
    });
    const got = parseEdinetXbrl(xml, FY);
    expect(got.revenue).toBeNull();
    // An EPS in a plain JPY unit (not per share) is blank too.
    expect(got.epsBasic).toBeNull();
  });

  it('elements for one field that disagree → blank', () => {
    const xml = mini({
      contexts: ctx('C', '2025-04-01', '2026-03-31'),
      body: `
        <jppfs_cor:NetSales contextRef="C" unitRef="JPY" decimals="-6">1000000</jppfs_cor:NetSales>
        <jpcrp_cor:NetSalesSummaryOfBusinessResults contextRef="C" unitRef="JPY" decimals="-6">2000000</jpcrp_cor:NetSalesSummaryOfBusinessResults>
        <jppfs_cor:BasicEarningsLossPerShare contextRef="C" unitRef="JPYPerShares" decimals="2">5.5</jppfs_cor:BasicEarningsLossPerShare>
        <jpcrp_cor:BasicEarningsLossPerShareSummaryOfBusinessResults contextRef="C" unitRef="JPYPerShares" decimals="2">5.50</jpcrp_cor:BasicEarningsLossPerShareSummaryOfBusinessResults>`,
    });
    const got = parseEdinetXbrl(xml, FY);
    expect(got.revenue).toBeNull();
    expect(got.epsBasic).toBe(5.5);
  });

  it('half-year document whose context spans 3 months → all blank', () => {
    const xml = mini({
      start: '2025-07-01',
      end: '2025-09-30',
      contexts: ctx('InterimDuration', '2025-07-01', '2025-09-30'),
      body: `
        <jppfs_cor:NetSales contextRef="InterimDuration" unitRef="JPY" decimals="-6">1000000</jppfs_cor:NetSales>
        <jppfs_cor:BasicEarningsLossPerShare contextRef="InterimDuration" unitRef="JPYPerShares" decimals="2">5.5</jppfs_cor:BasicEarningsLossPerShare>`,
    });
    const got = parseEdinetXbrl(xml, { docTypeCode: '160', periodEnd: '2025-09-30' });
    expect(got).toMatchObject({ revenue: null, epsBasic: null, epsDiluted: null, ytdMonths: null });

    // A 有報 whose context is 6 months is blank too.
    const six = mini({
      start: '2025-10-01',
      end: '2026-03-31',
      contexts: ctx('C', '2025-10-01', '2026-03-31'),
      body: `<jppfs_cor:NetSales contextRef="C" unitRef="JPY" decimals="-6">1000000</jppfs_cor:NetSales>`,
    });
    expect(parseEdinetXbrl(six, FY)).toMatchObject({ revenue: null, ytdMonths: null });
  });

  it('nil fact → blank', () => {
    const xml = mini({
      contexts: ctx('C', '2025-04-01', '2026-03-31'),
      body: `
        <jppfs_cor:NetSales contextRef="C" unitRef="JPY" decimals="-6" xsi:nil="true"/>
        <jppfs_cor:BasicEarningsLossPerShare contextRef="C" unitRef="JPYPerShares" decimals="2">7.25</jppfs_cor:BasicEarningsLossPerShare>
        <jppfs_cor:DilutedEarningsPerShare contextRef="C" unitRef="JPYPerShares" xsi:nil="true"></jppfs_cor:DilutedEarningsPerShare>`,
    });
    const got = parseEdinetXbrl(xml, FY);
    expect(got.revenue).toBeNull();
    expect(got.epsBasic).toBe(7.25);
    expect(got.epsDiluted).toBeNull();
  });

  it('unknown accounting standard → all blank', () => {
    const xml = mini({
      standard: 'Something Else',
      contexts: ctx('C', '2025-04-01', '2026-03-31'),
      body: `<jppfs_cor:NetSales contextRef="C" unitRef="JPY" decimals="-6">1000000</jppfs_cor:NetSales>`,
    });
    expect(parseEdinetXbrl(xml, FY)).toMatchObject({ revenue: null, epsBasic: null, standard: null });
  });
});
