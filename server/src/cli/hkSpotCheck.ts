/**
 * Live HK spot-check against a COPY of the database (Task 14).
 *   npm run hk-spot-check -w server -- --db <copy.db> [--codes 9988,0005,9618,9999,2378,0700,1299,0941,2318,1810]
 * Runs `warmUpHk` once with a real HkJobContext (Yahoo at 1 req/s across all Yahoo calls, its own SEC client at
 * 120 ms, Cboe at 2500 ms), then prints what each code shows. Nothing else runs: no prices, no watchers, no Kite.
 * The expected move is printed as stored; for full-level codes it is also computed from the current chain
 * (Ruling 6) without storing it. Refuses the production database (`config.dbPath`).
 */
import { resolve } from 'node:path';
import { config } from '../config.js';
import { createJobRunner } from '../jobs/scheduler.js';
import { openDb } from '../db/repo.js';
import { computeExpectedMove } from '../domain/expectedMove.js';
import { HKT, todayHKT, addDaysHKT } from '../hk/domain/hkCalendar.js';
import { firstUsSessionAfterHkRelease } from '../hk/domain/hkMoves.js';
import { hkStocks, listHkForSymbols, type HkReport } from '../hk/db/hkRepo.js';
import type { HkJobContext } from '../hk/jobs/context.js';
import { warmUpHk } from '../hk/jobs/scheduler.js';
import { createYahooHkFetcher, yahooHkPastDates } from '../hk/sources/yahooHk.js';
import { fetchCboeChain } from '../sources/cboe.js';
import { BROWSER_UA, makeHttp } from '../sources/http.js';
import { fetchEarningsFilings } from '../sources/sec.js';
import { fetchStockQuote, fetchYahooDailyCloses } from '../sources/yahoo.js';
import { ensureWatchSchema } from '../watchlist/store.js';

const DEFAULT_CODES = ['9988', '0005', '9618', '9999', '2378', '0700', '1299', '0941', '2318', '1810'];

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

/** One Yahoo request a second across every Yahoo call this script makes. */
let yahooSlot = 0;
async function yahooGate<T>(fn: () => Promise<T>): Promise<T> {
  const slot = Math.max(Date.now(), yahooSlot);
  yahooSlot = slot + 1000;
  if (slot > Date.now()) await new Promise((r) => setTimeout(r, slot - Date.now()));
  return fn();
}

const db = openDb(dbArg);
const watchCount = () => db.prepare('SELECT market, COUNT(*) AS n FROM watchlists GROUP BY market ORDER BY market').all() as { market: string; n: number }[];
const watchBefore = watchCount();
ensureWatchSchema(db);
console.log(`watchlists before ${JSON.stringify(watchBefore)} after ${JSON.stringify(watchCount())}`);

const yahooHttp = makeHttp({ minIntervalMs: 1000, headers: { 'User-Agent': BROWSER_UA } });
const cboe = makeHttp({ minIntervalMs: 2500, backoffMs: 15_000, headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' } });
const secHttp = config.secUserAgent ? makeHttp({ minIntervalMs: 120, headers: { 'User-Agent': config.secUserAgent } }) : null;
if (!secHttp) console.log('SEC_USER_AGENT not set: full-level SEC features off');

const summary = createYahooHkFetcher();
const ctx: HkJobContext = {
  db,
  now: () => new Date().toISOString(),
  todayHKT,
  yahoo: (s) => yahooGate(() => summary(s)),
  yahooPastDates: (s) => yahooGate(() => yahooHkPastDates(s)),
  yahooCloses: (s, f, t) => yahooGate(() => fetchYahooDailyCloses(yahooHttp, s, f, t, HKT)),
  optionChain: (adr) => fetchCboeChain(cboe, adr),
  secHttp,
};

const started = Date.now();
await warmUpHk(ctx, createJobRunner({ db, now: ctx.now } as unknown as Parameters<typeof createJobRunner>[0]));
console.log(`warm-up done in ${Math.round((Date.now() - started) / 1000)}s; reader gate hkEps=${config.fastFields.hkEps} hkRevenue=${config.fastFields.hkRevenue}`);

const today = todayHKT();
const fmt = (n: number | null | undefined, d = 2) => (n == null ? 'blank' : Number(n).toLocaleString('en-US', { maximumFractionDigits: d }));

function printReport(tag: string, r: HkReport): void {
  console.log(`  ${tag} ${r.periodLabel} (${r.periodKind}, period end ${r.periodEnd}) id ${r.id}`);
  console.log(`    date ${r.reportDate} ${r.dateStatus}${r.rescheduledFrom ? ` (was ${r.rescheduledFrom})` : ''}; timing ${r.timing} via ${r.timingSource ?? 'blank'}; released ${r.releasedAt ?? 'no'}`);
  console.log(`    estimates eps ${fmt(r.epsEstimate, 4)} (${r.epsAnalysts ?? '-'} analysts) revenue ${fmt(r.revenueEstimate, 0)} (${r.revenueAnalysts ?? '-'}) currency ${r.estimateCurrency ?? 'blank'}`);
  console.log(`    actuals eps ${fmt(r.epsActual, 4)} ${r.epsCurrency ?? ''} per ${r.epsBasis ?? '-'}; revenue ${fmt(r.revenueActual, 0)} ${r.revenueCurrency ?? ''}; source ${r.actualSource ?? 'blank'}${r.secDocUrl ? ` ${r.secDocUrl}` : ''}`);
  const em = r.expectedMove;
  console.log(`    expected move (stored) ${em ? `${fmt(em.movePct)}% ${em.final ? 'final' : 'provisional'} expiry ${em.expiry} quotes ${em.quoteDate}${em.illiquid ? ' illiquid' : ''}` : 'blank'}`);
  console.log(`    previous move ${r.prevMovePct == null ? 'blank' : `${fmt(r.prevMovePct)}% on ${r.prevMoveDate} (${r.prevMoveBasis})`}`);
}

const stocks = new Map(hkStocks(db).map((s) => [s.code, s]));
for (const code of codes) {
  const s = stocks.get(code);
  if (!s) { console.log(`\n${code}: not in the universe`); continue; }
  console.log(`\n${code} ${s.name} | level ${s.level}${s.adr ? ` | ADR ${s.adr} (${s.adrRatio} sh/ADS, CIK ${s.cik})` : ''} | cadence ${s.cadence} FY-end month ${s.fyEndMonth}`);
  console.log(`  market cap HK$ ${fmt(s.marketCap, 0)} as of ${s.marketCapAsOf ?? 'blank'}; sector ${s.sector ?? 'blank'}`);
  const rows = listHkForSymbols(db, [code], addDaysHKT(today, -200), addDaysHKT(today, 200));
  const last = rows.filter((r) => r.reportDate < today || r.releasedAt).at(-1);
  const next = rows.find((r) => r.reportDate >= today && !r.releasedAt);
  if (last) printReport('last', last);
  if (next) printReport('next', next);
  if (!last && !next) console.log('  no report rows');
  if (s.level === 'full' && s.adr && next) {
    const chain = await fetchCboeChain(cboe, s.adr).catch((e: Error) => { console.log(`  cboe error ${e.message}`); return null; });
    const em = chain && computeExpectedMove(chain, firstUsSessionAfterHkRelease(next.reportDate, next.timing, next.releasedAt), 'BMO');
    console.log(`  expected move (computed now, not stored) ${em ? `${fmt(em.movePct)}% expiry ${em.expiry} strike ${em.strike} ADR ${fmt(chain!.underlying)} quotes ${chain!.asOfDate}` : 'blank'}`);
  }
  const q = await yahooGate(() => fetchStockQuote(yahooHttp, s.yahooSymbol)).catch((e: Error) => { console.log(`  yahoo quote error ${e.message}`); return null; });
  console.log(`  Yahoo price now HK$ ${q ? `${fmt(q.price, 3)} (prev close ${fmt(q.prevClose, 3)}, ${new Date(q.time).toISOString()})` : 'blank'}`);
  if (s.level === 'full' && s.cik && secHttp) {
    const filings = await fetchEarningsFilings(secHttp, s.cik).catch((e: Error) => { console.log(`  sec error ${e.message}`); return []; });
    const latest = filings.filter((f) => f.form === '6-K').sort((a, b) => b.filingDate.localeCompare(a.filingDate))[0]
      ?? filings.sort((a, b) => b.filingDate.localeCompare(a.filingDate))[0];
    console.log(`  latest SEC ${latest ? `${latest.form} ${latest.filingDate} ${latest.indexUrl}` : 'filing: blank'}`);
  }
}
db.close();
