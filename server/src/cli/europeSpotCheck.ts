/**
 * Live UK / Europe spot-check against a COPY of the database (Task 21).
 *   npm run europe-spot-check -w server -- --market uk|eu --db <copy.db> [--symbols AZN.L,HSBA.L,...]
 *     [--universe-limit N] [--isins GB0030913577,...] [--env <path to .env with SEC_USER_AGENT>]
 *
 * Runs `warmUpEurope` once against the copy with a real context: one Yahoo client on `yahooLimiter`, its own SEC
 * client at 120 ms (null without SEC_USER_AGENT), Cboe at 2,500 ms through the 15-minute cache, OpenFIGI keyless unless
 * OPENFIGI_API_KEY is set, ESEF and gov.uk as production. Then `TradegatePoller.tick()` once per listed symbol (one
 * request per second, after the robots.txt check) and one Yahoo price tick. No watchers, no Kite, no PR Newswire or
 * DILA (they are not part of the warm-up). Refuses the production database (`config.dbPath`, or any `data/earnings.db`).
 *
 * Universe budget (`--universe-limit N`, default 300): both FIRDS sets are read in full, then the build only sees the
 * ISINs that cost no new OpenFIGI / ISIN-search request (the full-level ISINs, `--isins`, the SIX list, ISINs whose
 * every line is already cached in `europe_figi`) plus the first N other ISINs with a line in this market. An ISIN is
 * kept or dropped with all its lines, so the UK-first tie-break is unchanged for every kept ISIN. The full mapping
 * happens in production. `--isins` only puts ISINs in the budget; the symbol a listed ISIN gets still comes from
 * OpenFIGI (and the Yahoo ISIN search), never from this script.
 *
 * Yahoo budget: summaries and daily closes are asked for the listed symbols only (other symbols get nothing, without a
 * request); batch quotes and the bulk calendar run as in production. The sweep progress of the listed symbols is reset
 * on the copy, and after the warm-up the date sweep runs once more over the whole universe (other symbols cost no
 * request), then estimates, Yahoo results, the SEC sweep, previous moves and the moves snapshot again, so every listed symbol is read.
 *
 * Secrets: the SEC User-Agent and the OpenFIGI key are never printed; only "configured yes/no".
 */
import { resolve } from 'node:path';
import type { FirdsShare } from '../europe/sources/firds.js';
import type { EuropeJobContext, EuropeUniverseSources } from '../europe/jobs/context.js';
import type { EuropeMarket } from '../europe/exchanges.js';
import type { EuropeReport } from '../europe/db/europeRepo.js';

const arg = (name: string): string | null => {
  const at = process.argv.indexOf(name);
  return at >= 0 && process.argv[at + 1] ? process.argv[at + 1]! : null;
};

// The .env must be loaded before config.ts is evaluated, so every app module is imported after this line.
const envFile = arg('--env');
if (envFile) process.loadEnvFile(envFile);

const { config } = await import('../config.js');
const { openDb } = await import('../db/repo.js');
const { createJobRunner } = await import('../jobs/scheduler.js');
const { createSources } = await import('../sources/index.js');
const { todayET } = await import('../domain/marketCalendar.js');
const { BROWSER_UA, makeHttp } = await import('../sources/http.js');
const { fetchCboeChain } = await import('../sources/cboe.js');
const { cachedChains } = await import('../sources/cboeCache.js');
const { fetchEarningsFilings } = await import('../sources/sec.js');
const { fetchIndexQuote, fetchYahooDailyCloses } = await import('../sources/yahoo.js');
const { createYahooClient } = await import('../sources/yahooClient.js');
const { createSlotLimiter, yahooLimiter } = await import('../sources/yahooLimiter.js');
const { ensureWatchSchema } = await import('../watchlist/store.js');
const { europeStocks, figiCached, listEuropeForSymbols } = await import('../europe/db/europeRepo.js');
const { addDaysEurope } = await import('../europe/jobs/estimates.js');
const { marketToday } = await import('../europe/domain/calendars.js');
const { EXCHANGES, exchangesOf, UNIVERSE_URLS } = await import('../europe/exchanges.js');
const { buildEuropeUniverseFor } = await import('../europe/jobs/context.js');
const { refreshEuropeCalendar } = await import('../europe/jobs/calendar.js');
const { refreshEuropeEstimates } = await import('../europe/jobs/estimates.js');
const { refreshEuropeYahooResults } = await import('../europe/jobs/results.js');
const { computeEuropePrevMoves } = await import('../europe/jobs/prevMoves.js');
const { snapshotEuropeMoves } = await import('../europe/jobs/moves.js');
const { sweepEuropeSec } = await import('../europe/jobs/secSweep.js');
const { warmUpEurope } = await import('../europe/jobs/scheduler.js');
const { EuropePrices } = await import('../europe/live/europePrices.js');
const { TradegatePoller } = await import('../europe/live/tradegatePoller.js');
const { createEsefClient } = await import('../europe/sources/esef.js');
const { fetchFirdsShares, makeFirdsHttp } = await import('../europe/sources/firds.js');
const { fetchLegalNames } = await import('../europe/sources/gleif.js');
const { createOpenFigi } = await import('../europe/sources/openFigi.js');
const { parsePrnRss } = await import('../europe/sources/prnewswire.js');
const { EUROPE_UA, GOVUK_BANK_HOLIDAYS_URL, PRN_FEEDS } = await import('../europe/sources/sourceUrls.js');
const { createTradegate } = await import('../europe/sources/tradegate.js');
const { createYahooEuropeSummary, defaultZoneOf, fetchEuropeEarningsCalendar, fetchEuropeQuotes, yahooIsinSearch } =
  await import('../europe/sources/yahooEurope.js');
const { EU_FULL, UK_FULL } = await import('../europe/universe.js');

const DEFAULT_SYMBOLS: Record<EuropeMarket, string[]> = {
  UK: ['AZN.L', 'HSBA.L', 'SHEL.L', 'VOD.L', 'BT-A.L', 'TSCO.L'],
  EU: ['ASML.AS', 'SAP.DE', 'NOVO-B.CO', 'TTE.PA', 'SAN.MC', 'NESN.SW', 'VOLV-B.ST', 'ENI.MI'],
};

const marketArg = (arg('--market') ?? '').toUpperCase();
if (marketArg !== 'UK' && marketArg !== 'EU') {
  console.error('--market uk|eu is required');
  process.exit(1);
}
const market: EuropeMarket = marketArg;
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
const symbols = (arg('--symbols') ?? DEFAULT_SYMBOLS[market].join(',')).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const sample = new Set(symbols);
const limitArg = Number(arg('--universe-limit') ?? 300);
const universeLimit = Number.isInteger(limitArg) && limitArg >= 0 ? limitArg : 300;
const hintIsins = new Set((arg('--isins') ?? '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean));

const db = openDb(dbArg);
const watchCount = () => db.prepare('SELECT market, COUNT(*) AS n FROM watchlists GROUP BY market ORDER BY market').all() as { market: string; n: number }[];
const watchBefore = watchCount();
ensureWatchSchema(db);
console.log(`watchlists before ${JSON.stringify(watchBefore)} after ${JSON.stringify(watchCount())}`);
console.log(`market ${market}; symbols ${symbols.join(',')}; universe limit ${universeLimit} new ISINs`);

// ---------- Clients (as index.ts, on their own instances) ----------
const yahoo = createYahooClient({ limiter: yahooLimiter });
const cboe = makeHttp({ minIntervalMs: 2500, backoffMs: 15_000, headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' } });
const chains = cachedChains((adr) => fetchCboeChain(cboe, adr));
const secHttp = config.secUserAgent ? makeHttp({ minIntervalMs: 120, headers: { 'User-Agent': config.secUserAgent } }) : null;
console.log(`SEC_USER_AGENT configured: ${secHttp ? 'yes' : 'no (full-level SEC features off)'}`);
const openFigiKey = config.openFigiApiKey !== '';
console.log(`OpenFIGI key configured: ${openFigiKey ? 'yes' : 'no (keyless)'}`);
const europeLimiter = createSlotLimiter(1000);
const europeHttp = makeHttp({ minIntervalMs: 1000, headers: { 'User-Agent': EUROPE_UA }, limiter: europeLimiter });
const firdsHttp = makeFirdsHttp();
const openFigi = createOpenFigi({ key: config.openFigiApiKey || undefined });
const tradegate = createTradegate({ enabled: config.tradegatePrices });

// ---------- Limited universe sources ----------
const micsOf = (m: EuropeMarket) => new Set(exchangesOf(m).flatMap((id) => EXCHANGES[id].mics));
const exchCodeOfMic = new Map<string, string>(Object.values(EXCHANGES).flatMap((e) => Object.entries(e.micExchCodes)));
const ownMics = micsOf(market);
const freeIsins = new Set([...UK_FULL, ...EU_FULL].map((e) => e.isin).concat([...hintIsins]));

let firdsRead: Promise<{ fca: FirdsShare[]; esma: FirdsShare[]; done: { fca: { files: number; complete: boolean }; esma: { files: number; complete: boolean } }; keep: Set<string> }> | null = null;
function readFirds() {
  firdsRead ??= (async () => {
    const fca: FirdsShare[] = [];
    const esma: FirdsShare[] = [];
    const fail = (err: unknown) => { console.warn(`FIRDS failed: ${(err as Error).message}`); return { files: 0, complete: false }; };
    const doneFca = await fetchFirdsShares(firdsHttp, 'fca', micsOf('UK'), (s) => fca.push(s)).catch(fail);
    const doneEsma = await fetchFirdsShares(firdsHttp, 'esma', micsOf('EU'), (s) => esma.push(s)).catch(fail);
    const byIsin = new Map<string, FirdsShare[]>();
    for (const s of [...fca, ...esma]) byIsin.set(s.isin, [...(byIsin.get(s.isin) ?? []), s]);
    const keep = new Set<string>();
    let budget = universeLimit;
    let cached = 0;
    for (const [isin, lines] of byIsin) {
      if (freeIsins.has(isin)) { keep.add(isin); continue; }
      const figiLines = lines.filter((l) => l.mic !== 'XSWX' && exchCodeOfMic.has(l.mic));
      if (figiLines.length > 0 && figiLines.every((l) => figiCached(db, isin, exchCodeOfMic.get(l.mic)!) != null)) {
        keep.add(isin); cached++; continue;
      }
      if (budget > 0 && lines.some((l) => ownMics.has(l.mic))) { keep.add(isin); budget--; }
    }
    console.log(`FIRDS: ${fca.length} FCA + ${esma.length} ESMA share lines, ${byIsin.size} ISINs; kept ${keep.size} (${universeLimit - budget} new within the limit, ${cached} cached, the rest full-level or --isins)`);
    return { fca, esma, done: { fca: doneFca, esma: doneEsma }, keep };
  })();
  return firdsRead;
}

let sixText: Promise<string> | null = null;
const universeSources: EuropeUniverseSources = {
  firds: async (source, mics, onShare) => {
    const r = await readFirds();
    for (const s of source === 'fca' ? r.fca : r.esma) if (mics.has(s.mic) && r.keep.has(s.isin)) onShare(s);
    return source === 'fca' ? r.done.fca : r.done.esma;
  },
  sixList: () => {
    sixText ??= europeHttp.text(UNIVERSE_URLS.sixList);
    sixText.catch(() => { sixText = null; });
    return sixText;
  },
  figi: (jobs) => {
    console.log(`OpenFIGI: ${jobs.length} new mapping jobs`);
    return openFigi.map(jobs);
  },
  search: (isin) => yahooIsinSearch(yahoo, isin),
  names: (leis) => fetchLegalNames(europeHttp, leis),
};

// ---------- Context ----------
const summary = createYahooEuropeSummary(yahoo);
const localZone = market === 'UK' ? 'Europe/London' : 'Europe/Paris';
const ctx: EuropeJobContext = {
  db,
  market,
  now: () => new Date().toISOString(),
  today: () => marketToday(market),
  yahooCalendar: (region, f, t) => fetchEuropeEarningsCalendar(yahoo, region, f, t, defaultZoneOf),
  yahooSummary: (s, maxAge) => (sample.has(s) ? summary(s, maxAge) : Promise.resolve(null)),
  yahooQuotes: (s) => fetchEuropeQuotes(yahoo, s),
  yahooCloses: (s, f, t) => (sample.has(s) ? fetchYahooDailyCloses(yahoo, s, f, t, defaultZoneOf(s) ?? localZone) : Promise.resolve(new Map())),
  buildUniverse: () => buildEuropeUniverseFor(db, market, universeSources, new Date().toISOString()),
  bankHolidaysJson: () => europeHttp.json(GOVUK_BANK_HOLIDAYS_URL),
  esef: createEsefClient(),
  prnFeed: async () => {
    const out = [];
    for (const url of PRN_FEEDS[market]) out.push(...parsePrnRss(await europeHttp.text(url)));
    return out;
  },
  dila: null, // not part of the warm-up
  optionChain: chains,
  secHttp,
  tierA: () => symbols,
};

// The listed symbols are swept again on this copy (an earlier spot run may have marked them checked).
const resetSweep = db.prepare('DELETE FROM europe_date_sweep WHERE symbol = ?');
for (const s of symbols) resetSweep.run(s);

// A full typed JobContext: the US sources are built but never called here (the runner only records failures in the db).
const job = createJobRunner({ db, sources: createSources(config), now: ctx.now, today: () => todayET() });
const p = market === 'UK' ? 'uk' : 'eu';
const started = Date.now();
await warmUpEurope(ctx, job);
console.log(`warm-up done in ${Math.round((Date.now() - started) / 1000)}s`);
await job(`${p}-calendar`, () => refreshEuropeCalendar(ctx, { perRun: 100_000 }))();
await job(`${p}-estimates`, () => refreshEuropeEstimates(ctx))();
await job(`${p}-results`, async () => { await refreshEuropeYahooResults(ctx); })();
await job(`${p}-sec-sweep`, async () => { await sweepEuropeSec(ctx); })(); // again, now that the listed symbols have a fiscal year end
await job(`${p}-prev-moves`, () => computeEuropePrevMoves(ctx))();
await job(`${p}-moves`, async () => { await snapshotEuropeMoves(ctx); })();
const gates = market === 'UK' ? `ukEps=${config.fastFields.ukEps} ukRevenue=${config.fastFields.ukRevenue}` : `euEps=${config.fastFields.euEps} euRevenue=${config.fastFields.euRevenue}`;
console.log(`sample pass done in ${Math.round((Date.now() - started) / 1000)}s; reader gate ${gates}`);

const all = europeStocks(db, market);
const active = all.filter((s) => s.active);
console.log(`universe: ${active.length} active ${market} symbols (${active.filter((s) => s.level === 'full').length} full level)`);
const byExchange = new Map<string, number>();
for (const s of active) byExchange.set(`${s.exchange}${s.mic ? `/${s.mic}` : ''}`, (byExchange.get(`${s.exchange}${s.mic ? `/${s.mic}` : ''}`) ?? 0) + 1);
console.log(`  by exchange/MIC ${JSON.stringify(Object.fromEntries([...byExchange].sort()))}`);
for (const e of db.prepare(`SELECT source, last_error, last_error_at FROM source_status
    WHERE (source LIKE '%-${p}%' OR source LIKE '%${p}-%' OR source IN ('esef', 'govuk-holidays', 'cboe', 'europe-holidays')) AND last_error IS NOT NULL`)
  .all() as Record<string, unknown>[]) {
  console.log(`source error ${JSON.stringify(e)}`);
}

// ---------- Prices: Tradegate once per listed symbol, then one Yahoo tick ----------
const stocks = new Map(all.map((s) => [s.symbol, s]));
const wanted = symbols.flatMap((s) => { const st = stocks.get(s); return st?.isin ? [{ symbol: s, isin: st.isin }] : []; });
const poller = new TradegatePoller(tradegate, () => wanted, () => {});
for (let i = 0; i < wanted.length + 1; i++) await poller.tick(); // the first tick is the robots.txt check
const tg = poller.snapshot();
console.log(`\nTradegate state ${tradegate.state()} (TRADEGATE_PRICES ${config.tradegatePrices ? 'on' : 'off'}); backoff until ${tradegate.backoffUntil() ?? '-'}; last poll ${tradegate.lastPollAt() ?? '-'}; quoted ${Object.keys(tg).length}/${wanted.length}`);
const prices = new EuropePrices(market, db, { quotes: (s) => fetchEuropeQuotes(yahoo, s), index: (s) => fetchIndexQuote(yahoo, s) },
  { snapshot: () => poller.snapshot(), state: () => tradegate.state() }, () => {}, () => {});
prices.setVisible('spot-check', symbols);
await prices.tick();
const live = prices.snapshot();
const yq = await fetchEuropeQuotes(yahoo, symbols).catch((e: Error) => { console.log(`yahoo quotes error ${e.message}`); return new Map(); });

// ---------- Per symbol ----------
const today = marketToday(market);
const fmt = (n: number | null | undefined, d = 2) => (n == null ? 'blank' : Number(n).toLocaleString('en-US', { maximumFractionDigits: d }));
const span = (s: string | null, m: number | null) => (s == null ? '' : s === 'ytd' ? `ytd ${m}` : s);

function printReport(tag: string, r: EuropeReport): void {
  console.log(`  ${tag} period ${r.periodConfirmed ? r.periodLabel : 'not stated'} (inferred ${r.periodLabel}, period end ${r.periodEnd}, FY end ${r.fyEnd}) id ${r.id}`);
  console.log(`    date ${r.reportDate} ${r.dateStatus}${r.rescheduledFrom ? ` (was ${r.rescheduledFrom})` : ''}; timing ${r.timing} via ${r.timing === 'UNKNOWN' ? 'blank' : r.timingSource ?? 'blank'}`);
  console.log(`    released ${r.releasedAt ? `${r.releasedAt} via ${r.releasedSource ?? 'blank'}${r.signalUrl ? ` (${r.signalTitle ?? ''} ${r.signalUrl})` : ''}` : 'no'}`);
  console.log(`    estimates eps ${fmt(r.epsEstimate, 4)} ${r.epsEstimateCurrency ?? ''} (${r.epsAnalysts ?? '-'} analysts) revenue ${fmt(r.revenueEstimate, 0)} ${r.revenueEstimateCurrency ?? ''} (${r.revenueAnalysts ?? '-'}) span ${r.estimateSpan ?? 'blank'}`);
  console.log(`    actuals eps ${fmt(r.epsActual, 4)} diluted ${fmt(r.epsDilutedActual, 4)} ${r.epsCurrency ?? ''} source ${r.epsSource ?? 'blank'} ${span(r.epsSpan, r.epsYtdMonths)}`);
  console.log(`    actuals revenue ${fmt(r.revenueActual, 0)} ${r.revenueCurrency ?? ''} source ${r.revenueSource ?? 'blank'} ${span(r.revenueSpan, r.revenueYtdMonths)}${r.secDocUrl ? `; SEC ${r.secDocUrl}` : ''}${r.esefUrl ? `; ESEF ${r.esefUrl}` : ''}`);
  const em = r.expectedMove;
  console.log(`    expected move ${em ? `${fmt(em.movePct)}% ${em.final ? 'final' : 'provisional'} expiry ${em.expiry} strike ${em.strike} ADR ${em.adr} ${fmt(em.underlying)} quotes ${em.quoteDate}` : 'blank'}`);
  console.log(`    previous move ${r.prevMovePct == null ? 'blank' : `${fmt(r.prevMovePct)}% on ${r.prevMoveDate} (${r.prevMoveBasis})`}`);
}

for (const symbol of symbols) {
  const s = stocks.get(symbol);
  if (!s) { console.log(`\n${symbol}: not in the universe`); continue; }
  console.log(`\n${symbol} ${s.name} | ISIN ${s.isin ?? '-'} | level ${s.level} | exchange ${s.exchange} (${s.mic ?? '-'}) ${s.active ? '' : '| INACTIVE '}| FY-end month ${s.fyEndMonth ?? 'blank'} (${s.fyEndSource ?? '-'})${s.adr ? ` | ADR ${s.adr} (${s.adrRatio} sh/ADS${s.adrRatioVerified ? '' : ', unverified'}, CIK ${s.cik}, ${s.secForm})` : ''}`);
  console.log(`  market cap ${fmt(s.marketCap, 0)} ${s.marketCapCurrency ?? ''} as of ${s.marketCapAsOf ?? 'blank'}`);
  const t = tg[symbol];
  const y = yq.get(symbol);
  const l = live[symbol];
  console.log(`  Tradegate ${t ? `last ${fmt(t.last, 4)} close ${fmt(t.close, 4)} EUR change ${fmt(t.changePct)}% at ${t.at}` : 'no quote'}; Yahoo ${y ? `${fmt(y.price, 4)} ${y.currency ?? ''} prev ${fmt(y.prevClose, 4)}` : 'no quote'}; served ${l ? `${fmt(l.price, 4)} ${l.currency ?? ''} venue ${l.venue} at ${l.at}` : 'blank'}`);
  const rows = listEuropeForSymbols(db, market, [symbol], addDaysEurope(ctx, today, -200), addDaysEurope(ctx, today, 200));
  for (const r of rows) printReport(r.reportDate < today || r.releasedAt ? 'last' : 'next', r);
  if (!rows.length) console.log('  no report rows');
  if (s.level === 'full' && s.adr) {
    const chain = await chains(s.adr).catch((e: Error) => { console.log(`  cboe error ${e.message}`); return null; });
    console.log(`  Cboe ${s.adr} ${chain ? `underlying ${fmt(chain.underlying)} as of ${chain.asOfDate ?? '-'} (${chain.quotes.length} quotes)` : 'no chain'}`);
  }
  if (s.level === 'full' && s.cik && secHttp) {
    const filings = await fetchEarningsFilings(secHttp, s.cik).catch((e: Error) => { console.log(`  sec error ${e.message}`); return []; });
    const latest = filings.filter((f) => f.form === (s.secForm ?? '6-K')).sort((a, b) => b.filingDate.localeCompare(a.filingDate))[0];
    console.log(`  latest SEC ${s.secForm ?? '6-K'} ${latest ? `${latest.filingDate} ${latest.indexUrl}` : 'blank'}`);
  }
}
console.log(`\nTradegate state ${tradegate.state()}; OpenFIGI key configured: ${openFigiKey ? 'yes' : 'no'}`);
db.close();
