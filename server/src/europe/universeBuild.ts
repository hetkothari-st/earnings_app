/**
 * The UK and EU universe build (Rulings 4 and 5): FIRDS share lines (FCA for UK MICs, ESMA for EU MICs) and the SIX
 * share list → one primary line per ISIN → OpenFIGI ticker → Yahoo symbol, with GLEIF names. Pure: the caller fetches
 * (`fetchFirdsShares`, `parseSixList`, `fetchLegalNames`, `createOpenFigi`, `yahooIsinSearch`) and passes the answers.
 *
 * Order of work for a caller:
 * 1. FIRDS shares (UK, EU) and the SIX list.
 * 2. `figiJobsFor` → OpenFIGI answers (cache in `europe_figi`; only new ISINs cost requests).
 * 3. `searchIsinsFor` → Yahoo ISIN search for the `search` exchanges (STO, CPH) only.
 * 4. GLEIF names for the picked lines' LEIs (`leisFor`).
 * 5. `buildEuropeUniverse`.
 *
 * Primary line (Ruling 4 as ruled after Task 1): the issuer-requested, non-terminated line on a target MIC. With
 * several, the one on the exchange whose country is the ISIN's country, across UK and EU together; still several (or
 * none matching), the UK line if exactly one UK line remains; otherwise the ISIN is left out as ambiguous (counted,
 * never guessed). So TotalEnergies (FR, also on XLON) stays EU and Shell (GB, also on XAMS) is UK only.
 *
 * Full-level rows (`universe.ts`) always exist, whatever the tie-break gives: their symbol, ISIN, name (the curated
 * English one), ADR, ratio, CIK and form override the build's, and a full row the build did not produce (BHP.L's AU ISIN, a dual line left out as
 * ambiguous, an ISIN the build put in the other market) is kept and logged.
 */

import { EXCHANGES, exchangeOfSymbol, type EuropeMarket, type ExchangeId } from './exchanges.js';
import type { FirdsShare } from './sources/firds.js';
import type { FigiAnswer } from './sources/openFigi.js';
import type { SixShare } from './sources/sixList.js';
import type { EuropeFullEntry } from './universe.js';

export interface EuropeUniverseEntry {
  market: EuropeMarket;
  symbol: string;
  isin: string;
  lei: string | null;
  name: string;
  exchange: ExchangeId;
  mic: string;
  country: string;
  currency: string;
  adr: string | null;
  adrRatio: number | null;
  adrRatioVerified: boolean;
  cik: number | null;
  secForm: '6-K' | '8-K' | null;
}

export type LeftOutReason = 'ambiguous-line' | 'no-ticker' | 'ambiguous-ticker' | 'not-confirmed';

/** The SIX Swiss Exchange MIC, given to SIX-list rows (Switzerland is outside FIRDS). */
export const SIX_MIC = 'XSWX';

const MIC_EXCHANGE: ReadonlyMap<string, ExchangeId> = new Map([
  ...Object.values(EXCHANGES).flatMap((e) => e.mics.map((m) => [m, e.id] as const)),
  [SIX_MIC, 'SIX' as const],
]);

const exchangeOfMic = (mic: string): ExchangeId | null => MIC_EXCHANGE.get(mic) ?? null;
const marketOfMic = (mic: string): EuropeMarket | null => {
  const ex = exchangeOfMic(mic);
  return ex ? EXCHANGES[ex].market : null;
};

/** Ruling 4's primary line per ISIN. `ambiguous` lists ISINs with several candidate lines left after the tie-breaks. */
export function pickPrimaryLines(shares: FirdsShare[]): { picked: Map<string, FirdsShare>; ambiguous: string[] } {
  const byIsin = new Map<string, FirdsShare[]>();
  for (const s of shares) {
    if (!s.issuerRequested || s.terminated || !exchangeOfMic(s.mic)) continue;
    const list = byIsin.get(s.isin) ?? [];
    if (!list.some((x) => x.mic === s.mic)) list.push(s);
    byIsin.set(s.isin, list);
  }
  const picked = new Map<string, FirdsShare>();
  const ambiguous: string[] = [];
  for (const [isin, cands] of byIsin) {
    if (cands.length === 1) {
      picked.set(isin, cands[0]!);
      continue;
    }
    const home = cands.filter((c) => EXCHANGES[exchangeOfMic(c.mic)!].country === isin.slice(0, 2));
    if (home.length === 1) {
      picked.set(isin, home[0]!);
      continue;
    }
    const pool = home.length > 1 ? home : cands;
    const uk = pool.filter((c) => marketOfMic(c.mic) === 'UK');
    if (uk.length === 1) picked.set(isin, uk[0]!);
    else ambiguous.push(isin);
  }
  return { picked, ambiguous: ambiguous.sort() };
}

/**
 * Ruling 5 with Task 1's LSE rule: a trailing `/` is dropped and an inner `/` becomes `-` (`BA/` → BA.L,
 * `BT/A` → BT-A.L), then the suffix. On `search` exchanges (STO, CPH) a trailing class letter may or may not take a
 * hyphen on Yahoo (`ERICB` → ERIC-B.ST, `CLAV` → CLAV.ST), so both forms are candidates for the ISIN search to settle.
 */
export function yahooSymbolFor(ex: ExchangeId, figiTicker: string): { exact: string } | { candidates: string[] } {
  const { suffix, tickerTransform } = EXCHANGES[ex];
  const t = figiTicker.trim().toUpperCase().replace(/\/+$/, '').replace(/[/\s]+/g, '-');
  if (tickerTransform !== 'search') return { exact: `${t}${suffix}` };
  const m = /^([A-Z0-9][A-Z0-9-]*?[A-Z0-9])([A-Z])$/.exec(t);
  return m && !t.includes('-') ? { candidates: [`${m[1]}-${m[2]}${suffix}`, `${t}${suffix}`] } : { candidates: [`${t}${suffix}`] };
}

const CLASS_WORDS =
  /\s+(?:\S*AKTIEN?\b|AKT\.|ORD(?:INARY)?\b|SHS\b|SHRS\b|SHARES?\b|SER\.|SERIES\b|REG(?:ISTERED)?\b|BEARER\b|NPV\b|O\.N\.)/i;

/** A FIRDS `FullNm` with its share-class words cut (`SAP SE Inhaber-Aktien o.N.` → `SAP SE`). */
export function trimFirdsName(fullName: string): string {
  const name = fullName.replace(/\s+/g, ' ').trim();
  const m = CLASS_WORDS.exec(name);
  const cut = (m ? name.slice(0, m.index) : name).replace(/[\s,;/-]+$/, '');
  return cut || name;
}

interface BuildSources {
  firdsUk: FirdsShare[];
  firdsEu: FirdsShare[];
  six: SixShare[];
}

/**
 * Every candidate line: UK MICs from FCA, EU MICs from ESMA, SIX-list rows as issuer-requested XSWX lines. SIX lines
 * with a US ISIN (Abbott, 3M) are left out (controller ruling): the US tab covers those companies.
 */
function candidateLines(o: BuildSources): FirdsShare[] {
  return [
    ...o.firdsUk.filter((s) => marketOfMic(s.mic) === 'UK'),
    ...o.firdsEu.filter((s) => marketOfMic(s.mic) === 'EU' && s.mic !== SIX_MIC),
    ...o.six.filter((r) => !r.isin.startsWith('US')).map((r): FirdsShare => ({ isin: r.isin, fullName: r.name, cfi: 'ES', lei: null, mic: SIX_MIC, issuerRequested: true, terminated: false })),
  ];
}

/** The OpenFIGI jobs for the picked lines (SIX rows need none: ValorSymbol is the ticker). */
export function figiJobsFor(o: BuildSources): { isin: string; exchCode: string }[] {
  const jobs: { isin: string; exchCode: string }[] = [];
  for (const [isin, line] of pickPrimaryLines(candidateLines(o)).picked) {
    const ex = exchangeOfMic(line.mic)!;
    if (ex === 'SIX') continue;
    jobs.push({ isin, exchCode: EXCHANGES[ex].micExchCodes[line.mic]! });
  }
  return jobs;
}

/** ISINs whose ticker needs the Yahoo ISIN search: a `search` exchange line with at least one OpenFIGI ticker. */
export function searchIsinsFor(figi: FigiAnswer[]): string[] {
  const searchCodes = new Set(
    Object.values(EXCHANGES).filter((e) => e.tickerTransform === 'search').flatMap((e) => Object.values(e.micExchCodes)),
  );
  return [...new Set(figi.filter((a) => a.tickers.length > 0 && searchCodes.has(a.exchCode)).map((a) => a.isin))];
}

/** The issuer LEIs of the picked lines, for GLEIF. */
export function leisFor(o: BuildSources): string[] {
  const out = new Set<string>();
  for (const line of pickPrimaryLines(candidateLines(o)).picked.values()) if (line.lei) out.add(line.lei);
  return [...out];
}

export function buildEuropeUniverse(o: BuildSources & {
  names: Map<string, string>;
  figi: FigiAnswer[];
  searched: Map<string, string[]>;
  full: readonly EuropeFullEntry[];
}): { uk: EuropeUniverseEntry[]; eu: EuropeUniverseEntry[]; leftOut: { isin: string; reason: LeftOutReason }[] } {
  const lines = candidateLines(o);
  const { picked, ambiguous } = pickPrimaryLines(lines);
  const figiBy = new Map(o.figi.map((a) => [`${a.isin}|${a.exchCode}`, a]));
  const sixBy = new Map<string, SixShare>();
  for (const r of o.six) if (!sixBy.has(r.isin)) sixBy.set(r.isin, r);

  const leftOut = new Map<string, LeftOutReason>(ambiguous.map((isin) => [isin, 'ambiguous-line']));
  const nameOf = (line: FirdsShare): string => (line.lei && o.names.get(line.lei)) || trimFirdsName(line.fullName);

  let rows: EuropeUniverseEntry[] = [];
  for (const [isin, line] of picked) {
    const ex = exchangeOfMic(line.mic)!;
    const info = EXCHANGES[ex];
    let symbol: string;
    let name: string;
    let currency = info.currency;
    if (ex === 'SIX') {
      const r = sixBy.get(isin)!;
      symbol = (yahooSymbolFor('SIX', r.symbol) as { exact: string }).exact;
      name = r.name;
      currency = r.currency;
    } else {
      const tickers = figiBy.get(`${isin}|${info.micExchCodes[line.mic]}`)?.tickers ?? [];
      if (tickers.length === 0) {
        leftOut.set(isin, 'no-ticker');
        continue;
      }
      const forms = tickers.map((t) => yahooSymbolFor(ex, t));
      if (info.tickerTransform !== 'search') {
        const exact = [...new Set(forms.map((f) => (f as { exact: string }).exact))];
        if (exact.length !== 1) {
          leftOut.set(isin, 'ambiguous-ticker');
          continue;
        }
        symbol = exact[0]!;
      } else {
        const found = new Set((o.searched.get(isin) ?? []).map((s) => s.toUpperCase()));
        const confirmed = [...new Set(forms.flatMap((f) => (f as { candidates: string[] }).candidates))].filter((c) => found.has(c));
        if (confirmed.length !== 1) {
          leftOut.set(isin, confirmed.length > 1 || tickers.length > 1 ? 'ambiguous-ticker' : 'not-confirmed');
          continue;
        }
        symbol = confirmed[0]!;
      }
      name = nameOf(line);
    }
    rows.push({
      market: info.market, symbol, isin, lei: line.lei, name, exchange: ex, mic: line.mic, country: info.country, currency,
      adr: null, adrRatio: null, adrRatioVerified: false, cik: null, secForm: null,
    });
  }

  // Two ISINs on one Yahoo symbol: neither is trusted.
  const count = new Map<string, number>();
  for (const r of rows) count.set(r.symbol, (count.get(r.symbol) ?? 0) + 1);
  for (const r of rows) if (count.get(r.symbol)! > 1) leftOut.set(r.isin, 'ambiguous-ticker');
  rows = rows.filter((r) => count.get(r.symbol) === 1);

  for (const f of o.full) {
    const ex = exchangeOfSymbol(f.symbol);
    if (!ex || EXCHANGES[ex].market !== f.market) {
      console.warn(`europe universe: full-level ${f.symbol} (${f.adr}) has no ${f.market} exchange suffix; skipped`);
      continue;
    }
    const own = rows.find((r) => r.isin === f.isin && r.market === f.market && r.exchange === ex);
    // One ISIN, one row: the full entry's line replaces whatever the build made of that ISIN or symbol.
    rows = rows.filter((r) => r === own || (r.isin !== f.isin && !(r.market === f.market && r.symbol === f.symbol)));
    leftOut.delete(f.isin);
    const level = { adr: f.adr, adrRatio: f.adrRatio, adrRatioVerified: f.adrRatioVerified, cik: f.cik, secForm: f.secForm };
    if (own) {
      // The full list's curated English name is the display name (controller ruling), not the FIRDS/GLEIF one.
      Object.assign(own, { symbol: f.symbol, name: f.names[0]! }, level);
      continue;
    }
    const anyLine = lines.find((l) => l.isin === f.isin && l.lei) ?? lines.find((l) => l.isin === f.isin);
    const exLine = lines.find((l) => l.isin === f.isin && exchangeOfMic(l.mic) === ex);
    const lei = anyLine?.lei ?? null;
    const info = EXCHANGES[ex];
    const six = ex === 'SIX' ? sixBy.get(f.isin) : undefined;
    rows.push({
      market: f.market, symbol: f.symbol, isin: f.isin, lei,
      name: f.names[0]!,
      exchange: ex, mic: exLine?.mic ?? info.mics[0] ?? SIX_MIC, country: info.country, currency: six?.currency ?? info.currency,
      ...level,
    });
    console.warn(`europe universe: full-level ${f.symbol} (${f.adr}) is not in the build; kept`);
  }

  rows.sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
  return {
    uk: rows.filter((r) => r.market === 'UK'),
    eu: rows.filter((r) => r.market === 'EU'),
    leftOut: [...leftOut].map(([isin, reason]) => ({ isin, reason })).sort((a, b) => (a.isin < b.isin ? -1 : 1)),
  };
}
