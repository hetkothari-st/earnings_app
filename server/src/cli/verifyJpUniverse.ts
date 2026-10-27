/**
 * Live check of the full-level Japan universe (JP_FULL) against SEC and Cboe. Prints one line per
 * entry and exits 1 on any mismatch. Read-only: never touches the database.
 * The ADR ratio is display-only: it is shown only when the latest 20-F ratio and the price-implied ratio (ADR close ×
 * USD/JPY ÷ Tokyo close, Yahoo through the shared ≤ 1 req/s limiter) agree within 15%. Each line prints
 * `verified=true|false`; copy that into `adrRatioVerified` in jp/universe.ts. A recorded flag that differs is a mismatch.
 * Usage: npm run verify-jp-universe -w server  (needs SEC_USER_AGENT)
 */
import { DateTime } from 'luxon';
import { config } from '../config.js';
import { JST } from '../jp/domain/jpCalendar.js';
import { JP_FULL } from '../jp/universe.js';
import { fetchCboeChain } from '../sources/cboe.js';
import { BROWSER_UA, HttpError, makeHttp } from '../sources/http.js';
import { fetchYahooDailyCloses } from '../sources/yahoo.js';
import { createYahooClient } from '../sources/yahooClient.js';
import { yahooLimiter } from '../sources/yahooLimiter.js';

/** Tokyo shares per ADS implied by prices: ADR close (US$) × USD/JPY ÷ Tokyo close (¥). Null when any input is unusable. */
export function impliedAdrRatio(adrCloseUsd: number, usdJpy: number, tokyoCloseJpy: number): number | null {
  const ok = (n: number) => Number.isFinite(n) && n > 0;
  return ok(adrCloseUsd) && ok(usdJpy) && ok(tokyoCloseJpy) ? (adrCloseUsd * usdJpy) / tokyoCloseJpy : null;
}

/** The 20-F ratio and the price-implied one agree within `tolerance` (15%) of the 20-F ratio. */
export function ratioAgrees(stated: number, implied: number | null, tolerance = 0.15): boolean {
  return implied != null && stated > 0 && Math.abs(implied / stated - 1) <= tolerance;
}

/** The latest close in a date-keyed map, or null. */
const latestClose = (m: Map<string, number>): { date: string; close: number } | null => {
  const d = [...m.keys()].sort().pop();
  return d ? { date: d, close: m.get(d)! } : null;
};

const WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fifteen: 15, twenty: 20,
};
const ORD: Record<string, number> = {
  half: 2, halves: 2, third: 3, thirds: 3, fourth: 4, fourths: 4, quarter: 4, fifth: 5, fifths: 5, sixth: 6, tenth: 10, tenths: 10,
};
const NUM = '(?:\\d+(?:[.,]\\d+)*(?:/\\d+)?|[a-z]+(?:-[a-z]+)?)';
// "each ADS represents ten shares", "one ADS represents one-fifth of one share of common stock", ...
const RATIO_RE = new RegExp(
  `(?:each|one)\\s+(?:ADS|ADR|American depositary (?:share|receipt))s?\\s*(?:\\([^)]{0,40}\\)\\s*)?(?:represents?|representing|is equivalent to|evidencing)\\s+(${NUM}(?:\\s+of\\s+(?:one|1))?)\\s+(?:(?:Class [A-Z]\\s+)?(?:ordinary|common)\\s+)?(?:shares?|stock)`,
  'i',
);
const RATIO_RE_ALT = new RegExp(
  `(?:ADSs?|American depositary shares?)[^.]{0,80}?(?:represents?|representing)\\s+(${NUM}(?:\\s+of\\s+(?:one|1))?)\\s+(?:(?:Class [A-Z]\\s+)?(?:ordinary|common)\\s+)?(?:shares?|stock)`,
  'i',
);

function word(w: string): number | null {
  const s = w.toLowerCase();
  if (WORDS[s] != null) return WORDS[s]!;
  if (/^\d+(?:,\d{3})*(?:\.\d+)?$/.test(s)) return Number(s.replace(/,/g, ''));
  if (/^\d+\/\d+$/.test(s)) { const [a, b] = s.split('/').map(Number); return b ? a! / b : null; }
  return null;
}

/** "ten" → 10, "0.2" → 0.2, "one-fifth of one" → 0.2, "two-tenths" → 0.2, "one-half of one" → 0.5. */
export function parseRatioPhrase(phrase: string): number | null {
  const s = phrase.toLowerCase().replace(/\s+of\s+(?:one|1)$/, '').trim();
  const frac = /^([a-z]+|\d+)-([a-z]+)$/.exec(s);
  if (frac && ORD[frac[2]!] != null) {
    const num = word(frac[1]!);
    return num == null ? null : num / ORD[frac[2]!]!;
  }
  if (s === 'half' || s === 'a half') return 0.5;
  return word(s);
}

const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9;

async function main(): Promise<void> {
  if (!config.secUserAgent) {
    console.error('SEC_USER_AGENT is not set');
    process.exit(1);
  }
  const http = makeHttp({ minIntervalMs: 120, headers: { 'User-Agent': config.secUserAgent } });
  // The app's Cboe pacing (2.5 s between chain requests).
  const cboe = makeHttp({ minIntervalMs: 2500, headers: { 'User-Agent': BROWSER_UA } });
  const yahoo = createYahooClient({ limiter: yahooLimiter });
  const to = DateTime.now().setZone(JST).toISODate()!;
  const from = DateTime.now().setZone(JST).minus({ days: 10 }).toISODate()!;
  let usdJpy: { date: string; close: number } | null = null;
  try {
    usdJpy = latestClose(await fetchYahooDailyCloses(yahoo, 'JPY=X', from, to, 'UTC'));
  } catch (err) {
    console.error(`USD/JPY fetch failed: ${(err as Error).message}`);
  }
  console.log(`USD/JPY ${usdJpy ? `${usdJpy.close} (${usdJpy.date})` : 'unavailable'}`);
  const tickers = (await http.json('https://www.sec.gov/files/company_tickers.json')) as Record<string, { cik_str: number; ticker: string }>;
  const cikByTicker = new Map<string, number>();
  for (const t of Object.values(tickers)) if (!cikByTicker.has(t.ticker.toUpperCase())) cikByTicker.set(t.ticker.toUpperCase(), t.cik_str);

  let bad = 0;
  for (const e of JP_FULL) {
    const problems: string[] = [];
    const warnings: string[] = [];
    const secCik = cikByTicker.get(e.adr.toUpperCase()) ?? null;
    if (secCik !== e.cik) problems.push(`cik ${e.cik} != SEC ${secCik}`);

    let cboeStatus = '200';
    try {
      if (!(await fetchCboeChain(cboe, e.adr))) { cboeStatus = 'not listed or empty'; problems.push('cboe chain not 200/non-empty'); }
    } catch (err) {
      cboeStatus = err instanceof HttpError ? String(err.status) : `error ${(err as Error).message}`;
      problems.push(`cboe ${cboeStatus}`);
    }

    let ratioText = '';
    let statedRatio: number | null = null;
    try {
      const cik = secCik ?? e.cik;
      const sub = (await http.json(`https://data.sec.gov/submissions/CIK${String(cik).padStart(10, '0')}.json`)) as {
        filings: { recent: { form: string[]; accessionNumber: string[]; primaryDocument: string[] } };
      };
      const r = sub.filings.recent;
      const i = r.form.indexOf('20-F');
      if (i < 0) {
        ratioText = '(no 20-F found)';
        problems.push(ratioText);
      } else {
        const url = `https://www.sec.gov/Archives/edgar/data/${cik}/${r.accessionNumber[i]!.replace(/-/g, '')}/${r.primaryDocument[i]}`;
        const text = (await http.text(url)).replace(/<[^>]+>/g, ' ').replace(/&#160;|&nbsp;|&#8203;|&#8217;/g, ' ').replace(/\s+/g, ' ');
        const m = RATIO_RE.exec(text) ?? RATIO_RE_ALT.exec(text);
        if (m) {
          ratioText = m[0];
          const n = parseRatioPhrase(m[1]!);
          if (n == null) problems.push(`unparsed ratio "${m[1]}"`);
          else if (!near(n, e.adrRatio)) problems.push(`ratio ${e.adrRatio} != 20-F ${n}`);
          else statedRatio = n;
        } else {
          ratioText = '(no ratio sentence found)';
          problems.push('no ratio sentence in latest 20-F');
        }
      }
    } catch (err) {
      problems.push(`SEC filing lookup failed: ${(err as Error).message}`);
    }
    // Price cross-check: ADR close × USD/JPY ÷ Tokyo close against the 20-F ratio.
    let implied: number | null = null;
    let priceText = 'prices unavailable';
    try {
      const adr = latestClose(await fetchYahooDailyCloses(yahoo, e.adr, from, to, 'America/New_York'));
      const tokyo = latestClose(await fetchYahooDailyCloses(yahoo, `${e.code}.T`, from, to, JST));
      if (adr && tokyo && usdJpy) {
        implied = impliedAdrRatio(adr.close, usdJpy.close, tokyo.close);
        priceText = `ADR $${adr.close} (${adr.date}) × ${usdJpy.close} ÷ ¥${tokyo.close} (${tokyo.date}) = ${implied?.toFixed(3) ?? '-'}`;
      }
    } catch (err) {
      priceText = `price fetch failed: ${(err as Error).message}`;
    }
    const verified = statedRatio != null && ratioAgrees(statedRatio, implied);
    if (verified !== e.adrRatioVerified) problems.push(`adrRatioVerified recorded ${e.adrRatioVerified}, live ${verified}`);
    console.log(`${e.code} ${e.adr} cik=${e.cik} sec=${secCik} cboe=${cboeStatus} ratio=${e.adrRatio} | ${ratioText} | ${priceText} | verified=${verified} | ${problems.length ? 'MISMATCH: ' + problems.join('; ') : 'ok'}${warnings.length ? ' WARNING: ' + warnings.join('; ') : ''}`);
    if (problems.length) bad++;
  }
  console.log(bad ? `${bad} mismatch(es)` : 'all ok');
  process.exit(bad ? 1 : 0);
}

// Import-safe for tests: only run when invoked directly.
if (process.argv[1] && /verifyJpUniverse\.[tj]s$/.test(process.argv[1])) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
