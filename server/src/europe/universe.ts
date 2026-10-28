/**
 * UK and Europe full-level lists. A full-level name is a US-listed issuer (SEC 6-K or 8-K filer) with a Cboe option
 * chain and a primary line on a target exchange; it gets SEC results, the reader (gated) and an ADR expected move.
 * Everyone else is basic level through the universe build. The rows are hand-kept and live-verified by
 * `npm run verify-europe-universe -w server -- --market uk|eu` (SEC company_tickers.json, forms, Cboe chain, the
 * ratio sentence of the latest 20-F or F-6, the price cross-check, and Yahoo's ISIN search for the local line).
 *
 * Dropped (no primary line on a target exchange; controller ruling, not added): ARM, SPOT, NXPI, BNTX, CHKP, CRH.
 */

/** Matches `EuropeMarket` in europe/exchanges.ts (Task 1); kept local so this file stands alone. */
type EuropeMarket = 'UK' | 'EU';

export interface EuropeFullEntry {
  market: EuropeMarket;
  /** Yahoo symbol of the local primary line, e.g. 'HSBA.L'. */
  symbol: string;
  isin: string;
  /** US ticker (ADS, NY registry share or ordinary share). */
  adr: string;
  /** Local shares per US share (may be fractional). Display only. */
  adrRatio: number;
  /**
   * Shown only when true: the ratio was read from the SEC filing (20-F or F-6, or 1 for an ordinary/registry share
   * of a 10-K filer) and the price-implied ratio agrees within 15%. Recorded by hand from the CLI output.
   */
  adrRatioVerified: boolean;
  cik: number;
  /** How results reach SEC: 6-K (foreign private issuer) or 8-K Item 2.02 (domestic filer). */
  secForm: '6-K' | '8-K';
  /** English name variants as the issuer's releases print them (the reader allows only these in group headings). */
  names: readonly string[];
}

const uk = (symbol: string, isin: string, adr: string, adrRatio: number, adrRatioVerified: boolean, cik: number, names: string[], secForm: '6-K' | '8-K' = '6-K'): EuropeFullEntry =>
  ({ market: 'UK', symbol, isin, adr, adrRatio, adrRatioVerified, cik, secForm, names });
const eu = (symbol: string, isin: string, adr: string, adrRatio: number, adrRatioVerified: boolean, cik: number, names: string[], secForm: '6-K' | '8-K' = '6-K'): EuropeFullEntry =>
  ({ market: 'EU', symbol, isin, adr, adrRatio, adrRatioVerified, cik, secForm, names });

/** Live-verified by `npm run verify-europe-universe -w server -- --market uk`. */
export const UK_FULL: readonly EuropeFullEntry[] = [
  uk('AZN.L', 'GB0009895292', 'AZN', 1, true, 901832, ['AstraZeneca PLC']),
  uk('SHEL.L', 'GB00BP6MXD84', 'SHEL', 2, true, 1306965, ['Shell plc']),
  uk('BP.L', 'GB0007980591', 'BP', 6, true, 313807, ['BP p.l.c.']),
  uk('HSBA.L', 'GB0005405286', 'HSBC', 5, true, 1089113, ['HSBC Holdings plc']),
  uk('ULVR.L', 'GB00BVZK7T90', 'UL', 1, true, 217410, ['Unilever PLC']),
  uk('GSK.L', 'GB00BN7SWP63', 'GSK', 2, true, 1131399, ['GSK plc']),
  uk('DGE.L', 'GB0002374006', 'DEO', 4, true, 835403, ['Diageo plc']),
  uk('VOD.L', 'GB00BH4HKS39', 'VOD', 10, true, 839923, ['Vodafone Group Plc']),
  uk('RIO.L', 'GB0007188757', 'RIO', 1, true, 863064, ['Rio Tinto plc']),
  uk('BHP.L', 'AU000000BHP4', 'BHP', 2, true, 811809, ['BHP Group Limited']),
  uk('BATS.L', 'GB0002875804', 'BTI', 1, true, 1303523, ['British American Tobacco p.l.c.']),
  uk('NG.L', 'GB00BDR05C01', 'NGG', 5, true, 1004315, ['National Grid plc']),
  uk('BARC.L', 'GB0031348658', 'BCS', 4, true, 312069, ['Barclays PLC']),
  uk('LLOY.L', 'GB0008706128', 'LYG', 4, true, 1160106, ['Lloyds Banking Group plc']),
  uk('NWG.L', 'GB00BM8PJY71', 'NWG', 2, true, 844150, ['NatWest Group plc']),
  uk('REL.L', 'GB00B2B0DG97', 'RELX', 1, true, 929869, ['RELX PLC']),
  uk('PRU.L', 'GB0007099541', 'PUK', 2, true, 1116578, ['Prudential plc']),
  uk('SN.L', 'GB0009223206', 'SNN', 2, true, 845982, ['Smith & Nephew plc']),
  uk('HLN.L', 'GB00BMX86B70', 'HLN', 2, true, 1900304, ['Haleon plc']),
  uk('WPP.L', 'JE00B8KF9B49', 'WPP', 5, true, 806968, ['WPP plc']),
  uk('CCEP.L', 'GB00BDCPN049', 'CCEP', 1, true, 1650107, ['Coca-Cola Europacific Partners PLC']),
];

/** Live-verified by `npm run verify-europe-universe -w server -- --market eu`. */
export const EU_FULL: readonly EuropeFullEntry[] = [
  eu('ASML.AS', 'NL0010273215', 'ASML', 1, true, 937966, ['ASML Holding N.V.']),
  eu('SAP.DE', 'DE0007164600', 'SAP', 1, true, 1000184, ['SAP SE']),
  eu('NOVO-B.CO', 'DK0062498333', 'NVO', 1, true, 353278, ['Novo Nordisk A/S']),
  eu('TTE.PA', 'FR0000120271', 'TTE', 1, true, 879764, ['TotalEnergies SE']),
  eu('SAN.PA', 'FR0000120578', 'SNY', 0.5, true, 1121404, ['Sanofi']),
  eu('NOVN.SW', 'CH0012005267', 'NVS', 1, true, 1114448, ['Novartis AG']),
  eu('UBSG.SW', 'CH0244767585', 'UBS', 1, true, 1610520, ['UBS Group AG']),
  eu('INGA.AS', 'NL0011821202', 'ING', 1, true, 1039765, ['ING Groep N.V.']),
  eu('PHIA.AS', 'NL0000009538', 'PHG', 1, true, 313216, ['Koninklijke Philips N.V.']),
  eu('ERIC-B.ST', 'SE0000108656', 'ERIC', 1, true, 717826, ['Telefonaktiebolaget LM Ericsson']),
  eu('NOKIA.HE', 'FI0009000681', 'NOK', 1, true, 924613, ['Nokia Corporation']),
  eu('EQNR.OL', 'NO0010096985', 'EQNR', 1, true, 1140625, ['Equinor ASA']),
  eu('STLAM.MI', 'NL00150001Q9', 'STLA', 1, true, 1605484, ['Stellantis N.V.']),
  eu('SAN.MC', 'ES0113900J37', 'SAN', 1, true, 891478, ['Banco Santander, S.A.']),
  eu('BBVA.MC', 'ES0113211835', 'BBVA', 1, true, 842180, ['Banco Bilbao Vizcaya Argentaria, S.A.']),
  eu('ABI.BR', 'BE0974293251', 'BUD', 1, true, 1668717, ['Anheuser-Busch InBev SA/NV']),
  eu('STMPA.PA', 'NL0000226223', 'STM', 1, true, 932787, ['STMicroelectronics N.V.']),
  eu('DBK.DE', 'DE0005140008', 'DB', 1, true, 1159508, ['Deutsche Bank AG']),
  eu('AGN.AS', 'BMG0112X1056', 'AEG', 1, true, 769218, ['Aegon Ltd.']),
  eu('ARGX.BR', 'NL0010832176', 'ARGX', 1, true, 1697862, ['argenx SE']),
  eu('LOGN.SW', 'CH0025751329', 'LOGI', 1, true, 1032975, ['Logitech International S.A.'], '8-K'),
];

const listOf = (market: EuropeMarket): readonly EuropeFullEntry[] => (market === 'UK' ? UK_FULL : EU_FULL);

export function europeFullFor(market: EuropeMarket, symbol: string): EuropeFullEntry | undefined {
  return listOf(market).find((e) => e.symbol === symbol);
}

/** The reader's issuer identity for a full-level name (by local symbol or US ticker): its names and US ticker. */
export function europeIssuerFor(adrOrSymbol: string): { names: readonly string[]; ticker: string } | undefined {
  const e = [...UK_FULL, ...EU_FULL].find((f) => f.adr === adrOrSymbol || f.symbol === adrOrSymbol);
  return e ? { names: e.names, ticker: e.adr } : undefined;
}

export const europeLevel = (e: { cik: number | null; adr: string | null }): 'full' | 'basic' =>
  (e.cik != null && e.adr != null ? 'full' : 'basic');

/** The ADR ratio as served (display only): the ratio when verified, else null. */
export function europeAdrRatioShown(e: { adrRatio: number | null; adrRatioVerified: boolean }): number | null {
  return e.adrRatio != null && e.adrRatioVerified ? e.adrRatio : null;
}
