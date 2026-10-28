/**
 * UK and Europe exchange table (Ruling 3) and the universe sources, as verified live on 2026-10-28.
 *
 * FIRDS (Ruling 4):
 * - ESMA index (registers.esma.europa.eu solr) lists the weekly equity full set as FULINS_E_20261024_01of02.zip and
 *   _02of02.zip on firds.esma.europa.eu: 8.28 MB + 3.89 MB zipped, 365.5 MB + 199.7 MB unzipped (748,848 records,
 *   compact one-line XML). The FCA index (api.data.fca.org.uk) lists FULINS_E_20261024_01of01.zip on data.fca.org.uk:
 *   41.9 MB zipped, 897.3 MB unzipped (848,436 records, pretty-printed XML). Both well under the 2 GB substitute
 *   threshold, so FIRDS is used for every market but SIX. The XML must be streamed record by record (Task 8): one
 *   FCA part is ~0.9 GB of text. The FCA set also carries EU venues; UK MICs are read from it, EU MICs from ESMA.
 * - Every <RefData> holds exactly one <TradgVnRltdAttrbts> (0 of 1.6 M records had two). A share on two venues is two
 *   records with the same ISIN (fixture: Hammerson GB00BRJQ8J25 on XLON and XMSM). Names can carry U+FFFD where an
 *   umlaut was lost (`M�ller - Die lila Logistik`), so GLEIF names come first.
 * - The Xetra venue id is the segment MIC XETA (regulated) / XETS (Scale); XETR never appears as a venue.
 * - Active shares (CFI ES*, IssrReq true, no past TermntnDt) per chosen MIC after primary-line selection
 *   (country tie-break, UK first): XLON 830, AIMX 595 → UK 1,425. XPAR 301, ALXP 250, XAMS 103, XBRU 104, ALXB 7,
 *   XLIS 30, ALXL 1, XMSM 15, XESM 8, MTAA 192, EXGM 204, XOSL 146, XOAS 5, MERK 70, XETA 299, XETS 51, XSTO 394,
 *   SSME 317, XCSE 115, DSME 27, XHEL 145, FSME 46, XMAD 118, GROW 110 → EU 3,054 (+ SIX). 12 ISINs left out as
 *   ambiguous. Below the spec's ≈1,800 / ≈5,000 estimates: these are the counts FIRDS gives for the 14 exchanges.
 * - Left out on purpose: segment duplicates that carry the same ISINs (XETU = XETA, FRAA/FRAU ⊇ XETA, MSTO/DSTO ⊂ XSTO,
 *   MNSE/DNSE = SSME, MHEL/DHEL, MCSE/DCSE, DMAD ⊂ XMAD, XLOX ⊂ XLON ∪ AIMX), access/MTF markets that are not the
 *   exchange's own growth segment (XMLI, MLXB, ENXL, XSAT Spotlight, NSME, SCLE BME Scaleup, POSE). No Euronext Growth
 *   Amsterdam MIC carries an issuer-requested share. Within each exchange the chosen MICs share no ISIN.
 * SIX (Switzerland is outside FIRDS): the Share Explorer CSV at www.six-group.com/fqs/ref.csv (robots allows /fqs),
 *   ISO-8859-1 (ASCII in practice), `;`-separated, 813 rows. Drop `SIX Sponsored Segment` (549 foreign lines) and
 *   `Standard for Derivatives` (rights), and the `2. LINIE` buy-back lines → 242 rows, 207 with a CH/LI ISIN. Names
 *   are short and upper-case (`NOVARTIS N`). ValorSymbol + `.SW` is the Yahoo symbol (NOVN.SW verified).
 * GLEIF: one GET with filter[lei]=200 comma-separated LEIs and page[size]=200 returned all 200 (595 KB, 1.6 s). No
 *   rate-limit headers are sent; keep the documented 60 req/min.
 * OpenFIGI (keyless): `ratelimit-policy: 25;w=60` (25 requests per 60 s), 10 jobs per request. An unknown ISIN gives
 *   `{ warning: 'No identifier found.' }`; a bad check digit gives `{ error: 'Invalid idValue format.' }`. One ISIN can
 *   have two tickers on one exchange (Eiffage FR0000130452 on FP: FGR, FGRMC) → left out unless search settles it.
 *   Growth segments have their own exchCode: SSME → SF, FSME → FF, DSME → DF (asking SS/FH/DC for them gives a warning).
 * Ticker shapes (OpenFIGI → Yahoo, checked by Yahoo ISIN search on 181 sampled ISINs):
 *   LSE `BT/A` → BT-A.L but `BA/`, `RR/`, `BP/`, `YU/` → BA.L, RR.L, BP.L, YU.L: a trailing `/` is dropped, an inner
 *   `/` becomes `-` (58/58 matched with that rule). STO `ERICB`/`HOLMB`/`INDUC`/`CNCJOB` → ERIC-B, HOLM-B, INDU-C,
 *   CNCJO-B (10 of 17 differ from the plain ticker) and CPH `NOVOB`/`ALKB`/`GYLDB` → NOVO-B, ALK-B, GYLD-B: not
 *   deterministic (`CLAV`, `NORTHM` have no class letter), so `search`. HEL keeps the class letter (`KNEBV.HE`,
 *   `ACG1V.HE`): exact. Every other exchange matched exactly. Yahoo search returns nothing for some valid ISINs
 *   (Kone FI0009013403), so `search` exchanges lose those names (Ruling 5).
 * Yahoo ISIN search: a crumb-less GET with BROWSER_UA on query2 works (`quotes[].symbol`, `exchange`).
 */

export type EuropeMarket = 'UK' | 'EU';

export type ExchangeId = 'LSE' | 'PAR' | 'AMS' | 'BRU' | 'LIS' | 'DUB' | 'MIL' | 'OSL' | 'XET' | 'SIX' | 'STO' | 'CPH' | 'HEL' | 'MAD';

export interface ExchangeInfo {
  id: ExchangeId;
  market: EuropeMarket;
  name: string;
  /** ISO 3166 alpha-2, compared with an ISIN's first two letters for the primary-line tie-break. */
  country: string;
  zone: string;
  suffix: string;
  /** FIRDS venue MICs read for the universe (regulated market + the exchange's own growth segment). */
  mics: readonly string[];
  /** OpenFIGI exchCode of the main market (the first MIC's code). */
  figiExchCode: string;
  /** OpenFIGI exchCode for each MIC in `mics`: growth segments can have their own (SSME → SF). */
  micExchCodes: Readonly<Record<string, string>>;
  /** Listing currency as Yahoo quotes it (`GBp` = pence). */
  currency: string;
  /** Session open and close, minutes after local midnight. */
  openMin: number;
  closeMin: number;
  universeSource: 'fca-firds' | 'esma-firds' | 'six-list';
  /** `exact`: the transform alone gives the Yahoo symbol. `search`: candidates are checked by Yahoo ISIN search. */
  tickerTransform: 'exact' | 'search';
  /** Yahoo screener region code. */
  yahooRegion: string;
}

const H = (h: number, m = 0) => h * 60 + m;

type Row = Omit<ExchangeInfo, 'figiExchCode' | 'mics'> & { figiExchCode?: string };
/** `mics` are the keys of `micExchCodes`; `figiExchCode` is the first MIC's code unless given (SIX has no FIRDS MIC). */
const row = (r: Row): ExchangeInfo => {
  const mics = Object.keys(r.micExchCodes);
  return { ...r, mics, figiExchCode: r.figiExchCode ?? r.micExchCodes[mics[0]!]! };
};

const EURONEXT_CORE = { openMin: H(9), closeMin: H(17, 30) } as const;

export const EXCHANGES: Readonly<Record<ExchangeId, ExchangeInfo>> = {
  LSE: row({ id: 'LSE', market: 'UK', name: 'London Stock Exchange (Main Market + AIM)', country: 'GB', zone: 'Europe/London', suffix: '.L', micExchCodes: { XLON: 'LN', AIMX: 'LN' }, currency: 'GBp', openMin: H(8), closeMin: H(16, 30), universeSource: 'fca-firds', tickerTransform: 'exact', yahooRegion: 'gb' }),
  PAR: row({ id: 'PAR', market: 'EU', name: 'Euronext Paris', country: 'FR', zone: 'Europe/Paris', suffix: '.PA', micExchCodes: { XPAR: 'FP', ALXP: 'FP' }, currency: 'EUR', ...EURONEXT_CORE, universeSource: 'esma-firds', tickerTransform: 'exact', yahooRegion: 'fr' }),
  AMS: row({ id: 'AMS', market: 'EU', name: 'Euronext Amsterdam', country: 'NL', zone: 'Europe/Amsterdam', suffix: '.AS', micExchCodes: { XAMS: 'NA' }, currency: 'EUR', ...EURONEXT_CORE, universeSource: 'esma-firds', tickerTransform: 'exact', yahooRegion: 'nl' }),
  BRU: row({ id: 'BRU', market: 'EU', name: 'Euronext Brussels', country: 'BE', zone: 'Europe/Brussels', suffix: '.BR', micExchCodes: { XBRU: 'BB', ALXB: 'BB' }, currency: 'EUR', ...EURONEXT_CORE, universeSource: 'esma-firds', tickerTransform: 'exact', yahooRegion: 'be' }),
  LIS: row({ id: 'LIS', market: 'EU', name: 'Euronext Lisbon', country: 'PT', zone: 'Europe/Lisbon', suffix: '.LS', micExchCodes: { XLIS: 'PL', ALXL: 'PL' }, currency: 'EUR', openMin: H(8), closeMin: H(16, 30), universeSource: 'esma-firds', tickerTransform: 'exact', yahooRegion: 'pt' }),
  DUB: row({ id: 'DUB', market: 'EU', name: 'Euronext Dublin', country: 'IE', zone: 'Europe/Dublin', suffix: '.IR', micExchCodes: { XMSM: 'ID', XESM: 'ID' }, currency: 'EUR', openMin: H(8), closeMin: H(16, 30), universeSource: 'esma-firds', tickerTransform: 'exact', yahooRegion: 'ie' }),
  MIL: row({ id: 'MIL', market: 'EU', name: 'Euronext Milan', country: 'IT', zone: 'Europe/Rome', suffix: '.MI', micExchCodes: { MTAA: 'IM', EXGM: 'IM' }, currency: 'EUR', ...EURONEXT_CORE, universeSource: 'esma-firds', tickerTransform: 'exact', yahooRegion: 'it' }),
  OSL: row({ id: 'OSL', market: 'EU', name: 'Oslo Børs', country: 'NO', zone: 'Europe/Oslo', suffix: '.OL', micExchCodes: { XOSL: 'NO', XOAS: 'NO', MERK: 'NO' }, currency: 'NOK', openMin: H(9), closeMin: H(16, 20), universeSource: 'esma-firds', tickerTransform: 'exact', yahooRegion: 'no' }),
  XET: row({ id: 'XET', market: 'EU', name: 'Xetra', country: 'DE', zone: 'Europe/Berlin', suffix: '.DE', micExchCodes: { XETA: 'GY', XETS: 'GY' }, currency: 'EUR', ...EURONEXT_CORE, universeSource: 'esma-firds', tickerTransform: 'exact', yahooRegion: 'de' }),
  SIX: row({ id: 'SIX', market: 'EU', name: 'SIX Swiss Exchange', country: 'CH', zone: 'Europe/Zurich', suffix: '.SW', micExchCodes: {}, figiExchCode: 'SE', currency: 'CHF', openMin: H(9), closeMin: H(17, 20), universeSource: 'six-list', tickerTransform: 'exact', yahooRegion: 'ch' }),
  STO: row({ id: 'STO', market: 'EU', name: 'Nasdaq Stockholm', country: 'SE', zone: 'Europe/Stockholm', suffix: '.ST', micExchCodes: { XSTO: 'SS', SSME: 'SF' }, currency: 'SEK', ...EURONEXT_CORE, universeSource: 'esma-firds', tickerTransform: 'search', yahooRegion: 'se' }),
  CPH: row({ id: 'CPH', market: 'EU', name: 'Nasdaq Copenhagen', country: 'DK', zone: 'Europe/Copenhagen', suffix: '.CO', micExchCodes: { XCSE: 'DC', DSME: 'DF' }, currency: 'DKK', ...EURONEXT_CORE, universeSource: 'esma-firds', tickerTransform: 'search', yahooRegion: 'dk' }),
  HEL: row({ id: 'HEL', market: 'EU', name: 'Nasdaq Helsinki', country: 'FI', zone: 'Europe/Helsinki', suffix: '.HE', micExchCodes: { XHEL: 'FH', FSME: 'FF' }, currency: 'EUR', openMin: H(10), closeMin: H(18, 30), universeSource: 'esma-firds', tickerTransform: 'exact', yahooRegion: 'fi' }),
  MAD: row({ id: 'MAD', market: 'EU', name: 'BME Madrid', country: 'ES', zone: 'Europe/Madrid', suffix: '.MC', micExchCodes: { XMAD: 'SM', GROW: 'SM' }, currency: 'EUR', ...EURONEXT_CORE, universeSource: 'esma-firds', tickerTransform: 'exact', yahooRegion: 'es' }),
};

const IDS = Object.keys(EXCHANGES) as ExchangeId[];

/** The exchange whose Yahoo suffix ends the symbol (case-insensitive), or null for a symbol with no European suffix. */
export function exchangeOfSymbol(symbol: string): ExchangeId | null {
  const dot = symbol.lastIndexOf('.');
  if (dot <= 0) return null;
  const suffix = symbol.slice(dot).toUpperCase();
  return IDS.find((id) => EXCHANGES[id].suffix.toUpperCase() === suffix) ?? null;
}

export function exchangesOf(market: EuropeMarket): ExchangeId[] {
  return IDS.filter((id) => EXCHANGES[id].market === market);
}

/** Universe source endpoints (query strings are built by the callers, except the fixed SIX download). */
export const UNIVERSE_URLS = {
  esmaIndex: 'https://registers.esma.europa.eu/solr/esma_registers_firds_files/select',
  fcaIndex: 'https://api.data.fca.org.uk/fca_data_firds_files',
  sixList:
    'https://www.six-group.com/fqs/ref.csv?select=ShortName,ValorSymbol,ValorNumber,ISIN,TradingBaseCurrency,ListingSegmentDesc,GeographicalAreaDesc,SecTypeDesc&where=PortalSegment=EQ&orderby=ShortName&page=1&pagesize=99999',
  gleif: 'https://api.gleif.org/api/v1/lei-records',
  openFigi: 'https://api.openfigi.com/v3/mapping',
  yahooSearch: 'https://query2.finance.yahoo.com/v1/finance/search',
} as const;
