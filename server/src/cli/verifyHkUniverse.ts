/**
 * Live check of the full-level HK universe against SEC and Cboe. Prints one line per entry
 * and exits 1 on any mismatch. Read-only: never touches the database.
 * Usage: npm run verify-hk-universe -w server  (needs SEC_USER_AGENT)
 */
import { config } from '../config.js';
import { HK_UNIVERSE, hkLevel } from '../hk/universe.js';
import { fetchCboeChain } from '../sources/cboe.js';
import { BROWSER_UA, HttpError, makeHttp } from '../sources/http.js';

const RATIO_RE = /each (ADS|American depositary share) represents? ([\w-]+) .{0,40}shares/i;
// Fallback for the cover-page / glossary wording ("ADSs, each of which represents two Class A ordinary shares").
const RATIO_RE_ALT = /(?:ADSs?|American depositary shares?)[^.]{0,60}?(?:represents?|representing)\s+(one|two|three|five|eight|ten|thirteen|\d+)\s+(?:Class [A-Z] )?(?:ordinary )?shares?/i;
const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, eight: 8, ten: 10, thirteen: 13 };

async function main(): Promise<void> {
  if (!config.secUserAgent) {
    console.error('SEC_USER_AGENT is not set');
    process.exit(1);
  }
  const http = makeHttp({ minIntervalMs: 120, headers: { 'User-Agent': config.secUserAgent } });
  const cboe = makeHttp({ minIntervalMs: 120, headers: { 'User-Agent': BROWSER_UA } });
  const tickers = (await http.json('https://www.sec.gov/files/company_tickers.json')) as Record<string, { cik_str: number; ticker: string }>;
  const cikByTicker = new Map<string, number>();
  for (const t of Object.values(tickers)) if (!cikByTicker.has(t.ticker.toUpperCase())) cikByTicker.set(t.ticker.toUpperCase(), t.cik_str);

  let bad = 0;
  for (const e of HK_UNIVERSE.filter((x) => hkLevel(x) === 'full')) {
    const problems: string[] = [];
    const secCik = cikByTicker.get(e.adr!.toUpperCase()) ?? null;
    if (secCik !== e.cik) problems.push(`cik ${e.cik} != SEC ${secCik}`);

    let cboeStatus = '200';
    try {
      if (!(await fetchCboeChain(cboe, e.adr!))) { cboeStatus = 'not listed or empty'; problems.push('cboe chain not 200/non-empty'); }
    } catch (err) {
      cboeStatus = err instanceof HttpError ? String(err.status) : `error ${(err as Error).message}`;
      problems.push(`cboe ${cboeStatus}`);
    }

    let ratioText = '';
    try {
      const cik = secCik ?? e.cik!;
      const sub = (await http.json(`https://data.sec.gov/submissions/CIK${String(cik).padStart(10, '0')}.json`)) as {
        filings: { recent: { form: string[]; accessionNumber: string[]; primaryDocument: string[] } };
      };
      const r = sub.filings.recent;
      const i = r.form.indexOf('20-F');
      if (i < 0) {
        // 10-K filer (domestic): common stock
        ratioText = 'common stock (1:1)';
        if (e.adrRatio !== 1 && e.code !== '6160') problems.push(`no 20-F; ratio ${e.adrRatio} unverified`);
      } else {
        const url = `https://www.sec.gov/Archives/edgar/data/${cik}/${r.accessionNumber[i]!.replace(/-/g, '')}/${r.primaryDocument[i]}`;
        const text = (await http.text(url)).replace(/<[^>]+>/g, ' ').replace(/&#160;|&nbsp;|&#8203;|&#8217;/g, ' ').replace(/\s+/g, ' ');
        const m = RATIO_RE.exec(text);
        const alt = m ? null : RATIO_RE_ALT.exec(text);
        if (alt) {
          ratioText = alt[0];
          const n = WORDS[alt[1]!.toLowerCase()] ?? Number(alt[1]);
          if (n !== e.adrRatio) problems.push(`ratio ${e.adrRatio} != 20-F ${n}`);
        } else if (!m) {
          ratioText = '(no ratio sentence found)';
          problems.push('no ratio sentence in latest 20-F');
        } else {
          ratioText = m[0];
          const n = WORDS[m[2]!.toLowerCase()] ?? Number(m[2]);
          if (!Number.isFinite(n)) problems.push(`unparsed ratio word "${m[2]}"`);
          else if (n !== e.adrRatio) problems.push(`ratio ${e.adrRatio} != 20-F ${n}`);
        }
      }
    } catch (err) {
      problems.push(`20-F lookup failed: ${(err as Error).message}`);
    }
    console.log(`${e.code} ${e.adr} cik=${e.cik} sec=${secCik} cboe=${cboeStatus} ratio=${e.adrRatio} | ${ratioText} | ${problems.length ? 'MISMATCH: ' + problems.join('; ') : 'ok'}`);
    if (problems.length) bad++;
  }
  console.log(bad ? `${bad} mismatch(es)` : 'all ok');
  process.exit(bad ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
