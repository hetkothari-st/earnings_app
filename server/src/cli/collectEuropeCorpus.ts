/**
 * Builds the UK / EU release corpus (test/fixtures/europe/releases/<uk|eu>/) for the reader gate (Global Constraints).
 *   npm run collect-europe-corpus -w server -- --profile uk             (main set; needs SEC_USER_AGENT)
 *   npm run collect-europe-corpus -w server -- --profile eu --heldout   (held-out set, …/<uk|eu>/heldout/)
 * As the JP collector, over UK_FULL / EU_FULL: for each full-level issuer it walks the filings of the last 24 months,
 * newest first — 6-K for 6-K filers, 8-K Item 2.02 for 8-K filers — picks the release document (EX-99.1, else the
 * first EX-99*, else the filing itself) and classifies it with the market's profile. Each results release of at most
 * 3 MB is saved as <ADR>_<periodEnd>.htm with a blank expected.json entry (the seven gate fields null, checked: false,
 * note: '') to be hand-checked; existing entries are never changed (a file already present without an entry gets one
 * only when the fetched document is identical). Main set: up to 3 releases per issuer. Held-out: the newest release
 * not in the main set, for 6 different issuers (banks first). One client, 120 ms spacing, www.sec.gov / data.sec.gov
 * only. Afterwards: hand-check every entry (fiscalQuarter included), then  npm run reader-corpus -w server -- --uk
 * (or --eu, and the held-out sets once).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DateTime } from 'luxon';
import { config } from '../config.js';
import { EU_FULL, UK_FULL } from '../europe/universe.js';
import { fetchEarningsFilings } from '../sources/sec.js';
import { parseFilingDocs } from '../sources/secFeed.js';
import { makeHttp } from '../sources/http.js';
import { classifySixK, pickReleaseDoc } from '../sources/sixKClassify.js';

const arg = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const profile = arg('--profile');
if (profile !== 'uk' && profile !== 'eu') {
  console.error('usage: collect-europe-corpus --profile uk|eu [--heldout]');
  process.exit(1);
}
const heldout = process.argv.includes('--heldout');
const mainDir = fileURLToPath(new URL(`../../test/fixtures/europe/releases/${profile}/`, import.meta.url));
const dir = heldout ? `${mainDir}heldout/` : mainDir;
const MAX_BYTES = 3_000_000;
const MAIN_PER_ISSUER = 3;
const HELDOUT_ISSUERS = 6;
/**
 * Fiscal-year-end months that are not December (the issuers' published reporting calendars), for the entries'
 * starting fiscalQuarter; every entry is hand-checked before it counts.
 */
const FY_END_MONTH: Record<string, number> = { DEO: 6, BHP: 6, VOD: 3, NGG: 3, LOGI: 3 };
/** Held-out order: banks first, so the set exercises the bank rules; then the list order. */
const BANKS = ['HSBC', 'BCS', 'LYG', 'NWG', 'ING', 'SAN', 'BBVA', 'UBS', 'DB'];

if (!config.secUserAgent) {
  console.error('SEC_USER_AGENT is not set');
  process.exit(1);
}
const http = makeHttp({ minIntervalMs: 120, headers: { 'User-Agent': config.secUserAgent } });

/** Fiscal quarter of a period end: months after the fiscal-year end (a day <= 15 counts as the month before). */
function fiscalQuarterOf(periodEnd: string, fyEndMonth: number): 1 | 2 | 3 | 4 | null {
  const d = DateTime.fromISO(periodEnd, { zone: 'utc' });
  const m = d.day <= 15 ? (d.month === 1 ? 12 : d.month - 1) : d.month;
  const k = (m - fyEndMonth + 12) % 12;
  return k % 3 !== 0 ? null : k === 0 ? 4 : (k / 3) as 1 | 2 | 3;
}

mkdirSync(dir, { recursive: true });
const expectedPath = `${dir}expected.json`;
const expected: Record<string, unknown> = existsSync(expectedPath) ? JSON.parse(readFileSync(expectedPath, 'utf8')) : {};
const save = () => writeFileSync(expectedPath, JSON.stringify(expected, null, 2) + '\n');
const htmIn = (d: string) => (existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.htm')) : []);
const mainFiles = new Set(htmIn(mainDir));
const since = DateTime.utc().minus({ months: 24 }).toISODate()!;

const list = profile === 'uk' ? UK_FULL : EU_FULL;
const issuers = heldout ? [...list.filter((e) => BANKS.includes(e.adr)), ...list.filter((e) => !BANKS.includes(e.adr))] : [...list];
let heldoutIssuers = new Set(htmIn(dir).map((f) => f.split('_')[0]!)).size;

interface Found { file: string; html: string; accession: string; periodEnd: string; span: string; all: Array<{ html: string; accession: string }> }

for (const e of issuers) {
  if (heldout && heldoutIssuers >= HELDOUT_ISSUERS) break;
  const cap = heldout ? 1 : MAIN_PER_ISSUER;
  if (htmIn(dir).filter((f) => f.startsWith(`${e.adr}_`)).length >= cap && !htmIn(dir).some((x) => x.startsWith(`${e.adr}_`) && !expected[x])) continue;
  // The periods to pass over: held-out skips the issuer's main-set periods.
  const skip = heldout ? [...mainFiles].filter((f) => f.startsWith(`${e.adr}_`)).length : 0;
  let filings;
  try {
    filings = (await fetchEarningsFilings(http, e.cik)).filter((f) => f.form === e.secForm && f.filingDate >= since);
  } catch (err) {
    console.log(`error ${e.adr} submissions: ${(err as Error).message}`);
    continue;
  }
  // Newest first; a period's release is its EARLIEST results filing (the one the app reads), so the walk goes on until
  // a period older than the ones wanted shows up, keeping the last-seen (earliest) document per period.
  const periods: Found[] = [];
  for (const f of filings) {
    if (periods.length > skip + cap) break;
    try {
      const docs = parseFilingDocs(await http.text(f.indexUrl), f.indexUrl);
      const url = pickReleaseDoc(docs);
      if (!url || !/\.html?$/i.test(url)) continue;
      const html = await http.text(url);
      if (Buffer.byteLength(html) > MAX_BYTES) { console.log(`skip ${e.adr} ${f.accession}: over 3 MB`); continue; }
      const c = classifySixK(html, { profile: profile as Parameters<typeof classifySixK>[1]['profile'], filedOn: f.filingDate });
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
      // A file saved earlier gets its entry only when it is one of this period's results filings, with that accession.
      const saved = readFileSync(`${dir}${p.file}`, 'utf8');
      const same = p.all.find((d) => d.html === saved);
      if (!same) { console.log(`keep ${p.file}: matches none of the period's filings, no entry`); continue; }
      accession = same.accession;
    } else {
      if (taken >= cap) continue;
      writeFileSync(`${dir}${p.file}`, p.html);
    }
    taken++;
    expected[p.file] = {
      adr: e.adr, cik: e.cik, accession, periodEnd: p.periodEnd,
      fiscalQuarter: fiscalQuarterOf(p.periodEnd, FY_END_MONTH[e.adr] ?? 12),
      revenue: null, revenueCurrency: null, eps: null, epsDiluted: null, epsCurrency: null, span: null, ytdMonths: null,
      checked: false, note: '',
    };
    save();
    console.log(`saved ${p.file} (${accession}, ${p.span})`);
  }
  if (heldout && taken > 0) heldoutIssuers++;
}
console.log(`${htmIn(dir).length} releases in ${dir}`);
