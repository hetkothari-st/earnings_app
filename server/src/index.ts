import { buildServer } from './api/server.js';
import { Broadcaster, registerStream } from './api/stream.js';
import { LivePrices } from './live/livePrices.js';
import { NseWatch } from './india/live/nseWatch.js';
import { SecWatch } from './live/secWatch.js';
import { config } from './config.js';
import { savePrelim } from './db/prelim.js';
import { getReport, openDb } from './db/repo.js';
import { readUsRelease } from './sources/releaseReader.js';
import { DateTime } from 'luxon';
import { todayET } from './domain/marketCalendar.js';
import type { JobContext } from './jobs/context.js';
import { startScheduler, warmUp } from './jobs/scheduler.js';
import { BROWSER_UA, makeHttp } from './sources/http.js';
import { createSources } from './sources/index.js';
import { fetchIndexQuote, fetchStockQuote } from './sources/yahoo.js';
import { todayIST } from './india/domain/nseCalendar.js';
import type { InJobContext } from './india/jobs/context.js';
import { startInScheduler, warmUpIndia } from './india/jobs/scheduler.js';
import { getInReport, saveInPrelim, syncWatched } from './india/db/inRepo.js';
import { loadFoCache } from './india/jobs/stocks.js';
import { createWatchBackfill } from './jobs/watchBackfill.js';
import { refreshWatchedEstimates } from './jobs/refreshCalendar.js';
import { allWatched } from './watchlist/store.js';
import { fetchResultsPdf, readInResultsPdf } from './india/sources/resultsPdf.js';
import { IN_INDICES, InPrices } from './india/live/inPrices.js';
import { SymbolIndex, loadInEntries, startSymbolRefresh, usEntries } from './watchlist/search.js';
import { createKiteApi } from './india/sources/kiteApi.js';
import { ensureSession, getKiteCredentials, getSession, kiteStatus } from './india/sources/kiteLogin.js';
import { createYahooInFetcher, fetchYahooIndex } from './india/sources/yahooIn.js';
import { fetchYahooPastDates } from './india/sources/yahooPastDates.js';

const db = openDb(config.dbPath);
const sources = createSources(config);
const ctx: JobContext = { db, sources, now: () => new Date().toISOString(), today: () => todayET() };

const yahoo = makeHttp({ minIntervalMs: 300, headers: { 'User-Agent': BROWSER_UA } });
const live = new Broadcaster();
const finnhubQuotes = makeHttp({ minIntervalMs: 1100, headers: { 'X-Finnhub-Token': config.finnhubToken } });
const prices = new LivePrices(db, config.finnhubToken, finnhubQuotes, () => todayET(), (p) => live.publish('prices', { prices: p }),
  { yahooQuote: (s) => fetchStockQuote(yahoo, s) });

// India: NSE archives and Kite instrument dumps are public; Kite REST/ticker need the daily session.
const inCtx: InJobContext = {
  db,
  http: makeHttp({ minIntervalMs: 300, headers: { 'User-Agent': BROWSER_UA } }),
  kite: createKiteApi(getSession),
  kiteSession: getSession,
  yahoo: createYahooInFetcher(),
  yahooPastDates: fetchYahooPastDates,
  now: () => new Date().toISOString(),
  todayIST,
};
const inPrices = InPrices.forContext(inCtx, (p) => live.publish('in-prices', { prices: p }), (ids) => live.publish('in-moves', { ids }));
const kiteCreds = getKiteCredentials();
/** Daily (and admin-triggered) Zerodha login: 3 tries 5 minutes apart. */
const kiteLogin = async () => {
  if (!kiteCreds) return;
  await ensureSession(kiteCreds, { force: true, attempts: 3, retryMs: 5 * 60_000 });
  inPrices.refresh();
};

// Search and validation lists for watchlists: built in memory, refreshed daily (started below).
const symbolIndex = new SymbolIndex();
// Watched stocks flow through the data jobs: US gets its past results once; India stocks join the matching cache.
const backfillWatched = createWatchBackfill(ctx, (s) => symbolIndex.nameOf('US', s));
const inTokens = new Map<string, number>(); // Kite NSE equity tokens, filled by the daily list load
const syncInWatched = (): void => {
  const symbols = allWatched(db, 'IN');
  const names = new Map<string, string>();
  for (const s of symbols) { const n = symbolIndex.nameOf('IN', s); if (n) names.set(s, n); }
  syncWatched(db, symbols, names, new Date().toISOString(), inTokens);
  loadFoCache(db);
  void inPrices.refresh().catch((e) => console.warn('india prices refresh:', e instanceof Error ? e.message : e));
};
const app = buildServer(db, {
  watchlist: {
    index: symbolIndex,
    onWatchAdded: (market, symbol) => {
      if (market === 'US') {
        void backfillWatched(symbol).catch((e) => console.warn(`watch backfill ${symbol}:`, e instanceof Error ? e.message : e));
        // An off-calendar stock gets its estimated next date now, not at the next 6-hourly run.
        void refreshWatchedEstimates(ctx).catch((e) => console.warn(`watch estimates ${symbol}:`, e instanceof Error ? e.message : e));
      }
      else syncInWatched();
    },
  },
  indexQuote: (s) => fetchIndexQuote(yahoo, s), requireAuth: true, webRoot: config.webRoot, trustProxy: config.trustProxy,
  prices: () => prices.snapshot(),
  setVisible: (user, symbols) => prices.setVisible(user, symbols),
  india: {
    prices: () => inPrices.snapshot(),
    indices: () => inPrices.indices(),
    indexNames: IN_INDICES.map((i) => i.name),
    yahooIndex: (name) => fetchYahooIndex(yahoo, IN_INDICES.find((i) => i.name === name)!.yahoo),
    kiteStatus,
    kiteLogin: kiteCreds ? () => ensureSession(kiteCreds, { force: true }).then(() => inPrices.refresh()) : undefined,
  },
});
registerStream(app, live);
startSymbolRefresh(symbolIndex, {
  ...(config.secUserAgent ? { US: async () => usEntries(await ctx.sources.secTickers(), db) } : {}),
  IN: async () => {
    const list = await loadInEntries(inCtx.http, db, inTokens);
    // Names for watched stocks outside F&O come from this list.
    setTimeout(() => { try { syncInWatched(); } catch (e) { console.warn('india watched sync:', e); } }, 0); // after the list is set
    return list;
  },
});
await app.listen({ port: config.port, host: config.host });
console.log(`API listening on http://${config.host}:${config.port}`);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const job = startScheduler(ctx, (ids) => live.publish('results', { ids }), (ids) => live.publish('moves', { ids }));
// Warm the cache on start, under the scheduler's overlap guard; failures are recorded in /api/status.
void warmUp(ctx, job);
if (config.finnhubToken) prices.start();
// One shared SEC client (<= 10 req/s overall). The 8-K watcher flips US reports to released within seconds.
const secHttp = sources.secHttp;
if (secHttp) {
  // Quick read of the press release: preliminary values until an official source confirms them.
  const reader = async (exhibitUrl: string, reportId: number): Promise<void> => {
    const rep = getReport(db, reportId);
    const m = rep?.fiscalQuarter.match(/^([A-Z][a-z]{2})\/(\d{4})$/);
    const month = m ? MONTHS.indexOf(m[1]!) : -1;
    if (!rep || month < 0) return;
    const quarterEnd = DateTime.utc(Number(m![2]), month + 1, 1).endOf('month').toISODate()!;
    const v = readUsRelease(await secHttp.text(exhibitUrl), quarterEnd);
    if (savePrelim(db, reportId, v, new Date().toISOString())) live.publish('results', { ids: [reportId] });
  };
  new SecWatch(ctx, secHttp, (ids) => live.publish('results', { ids }), reader).start(5000);
}

startInScheduler(inCtx, job, {
  onResults: (ids) => { live.publish('in-results', { ids }); inPrices.refresh(); },
  onMoves: (ids) => live.publish('in-moves', { ids }),
  login: kiteLogin,
});
// Without Kite credentials the calendar, estimates and results still work; prices and moves show "—".
void (async () => {
  if (kiteCreds) await ensureSession(kiteCreds, { attempts: 1 });
  inPrices.start();
  syncInWatched();
  await warmUpIndia(inCtx, job);
  // Flips India reports within seconds; ticks no-op until the F&O list is loaded. Own client: 1 request/s to nsearchives.
  const nseHttp = makeHttp({ minIntervalMs: 1000, headers: { 'User-Agent': BROWSER_UA } });
  // Quick read of the results PDF: preliminary EPS / revenue / profit until the XBRL filing confirms them.
  // Downloads go one at a time, a second apart, however many results come out together.
  let pdfQueue: Promise<unknown> = Promise.resolve();
  const queuedPdf = (url: string): Promise<Uint8Array> => {
    const next = pdfQueue.then(() => fetchResultsPdf(url, BROWSER_UA));
    pdfQueue = next.catch(() => undefined).then(() => new Promise((r) => setTimeout(r, 1000)));
    return next;
  };
  const inReader = async (pdfUrl: string, reportId: number): Promise<void> => {
    const g = config.fastFields;
    if (!g.inEps && !g.inRevenue && !g.inProfit) return; // no field is live: nothing would be stored
    const rep = getInReport(db, reportId);
    if (!rep) return;
    const v = await readInResultsPdf(await queuedPdf(pdfUrl), rep.quarterEnd);
    if (saveInPrelim(db, reportId, v, new Date().toISOString())) live.publish('in-results', { ids: [reportId] });
  };
  new NseWatch({ ...inCtx, http: nseHttp }, (ids) => { live.publish('in-results', { ids }); inPrices.refresh(); }, inReader).start(5000);
  inPrices.refresh();
})();
