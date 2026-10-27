/**
 * Builds the HK 6-K release corpus (test/fixtures/hk/releases/) for the reader gate (Ruling 10).
 *   npm run collect-hk-corpus -w server            (needs SEC_USER_AGENT)
 * For each full-level issuer it walks the 6-K (and 8-K Item 2.02) filings of the last 24 months, newest first,
 * picks the release document (EX-99.1, else the 6-K itself) and classifies it. Each results release is saved as
 * <ADR>_<periodEnd>.htm with a blank expected.json entry to be hand-checked; existing entries are never changed.
 * Documents over 3 MB are skipped. One client, 120 ms spacing, www.sec.gov / data.sec.gov only.
 * Afterwards: hand-check every entry, then  npm run reader-corpus -w server -- --hk
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DateTime } from 'luxon';
import { config } from '../config.js';
import { classifyHkExhibit, pickReleaseDoc, type HkSpan } from '../hk/sources/sixK.js';
import { HK_UNIVERSE, hkLevel } from '../hk/universe.js';
import { fetchEarningsFilings } from '../sources/sec.js';
import { parseFilingDocs } from '../sources/secFeed.js';
import { makeHttp } from '../sources/http.js';

const dir = fileURLToPath(new URL('../../test/fixtures/hk/releases/', import.meta.url));
const TARGET = 24;
const MAX_BYTES = 3_000_000;
/** Releases taken per issuer, so the corpus spreads across issuers; more for the half-yearly reporters. */
const PER_ISSUER: Record<string, number> = { HSBC: 3, PUK: 3 };
const DEFAULT_PER_ISSUER = 2;
/** Required issuers first, so the target never cuts them. */
const FIRST = ['BABA', 'JD', 'NTES', 'HSBC', 'PUK'];
const KIND: Record<HkSpan, 'Q' | 'H' | 'FY'> = { quarter: 'Q', half: 'H', year: 'FY' };

if (!config.secUserAgent) {
  console.error('SEC_USER_AGENT is not set');
  process.exit(1);
}
const http = makeHttp({ minIntervalMs: 120, headers: { 'User-Agent': config.secUserAgent } });

mkdirSync(dir, { recursive: true });
const expectedPath = `${dir}expected.json`;
const expected: Record<string, unknown> = existsSync(expectedPath) ? JSON.parse(readFileSync(expectedPath, 'utf8')) : {};
let count = readdirSync(dir).filter((f) => f.endsWith('.htm')).length;
const since = DateTime.utc().minus({ months: 24 }).toISODate()!;

const issuers = HK_UNIVERSE.filter((e) => hkLevel(e) === 'full')
  .sort((a, b) => (FIRST.indexOf(a.adr!) + 1 || 99) - (FIRST.indexOf(b.adr!) + 1 || 99));

for (const e of issuers) {
  if (count >= TARGET) break;
  const adr = e.adr!;
  const cap = PER_ISSUER[adr] ?? DEFAULT_PER_ISSUER;
  let taken = Object.keys(expected).filter((f) => f.startsWith(`${adr}_`)).length;
  const filings = (await fetchEarningsFilings(http, e.cik!)).filter((f) => f.filingDate >= since);
  for (const f of filings) {
    if (taken >= cap || count >= TARGET) break;
    try {
      const docs = parseFilingDocs(await http.text(f.indexUrl), f.indexUrl);
      const url = pickReleaseDoc(docs);
      if (!url || !/\.html?$/i.test(url)) continue;
      const html = await http.text(url);
      if (Buffer.byteLength(html) > MAX_BYTES) { console.log(`skip ${adr} ${f.accession}: over 3 MB`); continue; }
      const c = classifyHkExhibit(html);
      if (c.kind !== 'results') continue;
      const file = `${adr}_${c.periodEnd}.htm`;
      if (existsSync(`${dir}${file}`) || expected[file]) continue;
      writeFileSync(`${dir}${file}`, html);
      expected[file] = {
        adr, cik: e.cik, accession: f.accession, periodEnd: c.periodEnd, kind: KIND[c.span],
        eps: null, epsBasis: null, epsCurrency: null, revenue: null, revenueCurrency: null, checked: false, note: '',
      };
      writeFileSync(expectedPath, JSON.stringify(expected, null, 2) + '\n');
      taken++;
      count++;
      console.log(`saved ${file} (${f.form} ${f.accession}, ${c.span})`);
    } catch (err) {
      console.log(`error ${adr} ${f.accession}: ${(err as Error).message}`);
    }
  }
}
console.log(`${count} releases in ${dir}`);
