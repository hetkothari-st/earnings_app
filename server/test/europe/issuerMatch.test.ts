import { describe, expect, it } from 'vitest';
import { createIssuerIndex, normaliseIssuer } from '../../src/europe/sources/issuerMatch.js';

const entries = [
  { symbol: 'SHEL.L', isin: 'GB00BP6MXD84', name: 'Shell plc' },
  { symbol: 'PSON.L', isin: 'GB0006776081', name: 'Pearson PLC' },
  { symbol: 'NANO.PA', isin: 'FR0011341205', name: 'Nanobiotix S.A.' },
  { symbol: 'SOBI.ST', isin: 'SE0000872095', name: 'Swedish Orphan Biovitrum AB (publ)' },
];

describe('issuer matching', () => {
  it('"Shell plc" and "SHELL PLC." normalise equal', () => {
    expect(normaliseIssuer('Shell plc')).toBe('shell');
    expect(normaliseIssuer('SHELL PLC.')).toBe('shell');
    expect(normaliseIssuer('Shell p.l.c.')).toBe('shell');
    expect(normaliseIssuer('The Berkeley Group Holdings plc')).toBe('berkeley');
    expect(normaliseIssuer('Société Générale S.A.')).toBe('societe generale');
    expect(normaliseIssuer('Novo Nordisk A/S')).toBe('novo nordisk');
    expect(normaliseIssuer('Swedish Orphan Biovitrum AB (publ)')).toBe('swedish orphan biovitrum');
    expect(normaliseIssuer('Henkel AG & Co. KGaA')).toBe('henkel');
    expect(normaliseIssuer('Nokia Oyj')).toBe('nokia');
    expect(normaliseIssuer('Equinor ASA')).toBe('equinor');
    expect(normaliseIssuer('Koninklijke Philips N.V.')).toBe('koninklijke philips');
    expect(normaliseIssuer('Intesa Sanpaolo S.p.A.')).toBe('intesa sanpaolo');
    expect(normaliseIssuer('Ørsted A/S')).toBe('orsted');
    // A name made only of a legal form keeps its last word rather than becoming empty.
    expect(normaliseIssuer('Group')).toBe('group');
  });

  it('"Shell Midstream Partners" does not match Shell plc', () => {
    const idx = createIssuerIndex(entries);
    expect(idx.byName('Shell Midstream Partners')).toEqual([]);
    expect(idx.byName('SHELL PLC.')).toEqual(['SHEL.L']);
    expect(idx.byName('Pearson')).toEqual(['PSON.L']);
    expect(idx.byName('Swedish Orphan Biovitrum AB')).toEqual(['SOBI.ST']);
    expect(idx.byName('')).toEqual([]);
  });

  it('two companies with one normalised name → byName returns both', () => {
    // One index over both markets: a PRN item shared by the UK and EU feeds can hit one company at most.
    const idx = createIssuerIndex([
      ...entries,
      { symbol: 'ACME.L', isin: 'GB0000000001', name: 'Acme Group plc' },
      { symbol: 'ACME.DE', isin: 'DE0000000002', name: 'ACME AG' },
    ]);
    expect(idx.byName('Acme').sort()).toEqual(['ACME.DE', 'ACME.L']);
  });

  it('ISIN in text found', () => {
    const idx = createIssuerIndex(entries);
    expect(idx.byIsinIn('Nanobiotix (Euronext: NANO – ISIN FR0011341205), a biotech...')).toEqual(['NANO.PA']);
    expect(idx.byIsinIn('ISINs GB0006776081 and GB00BP6MXD84; again GB0006776081')).toEqual(['PSON.L', 'SHEL.L']);
    // Unknown ISINs and ISIN-like runs inside longer tokens are ignored.
    expect(idx.byIsinIn('US0378331005 XFR0011341205X')).toEqual([]);
  });
});
