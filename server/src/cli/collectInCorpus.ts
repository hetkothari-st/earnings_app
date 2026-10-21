/**
 * Grows the India results-PDF corpus (test/fixtures/india/pdf/) during results hours.
 *   npm run collect-in-corpus -w server                 (60 minutes)
 *   npm run collect-in-corpus -w server -- --minutes 240
 * Polls NSE's Integrated_Filing feed every minute and Online_announcements every 5 minutes (at most one request
 * a second, nsearchives.nseindia.com only). A results PDF ("Outcome of Board Meeting" / "Financial Results") is
 * paired with the same company's quarterly XBRL filing; the consolidated filing is preferred, a standalone one
 * is used when no consolidated filing follows within 30 minutes. Each pair saves the PDF (≤ 3 MB) and adds its
 * expected.json entry from the XBRL; existing entries are never changed. Afterwards re-check the gates with
 *   npm run reader-corpus -w server -- --india
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { looksBlocked } from '../sources/failover.js';
import { BROWSER_UA, makeHttp, type Http } from '../sources/http.js';
import { fetchNseRss, isResultSubject, parseAnnouncementDescription, resolveIntegratedFilingUrl, type RssItem } from '../india/sources/nseRss.js';
import { fetchResultsPdf } from '../india/sources/resultsPdf.js';
import { parseIntegratedFiling, type IntegratedFiling } from '../india/sources/xbrl.js';

const dir = fileURLToPath(new URL('../../test/fixtures/india/pdf/', import.meta.url));
const minutesArg = process.argv.indexOf('--minutes');
const minutes = minutesArg > 0 ? Number(process.argv[minutesArg + 1]) : 60;
const MAX_PDF = 3_000_000;
const STANDALONE_GRACE_MS = 30 * 60_000;

// One request a second across feeds, XBRL files and PDFs.
let last = 0;
const gate = async () => {
  const wait = last + 1100 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  last = Date.now();
};
const HOST = 'https://nsearchives.nseindia.com/';
const inner = makeHttp({ minIntervalMs: 0, headers: { 'User-Agent': BROWSER_UA }, retries: 0 });
const http: Http = {
  json: async (u) => {
    if (!u.startsWith(HOST)) throw new Error(`host not allowed: ${u}`);
    await gate();
    return inner.json(u);
  },
  text: async (u) => {
    if (!u.startsWith(HOST)) throw new Error(`host not allowed: ${u}`);
    await gate();
    const body = await inner.text(u);
    if (looksBlocked(200, body)) throw new Error('blocked (block page instead of the document)');
    return body;
  },
};

const norm = (s: string) => s.toLowerCase().replace(/&amp;/g, '&').replace(/\b(the|limited|ltd)\b/g, '').replace(/[^a-z0-9]/g, '');
const months = (a: string, b: string) => (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + Number(b.slice(5, 7)) - Number(a.slice(5, 7)) + 1;

interface Filed { f: IntegratedFiling; url: string; at: number }
const pdfs = new Map<string, string>(); // company (normalised title) -> PDF link
const filings = new Map<string, { cons?: Filed; stand?: Filed }>(); // company -> quarterly filings
const seenXbrl = new Set<string>();
const done = new Set<string>();

function readExpected(): Record<string, Record<string, unknown>> {
  return existsSync(`${dir}expected.json`) ? JSON.parse(readFileSync(`${dir}expected.json`, 'utf8')) : {};
}

async function pollFilings(): Promise<void> {
  const items = await fetchNseRss(http, 'Integrated_Filing');
  for (const item of items) {
    if (!/financials/i.test(item.description) || seenXbrl.has(item.link)) continue;
    const url = resolveIntegratedFilingUrl(item.link);
    let f: IntegratedFiling;
    try {
      f = parseIntegratedFiling(await http.text(url));
    } catch {
      continue; // not up yet (the XBRL lags the feed): retried next minute
    }
    seenXbrl.add(item.link);
    if (!f.periodStart || !f.periodEnd || months(f.periodStart, f.periodEnd) !== 3) continue;
    const key = norm(item.title);
    const e = filings.get(key) ?? {};
    e[f.nature === 'Consolidated' ? 'cons' : 'stand'] = { f, url, at: Date.now() };
    filings.set(key, e);
  }
}

async function pollAnnouncements(): Promise<void> {
  const items: RssItem[] = await fetchNseRss(http, 'Online_announcements');
  for (const item of items) {
    const { subject } = parseAnnouncementDescription(item.description);
    if (!/\.pdf$/i.test(item.link) || !isResultSubject(subject)) continue;
    const key = norm(item.title);
    if (!pdfs.has(key)) pdfs.set(key, item.link);
  }
}

async function pairUp(): Promise<void> {
  const expected = readExpected();
  for (const [key, fx] of filings) {
    const link = pdfs.get(key);
    if (!link || done.has(key)) continue;
    const use = fx.cons ?? (fx.stand && Date.now() - fx.stand.at > STANDALONE_GRACE_MS ? fx.stand : undefined);
    if (!use) continue;
    done.add(key);
    const file = link.split('/').pop()!.replace(/^nsearchives\.nseindia\.com/, '').replace(/\.PDF$/, '.pdf');
    if (expected[file]) continue;
    let bytes: Uint8Array;
    try {
      await gate();
      bytes = await fetchResultsPdf(link, BROWSER_UA);
    } catch (err) {
      console.log(`skip ${file}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (bytes.length > MAX_PDF) { console.log(`skip ${file}: ${(bytes.length / 1e6).toFixed(1)} MB`); continue; }
    const f = use.f;
    writeFileSync(`${dir}${file}`, bytes);
    expected[file] = {
      symbol: f.symbol, quarterEnd: f.periodEnd, type: /BANKING/.test(use.url) ? 'bank' : /NBFC/.test(use.url) ? 'nbfc' : 'company',
      basis: f.nature, eps: f.eps, revenue: f.isBank ? f.totalIncome : f.revenueFromOperations, revenueKind: f.revenueKind,
      profit: f.profitLoss, xbrl: [fx.cons?.url, fx.stand?.url].filter(Boolean).map((u) => u!.split('/').pop()),
    };
    writeFileSync(`${dir}expected.json`, JSON.stringify(Object.fromEntries(Object.entries(expected).sort(([a], [b]) => a.localeCompare(b))), null, 2) + '\n');
    console.log(`added ${file} (${f.symbol}, ${f.nature})`);
  }
}

const end = Date.now() + minutes * 60_000;
for (let tick = 0; Date.now() < end; tick++) {
  try {
    if (tick % 5 === 0) await pollAnnouncements();
    await pollFilings();
    await pairUp();
  } catch (err) {
    console.error(`[collect] ${err instanceof Error ? err.message : String(err)}`);
  }
  console.log(`${new Date().toISOString()} pdfs ${pdfs.size}, filings ${filings.size}, paired ${done.size}`);
  await new Promise((r) => setTimeout(r, 60_000));
}
