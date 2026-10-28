/**
 * Live check of the UK / EU full-level lists (UK_FULL, EU_FULL) against SEC, Cboe and Yahoo. Prints one line per
 * entry and exits 1 on any mismatch. Read-only: never touches a database.
 *
 * Per entry: the company_tickers.json CIK, the forms of the last 24 months (6-K vs 8-K/10-Q/10-K), the Cboe chain,
 * the ratio from SEC (the latest 20-F's cover class table, else its ADS sentence, else the latest F-6; shares listed
 * directly, or a 10-K filer's ordinary share, are ratio 1), the price-implied ratio (ADR close ÷ (local close × FX),
 * pence ÷ 100) and Yahoo's ISIN search for the local symbol. `verified=true` only when the SEC ratio and the implied
 * one agree within 15% (the JP rule); copy it into `adrRatioVerified`. A recorded flag that differs is a mismatch.
 *
 * Usage: npm run verify-europe-universe -w server -- [--market uk|eu] [--env <path to .env with SEC_USER_AGENT>]
 * SEC: its own 120 ms client. Cboe: 2,500 ms. Yahoo: the shared ≤ 1 req/s limiter. The SEC User-Agent is never printed.
 */
import { DateTime } from 'luxon';
import { EU_FULL, UK_FULL } from '../europe/universe.js';
import { fetchCboeChain } from '../sources/cboe.js';
import { BROWSER_UA, HttpError, makeHttp, type Http } from '../sources/http.js';
import { createYahooClient } from '../sources/yahooClient.js';
import { yahooLimiter } from '../sources/yahooLimiter.js';
import { parseRatioPhrase, ratioAgrees } from './verifyJpUniverse.js';

const NUM = '(?:\\d+(?:[.,]\\d+)*(?:/\\d+)?|[a-z]+(?:-[a-z]+)?)';
// Up to three words may sit between the number and the class ("one RELX PLC ordinary share", "one B Share").
const SHARE = '(?:[A-Za-z.&]+\\s+){0,3}?(?:shares?|stock)';
const ADS_WORD = '(?:ADS|ADR|American depositary (?:share|receipt))s?';
const RATIO_PART = `(?:the right to receive\\s+)?(${NUM}(?:\\s+of\\s+(?:one|1|an?))?)\\s+${SHARE}`;
// JP's sentences ("each ADS represents ten shares", "one ADS represents one-fifth of one share") plus "one-half of one",
// "the right to receive" and depositary receipts.
const RATIO_RE = new RegExp(
  `(?:each|one)\\s+${ADS_WORD}\\s*(?:\\([^)]{0,40}\\)\\s*)?(?:represents?|representing|is equivalent to|evidencing)\\s+${RATIO_PART}`,
  'gi',
);
const RATIO_RE_ALT = new RegExp(`${ADS_WORD}[^.]{0,80}?(?:represents?|representing)\\s+${RATIO_PART}`, 'gi');

/** The first ADS ratio sentence in filing text whose number reads ("ADSs representing these shares" is skipped). */
export function findRatioSentence(text: string): { ratio: number; evidence: string } | null {
  const all = [...text.matchAll(RATIO_RE), ...text.matchAll(RATIO_RE_ALT)].sort((a, b) => a.index - b.index);
  for (const m of all) {
    const ratio = parseRatioPhrase(m[1]!.replace(/\s+of\s+an?$/i, ' of one'));
    if (ratio != null && ratio > 0) return { ratio, evidence: m[0] };
  }
  return null;
}

const SPACES = new RegExp('[\\s\\u200b]+', 'g');

/** HTML to flat text: tags out, numeric entities decoded, zero-width and no-break spaces to spaces. */
export function flatText(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&rsquo;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(SPACES, ' ');
}

/** The 20-F cover's Section 12(b) class table (to "Section 12(g)", at most 3,000 characters), or null. */
export function coverSegment(text: string): string | null {
  const i = text.search(/Section 12\(b\) of the (?:Securities Exchange )?Act[^.]{0,80}?[:.]?\s*Title of each class/i);
  if (i < 0) return null;
  const rest = text.slice(i, i + 3000);
  const j = rest.search(/Section 12\(g\)/i);
  return j > 0 ? rest.slice(0, j) : rest;
}

/**
 * The ratio the 20-F cover states: an ADS class with its "each representing N shares" words, or the shares themselves
 * registered with no ADS class (ordinary, common, registered or NY registry shares listed directly: ratio 1).
 * Null when the cover has no class table, or names ADSs without a readable ratio.
 */
export function coverRatio(text: string): { ratio: number; evidence: string } | null {
  const seg = coverSegment(text);
  if (!seg) return null;
  if (/American Depositary|\bADSs?\b/i.test(seg)) {
    const s = findRatioSentence(seg);
    return s ? { ratio: s.ratio, evidence: s.evidence } : null;
  }
  const m = /(?:ordinary|common|registered|New York Registry)\s+shares?[\s\S]{0,80}?(?:New York Stock Exchange|NYSE|Nasdaq)/i.exec(seg);
  return m ? { ratio: 1, evidence: `${m[0]} (no ADS class: shares listed directly)` } : null;
}

/** Local shares per US share implied by prices: ADR close (US$) ÷ (local close × US$ per unit). GBp is pence ÷ 100. */
export function impliedLocalPerUs(adrUsd: number, localClose: number, localCurrency: string, usdPerUnit: number): number | null {
  const ok = (n: number) => Number.isFinite(n) && n > 0;
  if (!ok(adrUsd) || !ok(localClose) || !ok(usdPerUnit)) return null;
  const local = localCurrency === 'GBp' || localCurrency === 'GBX' ? localClose / 100 : localClose;
  return adrUsd / (local * usdPerUnit);
}

/** The FX pair giving US$ per unit of the listing currency (pence use the pound pair). Null for USD. */
export function fxPairFor(currency: string): string | null {
  const c = currency === 'GBp' || currency === 'GBX' ? 'GBP' : currency.toUpperCase();
  return c === 'USD' ? null : `${c}USD=X`;
}

/** 8-K when the issuer filed a 10-Q or 10-K in the window (a domestic filer), else 6-K when it filed 6-Ks, else null. */
export function secFormFrom(filings: { form: string; date: string }[], since: string): '6-K' | '8-K' | null {
  const recent = filings.filter((f) => f.date >= since).map((f) => f.form);
  if (recent.some((f) => f === '10-Q' || f === '10-K')) return '8-K';
  if (recent.includes('6-K')) return '6-K';
  return null;
}

/** Dropped names (no primary line on a target exchange): their ISIN search is printed as evidence, never a mismatch. */
const DROPPED: readonly { adr: string; isin: string }[] = [
  { adr: 'ARM', isin: 'US0420682058' },
  { adr: 'SPOT', isin: 'LU1778762911' },
  { adr: 'NXPI', isin: 'NL0009538784' },
  { adr: 'BNTX', isin: 'US09075V1026' },
  { adr: 'CHKP', isin: 'IL0010824113' },
  { adr: 'CRH', isin: 'IE0001827041' },
];

type Cols = { form: string[]; filingDate: string[]; accessionNumber: string[]; primaryDocument: string[] };
type Sub = { filings: { recent: Cols; files?: { name: string }[] } };

async function chart(y: Http, symbol: string, from: number, to: number): Promise<{ close: number; date: string; currency: string } | null> {
  const j = (await y.json(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${from}&period2=${to}&interval=1d`)) as {
    chart?: { result?: { meta?: { currency?: string; exchangeTimezoneName?: string }; timestamp?: number[]; indicators?: { quote?: { close?: (number | null)[] }[] } }[] };
  };
  const r = j.chart?.result?.[0];
  const ts = r?.timestamp ?? [];
  const closes = r?.indicators?.quote?.[0]?.close ?? [];
  for (let i = ts.length - 1; i >= 0; i--) {
    const c = closes[i];
    if (c != null && c > 0) {
      return { close: c, date: DateTime.fromSeconds(ts[i]!, { zone: r?.meta?.exchangeTimezoneName ?? 'UTC' }).toISODate()!, currency: r?.meta?.currency ?? '?' };
    }
  }
  return null;
}

async function isinSymbols(y: Http, isin: string): Promise<string[]> {
  const j = (await y.json(`https://query2.finance.yahoo.com/v1/finance/search?q=${isin}&quotesCount=10&newsCount=0`)) as { quotes?: { symbol?: string }[] };
  return (j.quotes ?? []).map((q) => q.symbol ?? '').filter(Boolean);
}

/** The latest F-6 family filing (F-6, F-6EF, F-6 POS) in the recent list, else in the older submission pages. */
async function latestF6(http: Http, sub: Sub): Promise<{ cols: Cols; i: number } | null> {
  const find = (cols: Cols) => cols.form.findIndex((f) => /^F-6/.test(f));
  const i = find(sub.filings.recent);
  if (i >= 0) return { cols: sub.filings.recent, i };
  for (const f of sub.filings.files ?? []) {
    const cols = (await http.json(`https://data.sec.gov/submissions/${f.name}`)) as Cols;
    const j = find(cols);
    if (j >= 0) return { cols, i: j };
  }
  return null;
}

async function secRatio(http: Http, cik: number, sub: Sub): Promise<{ stated: number | null; evidence: string }> {
  const r = sub.filings.recent;
  const docUrl = (c: Cols, i: number) => `https://www.sec.gov/Archives/edgar/data/${cik}/${c.accessionNumber[i]!.replace(/-/g, '')}/${c.primaryDocument[i]}`;
  const i20 = r.form.indexOf('20-F');
  if (i20 >= 0) {
    const text = flatText(await http.text(docUrl(r, i20)));
    const where = `20-F ${r.filingDate[i20]}`;
    const cover = coverRatio(text);
    if (cover) return { stated: cover.ratio, evidence: `${where} cover: "${cover.evidence}"` };
    const s = findRatioSentence(text);
    if (s) return { stated: s.ratio, evidence: `${where} body: "${s.evidence}"` };
  }
  // The depositary's F-6 (filed under the issuer's CIK) states the ratio on its cover.
  const f6 = await latestF6(http, sub);
  if (f6) {
    const s = findRatioSentence(flatText(await http.text(docUrl(f6.cols, f6.i))));
    if (s) return { stated: s.ratio, evidence: `${f6.cols.form[f6.i]} ${f6.cols.filingDate[f6.i]}: "${s.evidence}"` };
  }
  if (i20 < 0 && r.form.includes('10-K')) {
    const i10 = r.form.indexOf('10-K');
    return { stated: 1, evidence: `10-K filer (10-K ${r.filingDate[i10]}): ordinary share, ratio 1` };
  }
  return { stated: null, evidence: i20 >= 0 ? '(no ratio sentence in latest 20-F or F-6)' : '(no 20-F, F-6 or 10-K found)' };
}

function argOf(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const envFile = argOf('--env');
  if (envFile) process.loadEnvFile(envFile);
  const ua = process.env.SEC_USER_AGENT ?? '';
  if (!ua) {
    console.error('SEC_USER_AGENT is not set (pass --env <path to .env>)');
    process.exit(1);
  }
  const market = argOf('--market')?.toLowerCase();
  if (market && market !== 'uk' && market !== 'eu') {
    console.error('--market must be uk or eu');
    process.exit(1);
  }
  const entries = market === 'uk' ? UK_FULL : market === 'eu' ? EU_FULL : [...UK_FULL, ...EU_FULL];
  const sec = makeHttp({ minIntervalMs: 120, headers: { 'User-Agent': ua } });
  // The app's Cboe pacing (2.5 s), with its 15 s back-off on a 429.
  const cboe = makeHttp({ minIntervalMs: 2500, retries: 3, backoffMs: 15_000, headers: { 'User-Agent': BROWSER_UA } });
  const yahoo = createYahooClient({ limiter: yahooLimiter });
  const now = DateTime.utc();
  const p1 = Math.floor(now.minus({ days: 10 }).toSeconds());
  const p2 = Math.floor(now.toSeconds());
  const since = now.minus({ months: 24 }).toISODate()!;

  const tickers = (await sec.json('https://www.sec.gov/files/company_tickers.json')) as Record<string, { cik_str: number; ticker: string }>;
  const cikByTicker = new Map<string, number>();
  for (const t of Object.values(tickers)) if (!cikByTicker.has(t.ticker.toUpperCase())) cikByTicker.set(t.ticker.toUpperCase(), t.cik_str);

  const fx = new Map<string, number | null>();
  const fxRate = async (currency: string): Promise<number | null> => {
    const pair = fxPairFor(currency);
    if (pair == null) return 1;
    if (!fx.has(pair)) {
      try { fx.set(pair, (await chart(yahoo, pair, p1, p2))?.close ?? null); } catch { fx.set(pair, null); }
      console.log(`FX ${pair} ${fx.get(pair) ?? 'unavailable'}`);
    }
    return fx.get(pair)!;
  };

  let bad = 0;
  for (const e of entries) {
    const problems: string[] = [];
    const warnings: string[] = [];
    const secCik = cikByTicker.get(e.adr.toUpperCase()) ?? null;
    if (secCik !== e.cik) problems.push(`cik ${e.cik} != SEC ${secCik}`);
    const cik = secCik ?? e.cik;

    let formText = '';
    let ratio: { stated: number | null; evidence: string } = { stated: null, evidence: '' };
    try {
      const sub = (await sec.json(`https://data.sec.gov/submissions/CIK${String(cik).padStart(10, '0')}.json`)) as Sub;
      const r = sub.filings.recent;
      const filings = r.form.map((form, i) => ({ form, date: r.filingDate[i]! }));
      const live = secFormFrom(filings, since);
      const count = (f: string) => filings.filter((x) => x.form === f && x.date >= since).length;
      formText = `6-K×${count('6-K')} 8-K×${count('8-K')} 10-Q×${count('10-Q')} 20-F×${count('20-F')} 10-K×${count('10-K')} → ${live ?? '?'}`;
      if (live !== e.secForm) problems.push(`secForm ${e.secForm} != SEC ${live}`);
      ratio = await secRatio(sec, cik, sub);
      if (ratio.stated == null) problems.push('no SEC ratio');
      else if (Math.abs(ratio.stated - e.adrRatio) > 1e-9) problems.push(`ratio ${e.adrRatio} != SEC ${ratio.stated}`);
    } catch (err) {
      problems.push(`SEC lookup failed: ${(err as Error).message}`);
    }

    let cboeStatus = '200';
    try {
      if (!(await fetchCboeChain(cboe, e.adr))) { cboeStatus = 'none'; problems.push('no cboe chain'); }
    } catch (err) {
      cboeStatus = err instanceof HttpError ? String(err.status) : `error ${(err as Error).message}`;
      problems.push(`cboe ${cboeStatus}`);
    }

    // The local line: Yahoo's ISIN search names it. Yahoo lists only some lines per ISIN, so a miss is a warning when
    // the symbol trades (the ISIN is then checked against GLEIF by hand, see the Task 4 report).
    let line = 'local line ?';
    let searchMissed = false;
    try {
      const syms = await isinSymbols(yahoo, e.isin);
      if (syms.includes(e.symbol)) line = `isin→${e.symbol} ok`;
      else { line = `isin→[${syms.join(',')}] (search does not list ${e.symbol})`; searchMissed = true; }
    } catch (err) {
      line = `isin search failed: ${(err as Error).message}`;
      searchMissed = true;
    }

    let implied: number | null = null;
    let priceText = 'prices unavailable';
    try {
      const us = await chart(yahoo, e.adr, p1, p2);
      const local = await chart(yahoo, e.symbol, p1, p2);
      if (searchMissed && !local) problems.push(`no local line: ${e.symbol} not in ISIN search and has no closes`);
      else if (searchMissed) warnings.push(`ISIN search does not list ${e.symbol} (it trades: ${local!.currency})`);
      if (us && local) {
        const rate = await fxRate(local.currency);
        if (rate != null) {
          implied = impliedLocalPerUs(us.close, local.close, local.currency, rate);
          priceText = `$${us.close.toFixed(2)} (${us.date}) ÷ (${local.close.toFixed(2)} ${local.currency} (${local.date}) × ${rate.toFixed(4)}) = ${implied?.toFixed(3) ?? '-'}`;
        }
      }
    } catch (err) {
      priceText = `price fetch failed: ${(err as Error).message}`;
    }
    const verified = ratio.stated != null && ratioAgrees(ratio.stated, implied);
    if (verified !== e.adrRatioVerified) problems.push(`adrRatioVerified recorded ${e.adrRatioVerified}, live ${verified}`);
    console.log(`${e.market} ${e.symbol} ${e.adr} cik=${e.cik} sec=${secCik} | ${formText} | cboe=${cboeStatus} | ${line} | ratio=${e.adrRatio} ${ratio.evidence} | implied ${priceText} | verified=${verified} | ${problems.length ? 'MISMATCH: ' + problems.join('; ') : 'ok'}${warnings.length ? ' WARNING: ' + warnings.join('; ') : ''}`);
    if (problems.length) bad++;
  }

  for (const d of DROPPED) {
    try {
      console.log(`dropped ${d.adr} ${d.isin}: Yahoo ISIN search → [${(await isinSymbols(yahoo, d.isin)).join(',')}]`);
    } catch (err) {
      console.log(`dropped ${d.adr} ${d.isin}: search failed: ${(err as Error).message}`);
    }
  }
  console.log(bad ? `${bad} mismatch(es)` : 'all ok');
  process.exit(bad ? 1 : 0);
}

// Import-safe for tests: only run when invoked directly.
if (process.argv[1] && /verifyEuropeUniverse\.[tj]s$/.test(process.argv[1])) {
  main().catch((err) => { console.error(err instanceof Error ? err.message : 'failed'); process.exit(1); });
}
