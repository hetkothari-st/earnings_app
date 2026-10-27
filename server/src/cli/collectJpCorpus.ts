/**
 * Builds the JP 6-K release corpus (test/fixtures/jp/releases/) for the reader gate (Global Constraints).
 *   npm run collect-jp-corpus -w server               (main set; needs SEC_USER_AGENT)
 *   npm run collect-jp-corpus -w server -- --heldout  (held-out set, test/fixtures/jp/releases/heldout/)
 * For each full-level issuer (JP_FULL) it walks the 6-K filings of the last 24 months, newest first, picks the
 * release document (EX-99.1, else the 6-K itself) and classifies it with the 'jp' profile. Each results release of
 * at most 3 MB is saved as <ADR>_<periodEnd>.htm with a blank expected.json entry to be hand-checked; existing entries
 * are never changed (a file already present without an entry gets one only when the fetched document is identical).
 * Main set: up to 3 releases per issuer, all 8 issuers. Held-out: the newest release not in the main set, for 6
 * different issuers (banks and the broker first). One client, 120 ms spacing, www.sec.gov / data.sec.gov only.
 * Afterwards: hand-check every entry, then  npm run reader-corpus -w server -- --jp  (and  -- --jp-heldout  once).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DateTime } from 'luxon';
import { config } from '../config.js';
import { jpPeriodFor } from '../jp/domain/period.js';
import { JP_FULL } from '../jp/universe.js';
import { fetchEarningsFilings } from '../sources/sec.js';
import { parseFilingDocs } from '../sources/secFeed.js';
import { makeHttp } from '../sources/http.js';
import { classifySixK, pickReleaseDoc } from '../sources/sixKClassify.js';

const heldout = process.argv.includes('--heldout');
const mainDir = fileURLToPath(new URL('../../test/fixtures/jp/releases/', import.meta.url));
const dir = heldout ? `${mainDir}heldout/` : mainDir;
const MAX_BYTES = 3_000_000;
const MAIN_PER_ISSUER = 3;
const HELDOUT_ISSUERS = 6;
/** Every full-level name closes its fiscal year in March (verified against the EDINET code list's 決算日). */
const FY_END_MONTH = 3;
/** Held-out order: banks and the broker first, so the set exercises the bank rules. */
const HELDOUT_ORDER = ['MUFG', 'SMFG', 'NMR', 'TM', 'HMC', 'TAK', 'SONY', 'MFG'];

if (!config.secUserAgent) {
  console.error('SEC_USER_AGENT is not set');
  process.exit(1);
}
const http = makeHttp({ minIntervalMs: 120, headers: { 'User-Agent': config.secUserAgent } });

mkdirSync(dir, { recursive: true });
const expectedPath = `${dir}expected.json`;
const expected: Record<string, unknown> = existsSync(expectedPath) ? JSON.parse(readFileSync(expectedPath, 'utf8')) : {};
const save = () => writeFileSync(expectedPath, JSON.stringify(expected, null, 2) + '\n');
const htmIn = (d: string) => (existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.htm')) : []);
const mainFiles = new Set(htmIn(mainDir));
const since = DateTime.utc().minus({ months: 24 }).toISODate()!;

const issuers = heldout ? HELDOUT_ORDER.map((adr) => JP_FULL.find((e) => e.adr === adr)!) : [...JP_FULL];
let heldoutIssuers = new Set(htmIn(dir).map((f) => f.split('_')[0]!)).size;

interface Found { file: string; html: string; accession: string; periodEnd: string; span: string; all: Array<{ html: string; accession: string }> }

for (const e of issuers) {
  if (heldout && heldoutIssuers >= HELDOUT_ISSUERS) break;
  const cap = heldout ? 1 : MAIN_PER_ISSUER;
  if (htmIn(dir).filter((f) => f.startsWith(`${e.adr}_`)).length >= cap && !htmIn(dir).some((x) => x.startsWith(`${e.adr}_`) && !expected[x])) continue;
  // The periods to pass over: held-out skips the issuer's main-set periods.
  const skip = heldout ? [...mainFiles].filter((f) => f.startsWith(`${e.adr}_`)).length : 0;
  const filings = (await fetchEarningsFilings(http, e.cik)).filter((f) => f.form === '6-K' && f.filingDate >= since);
  // Newest first; a period's release is its EARLIEST results filing (the one the app reads, Ruling 15), so the walk
  // goes on until a period older than the ones wanted shows up, keeping the last-seen (earliest) document per period.
  const periods: Found[] = [];
  for (const f of filings) {
    if (periods.length > skip + cap) break;
    try {
      const docs = parseFilingDocs(await http.text(f.indexUrl), f.indexUrl);
      const url = pickReleaseDoc(docs);
      if (!url || !/\.html?$/i.test(url)) continue;
      const html = await http.text(url);
      if (Buffer.byteLength(html) > MAX_BYTES) { console.log(`skip ${e.adr} ${f.accession}: over 3 MB`); continue; }
      const c = classifySixK(html, { profile: 'jp', filedOn: f.filingDate });
      if (c.kind !== 'results') continue;
      const i = periods.findIndex((p) => p.periodEnd === c.periodEnd);
      const all = [...(i >= 0 ? periods[i]!.all : []), { html, accession: f.accession }];
      const found: Found = { file: `${e.adr}_${c.periodEnd}.htm`, html, accession: f.accession, periodEnd: c.periodEnd, span: c.span, all };
      if (i >= 0) periods[i] = found;
      else periods.push(found);
    } catch (err) {
      console.log(`error ${e.adr} ${f.accession}: ${(err as Error).message}`);
    }
  }
  let taken = 0;
  for (const p of periods.slice(0, skip + cap)) {
    if (heldout && mainFiles.has(p.file)) continue;
    if (expected[p.file]) continue;
    let accession = p.accession;
    if (existsSync(`${dir}${p.file}`)) {
      // A file saved earlier (Task 3's fixtures) gets its entry only when it is one of this period's results filings
      // (possibly a later one than the earliest), with that filing's accession.
      const saved = readFileSync(`${dir}${p.file}`, 'utf8');
      const same = p.all.find((d) => d.html === saved);
      if (!same) { console.log(`keep ${p.file}: matches none of the period's filings, no entry`); continue; }
      accession = same.accession;
    } else {
      if (taken >= cap) continue;
      writeFileSync(`${dir}${p.file}`, p.html);
    }
    taken++;
    const nextDay = DateTime.fromISO(p.periodEnd, { zone: 'utc' }).plus({ days: 1 }).toISODate()!;
    expected[p.file] = {
      adr: e.adr, cik: e.cik, accession, periodEnd: p.periodEnd,
      fiscalQuarter: jpPeriodFor(nextDay, FY_END_MONTH).fiscalQuarter,
      revenue: null, eps: null, epsDiluted: null, currency: null, span: null, ytdMonths: null, checked: false, note: '',
    };
    save();
    console.log(`saved ${p.file} (${accession}, ${p.span})`);
  }
  if (heldout && taken > 0) heldoutIssuers++;
}
console.log(`${htmIn(dir).length} releases in ${dir}`);
