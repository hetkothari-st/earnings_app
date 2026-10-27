/**
 * Live Japan spot-check against a COPY of the database (Task 15).
 *   npm run jp-spot-check -w server -- --db <copy.db> [--codes 7203,6758,8306,4502,7267,9984,6861,9983,8035,3382] [--raw-dir <dir>]
 * Runs `warmUpJp` once with a real JpJobContext (one `createYahooClient()` at 1 req/s, its own SEC client at 120 ms,
 * Cboe at 2500 ms, EDINET only when EDINET_API_KEY is set), then prints what each code shows. Nothing else runs: no
 * prices, no watchers, no Kite. Refuses the production database (`config.dbPath`, or any `data/earnings.db`).
 *
 * Yahoo budget: the universe sync (EDINET code list) covers every listed code, but every Yahoo call is limited to the
 * sample `--codes`: batch quotes, summaries and closes for other symbols return nothing without a request, and the
 * calendar is asked for the sample tickers only. After the warm-up the date sweep runs once more over the whole
 * universe (other codes cost no request) so that every sample code gets its summary, then estimates, results,
 * previous moves and the expected-move snapshot run again for the sample (summaries are cached).
 * `--raw-dir` saves every raw Yahoo / Cboe response for hand comparison.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { config } from '../config.js';
import { createJobRunner } from '../jobs/scheduler.js';
import { openDb } from '../db/repo.js';
import { firstUsSessionAfterRelease } from '../domain/adrSessions.js';
import { computeExpectedMove } from '../domain/expectedMove.js';
import { jpStocks, listJpForSymbols, type JpReport } from '../jp/db/jpRepo.js';
import { addDaysJST, JST, todayJST } from '../jp/domain/jpCalendar.js';
import type { JpJobContext } from '../jp/jobs/context.js';
import { refreshJpCalendar } from '../jp/jobs/calendar.js';
import { refreshJpEstimates } from '../jp/jobs/estimates.js';
import { snapshotJpMoves } from '../jp/jobs/moves.js';
import { computeJpPrevMoves } from '../jp/jobs/prevMoves.js';
import { refreshJpYahooResults } from '../jp/jobs/results.js';
import { warmUpJp } from '../jp/jobs/scheduler.js';
import { fetchEdinetCodeList, makeEdinetClient } from '../jp/sources/edinet.js';
import { createYahooJpSummary, fetchYahooQuotes, parseYahooCalendarPage, type YahooCalRow } from '../jp/sources/yahooJp.js';
import { yahooJpSymbol } from '../jp/universe.js';
import { fetchCboeChain } from '../sources/cboe.js';
import { BROWSER_UA, type Http, makeHttp } from '../sources/http.js';
import { fetchEarningsFilings } from '../sources/sec.js';
import { fetchYahooDailyCloses } from '../sources/yahoo.js';
import { createYahooClient, type YahooClient } from '../sources/yahooClient.js';
import { ensureWatchSchema } from '../watchlist/store.js';

const DEFAULT_CODES = ['7203', '6758', '8306', '4502', '7267', '9984', '6861', '9983', '8035', '3382'];

const arg = (name: string): string | null => {
  const at = process.argv.indexOf(name);
  return at >= 0 && process.argv[at + 1] ? process.argv[at + 1]! : null;
};

const dbArg = arg('--db');
if (!dbArg) {
  console.error('--db <copy.db> is required (copy data/earnings.db first)');
  process.exit(1);
}
const same = (a: string, b: string) => resolve(a).toLowerCase() === resolve(b).toLowerCase();
// Also any `data/earnings.db` (another checkout's production file, e.g. when run from a worktree).
if (same(dbArg, config.dbPath) || /[\\/]data[\\/]earnings\.db$/i.test(resolve(dbArg))) {
  console.error(`refusing the production database ${config.dbPath}: pass a copy`);
  process.exit(1);
}
const codes = (arg('--codes') ?? DEFAULT_CODES.join(',')).split(',').map((c) => c.trim()).filter(Boolean);
const sample = new Set(codes);
const sampleSymbols = new Set(codes.map(yahooJpSymbol));
const rawDir = arg('--raw-dir');
if (rawDir) mkdirSync(rawDir, { recursive: true });

/** Saves a raw response under --raw-dir (the URL, never a crumb or key, names the file). */
function saveRaw(kind: string, url: string, json: unknown): void {
  if (!rawDir) return;
  const name = `${kind}-${url.replace(/^https?:\/\//, '').replace(/[?&]crumb=[^&]*/g, '').replace(/[^A-Za-z0-9.^-]+/g, '_').slice(0, 150)}.json`;
  writeFileSync(join(rawDir, name), JSON.stringify(json, null, 1));
}
const teeHttp = <T extends Http>(kind: string, h: T): T => ({
  ...h,
  json: async (url: string) => { const j = await h.json(url); saveRaw(kind, url, j); return j; },
});

const db = openDb(dbArg);
const watchCount = () => db.prepare('SELECT market, COUNT(*) AS n FROM watchlists GROUP BY market ORDER BY market').all() as { market: string; n: number }[];
const watchBefore = watchCount();
ensureWatchSchema(db);
console.log(`watchlists before ${JSON.stringify(watchBefore)} after ${JSON.stringify(watchCount())}`);

const yahooRaw = createYahooClient();
const yahoo: YahooClient = {
  ...teeHttp('yahoo', yahooRaw),
  postJson: async (url, body) => { const j = await yahooRaw.postJson(url, body); saveRaw('yahoo-post', `${url}-${codes.join('_')}`, j); return j; },
};
const cboe = teeHttp('cboe', makeHttp({ minIntervalMs: 2500, backoffMs: 15_000, headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' } }));
const secHttp = config.secUserAgent ? makeHttp({ minIntervalMs: 120, headers: { 'User-Agent': config.secUserAgent } }) : null;
if (!secHttp) console.log('SEC_USER_AGENT not set: full-level SEC features off');
const edinetKey = config.edinetApiKey !== '';
console.log(`EDINET key configured: ${edinetKey ? 'yes' : 'no'}`);

/** The bulk calendar for the sample tickers only (Ruling 11 date mapping via the shared page parser). */
async function sampleCalendar(from: string, to: string): Promise<{ rows: YahooCalRow[]; complete: boolean }> {
  try {
    const json = await yahoo.postJson('https://query1.finance.yahoo.com/v1/finance/visualization', {
      size: 100, offset: 0, sortField: 'startdatetime', sortType: 'ASC', entityIdType: 'earnings',
      includeFields: ['ticker', 'companyshortname', 'startdatetime', 'startdatetimetype', 'epsestimate', 'epsactual'],
      query: { operator: 'and', operands: [
        { operator: 'gte', operands: ['startdatetime', addDaysJST(from, -1)] },
        { operator: 'lt', operands: ['startdatetime', addDaysJST(to, 2)] },
        { operator: 'or', operands: [...sampleSymbols].map((t) => ({ operator: 'eq', operands: ['ticker', t] })) },
      ] },
    });
    return { rows: parseYahooCalendarPage(json).rows.filter((r) => r.date >= from && r.date <= to), complete: true };
  } catch {
    return { rows: [], complete: false };
  }
}

const summary = createYahooJpSummary(yahoo);
const ctx: JpJobContext = {
  db,
  now: () => new Date().toISOString(),
  todayJST,
  yahooCalendar: sampleCalendar,
  yahooSummary: (s, maxAge) => (sampleSymbols.has(s) ? summary(s, maxAge) : Promise.resolve(null)),
  yahooQuotes: async (s) => {
    const mine = s.filter((x) => sampleSymbols.has(x));
    return mine.length ? fetchYahooQuotes(yahoo, mine) : new Map();
  },
  yahooCloses: async (s, f, t) => (sampleSymbols.has(s) ? fetchYahooDailyCloses(yahoo, s, f, t, JST) : new Map()),
  edinetCodeList: () => fetchEdinetCodeList(),
  edinet: edinetKey ? makeEdinetClient({ key: config.edinetApiKey }) : null,
  optionChain: (adr) => fetchCboeChain(cboe, adr),
  secHttp,
  tierA: () => codes,
};

const job = createJobRunner({ db, now: ctx.now } as unknown as Parameters<typeof createJobRunner>[0]);
const started = Date.now();
await warmUpJp(ctx, job);
console.log(`warm-up done in ${Math.round((Date.now() - started) / 1000)}s`);
// The warm-up's date sweep takes at most 90 due codes: sweep the rest (no request outside the sample), then the jobs
// that read the new rows.
await job('jp-calendar', () => refreshJpCalendar(ctx, { perRun: 100_000 }))();
await job('jp-estimates', () => refreshJpEstimates(ctx))();
await job('jp-results', async () => { await refreshJpYahooResults(ctx); })();
await job('jp-prev-moves', () => computeJpPrevMoves(ctx))();
await job('jp-moves', async () => { await snapshotJpMoves(ctx); })();
console.log(`sample pass done in ${Math.round((Date.now() - started) / 1000)}s; reader gate jpEps=${config.fastFields.jpEps} jpRevenue=${config.fastFields.jpRevenue}`);
const active = jpStocks(db).filter((s) => s.active);
console.log(`universe: ${active.length} active codes (${active.filter((s) => s.level === 'full').length} full level)`);
for (const e of db.prepare("SELECT source, last_error, last_error_at FROM source_status WHERE (source LIKE '%jp%' OR source LIKE 'edinet%' OR source = 'cboe') AND last_error IS NOT NULL").all() as Record<string, unknown>[]) {
  console.log(`source error ${JSON.stringify(e)}`);
}

const today = todayJST();
const fmt = (n: number | null | undefined, d = 2) => (n == null ? 'blank' : Number(n).toLocaleString('en-US', { maximumFractionDigits: d }));
const span = (s: string | null, m: number | null) => (s == null ? '' : s === 'ytd' ? `ytd ${m}` : s);

function printReport(tag: string, r: JpReport): void {
  console.log(`  ${tag} ${r.periodLabel} (Q${r.fiscalQuarter}, period end ${r.periodEnd}, FY end ${r.fyEnd}) id ${r.id}`);
  console.log(`    date ${r.reportDate} ${r.dateStatus}${r.rescheduledFrom ? ` (was ${r.rescheduledFrom})` : ''}; timing ${r.timing} via ${r.timingSource ?? 'blank'}; released ${r.releasedAt ?? 'no'}`);
  console.log(`    estimates eps ${fmt(r.epsEstimate, 4)} (${r.epsAnalysts ?? '-'} analysts) revenue ${fmt(r.revenueEstimate, 0)} (${r.revenueAnalysts ?? '-'}) currency ${r.estimateCurrency ?? 'blank'} span ${r.estimateSpan ?? 'blank'}`);
  console.log(`    actuals eps ${fmt(r.epsActual, 4)} diluted ${fmt(r.epsDilutedActual, 4)} ${r.epsCurrency ?? ''} source ${r.epsSource ?? 'blank'} ${span(r.epsSpan, r.epsYtdMonths)}`);
  console.log(`    actuals revenue ${fmt(r.revenueActual, 0)} ${r.revenueCurrency ?? ''} source ${r.revenueSource ?? 'blank'} ${span(r.revenueSpan, r.revenueYtdMonths)}${r.secDocUrl ? `; SEC ${r.secDocUrl}` : ''}; EDINET docID ${r.edinetDocId ?? 'blank'}`);
  const em = r.expectedMove;
  console.log(`    expected move (stored) ${em ? `${fmt(em.movePct)}% ${em.final ? 'final' : 'provisional'} expiry ${em.expiry} quotes ${em.quoteDate} ADR ${em.adr}` : 'blank'}`);
  console.log(`    previous move ${r.prevMovePct == null ? 'blank' : `${fmt(r.prevMovePct)}% on ${r.prevMoveDate} (${r.prevMoveBasis})`}`);
}

const stocks = new Map(jpStocks(db).map((s) => [s.code, s]));
for (const code of codes) {
  const s = stocks.get(code);
  if (!s) { console.log(`\n${code}: not in the universe`); continue; }
  console.log(`\n${code} ${s.name} (${s.nameJa ?? '-'}) | level ${s.level}${s.adr ? ` | ADR ${s.adr} (${s.adrRatio} sh/ADS, CIK ${s.cik})` : ''} | FY-end month ${s.fyEndMonth} | ${s.industryJa ?? '-'}`);
  console.log(`  market cap ¥ ${fmt(s.marketCap, 0)} as of ${s.marketCapAsOf ?? 'blank'}; sector ${s.sector ?? 'blank'} / ${s.industry ?? 'blank'}`);
  const rows = listJpForSymbols(db, [code], addDaysJST(today, -200), addDaysJST(today, 200));
  for (const r of rows) printReport(r.reportDate < today || r.releasedAt ? 'last' : 'next', r);
  if (!rows.length) console.log('  no report rows');
  const next = rows.find((r) => r.reportDate >= today && !r.releasedAt);
  if (s.level === 'full' && s.adr && next) {
    const chain = await fetchCboeChain(cboe, s.adr).catch((e: Error) => { console.log(`  cboe error ${e.message}`); return null; });
    const em = chain && computeExpectedMove(chain, firstUsSessionAfterRelease(next.reportDate, next.timing, next.releasedAt), 'BMO');
    console.log(`  expected move (computed now, not stored) ${em ? `${fmt(em.movePct)}% expiry ${em.expiry} strike ${em.strike} ADR ${fmt(chain!.underlying)} quotes ${chain!.asOfDate}` : 'blank'}`);
  }
  if (s.level === 'full' && s.cik && secHttp) {
    const filings = await fetchEarningsFilings(secHttp, s.cik).catch((e: Error) => { console.log(`  sec error ${e.message}`); return []; });
    const latest = filings.filter((f) => f.form === '6-K').sort((a, b) => b.filingDate.localeCompare(a.filingDate))[0];
    console.log(`  latest SEC 6-K ${latest ? `${latest.filingDate} ${latest.indexUrl}` : 'blank'}`);
  }
  console.log(`  EDINET key configured: ${edinetKey ? 'yes' : 'no'}`);
}
db.close();
