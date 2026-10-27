import { buildServer } from './api/server.js';
import { Broadcaster, registerStream } from './api/stream.js';
import { parseCookies } from './auth/cookies.js';
import { SESSION_COOKIE } from './auth/routes.js';
import { findSessionUser } from './auth/store.js';
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
import { fetchIndexQuote, fetchStockQuote, fetchYahooDailyCloses } from './sources/yahoo.js';
import { HKT, todayHKT } from './hk/domain/hkCalendar.js';
import type { HkJobContext } from './hk/jobs/context.js';
import { startHkScheduler, warmUpHk } from './hk/jobs/scheduler.js';
import { HkPrices } from './hk/live/hkPrices.js';
import { hkSixKMarket } from './hk/live/hkSecWatch.js';
import { JST, todayJST } from './jp/domain/jpCalendar.js';
import type { JpJobContext } from './jp/jobs/context.js';
import { startJpScheduler, warmUpJp, type JpSchedulerHooks } from './jp/jobs/scheduler.js';
import { JpPrices, toDelayedQuotes } from './jp/live/jpPrices.js';
import { jpSixKMarket } from './jp/live/jpSixK.js';
import { fetchEdinetCodeList, makeEdinetClient } from './jp/sources/edinet.js';
import { createYahooJpSummary, fetchJpEarningsCalendar, fetchYahooQuotes } from './jp/sources/yahooJp.js';
import { SixKWatch } from './sources/sixKWatch.js';
import { createYahooClient } from './sources/yahooClient.js';
import { yahooLimiter } from './sources/yahooLimiter.js';
import { createYahooHkFetcher, yahooHkPastDates } from './hk/sources/yahooHk.js';
import { todayIST } from './india/domain/nseCalendar.js';
import type { InJobContext } from './india/jobs/context.js';
import { startInScheduler, warmUpIndia } from './india/jobs/scheduler.js';
import { computeInPrevMoves } from './india/jobs/prevMoves.js';
import { getInReport, saveInPrelim, syncWatched } from './india/db/inRepo.js';
import { loadFoCache } from './india/jobs/stocks.js';
import { createWatchBackfill } from './jobs/watchBackfill.js';
import { refreshWatchedEstimates } from './jobs/refreshCalendar.js';
import { allWatched } from './watchlist/store.js';
import { fetchResultsPdf, readInResultsPdf } from './india/sources/resultsPdf.js';
import { IN_INDICES, InPrices } from './india/live/inPrices.js';
import { SymbolIndex, hkEntries, jpEntries, loadInEntries, startSymbolRefresh, usEntries } from './watchlist/search.js';
import { createKiteApi } from './india/sources/kiteApi.js';
import { completeBrowserLogin, ensureSession, getKiteCredentials, getSession, kiteStatus, startBrowserLogin } from './india/sources/kiteLogin.js';
import { createYahooInFetcher, fetchYahooIndex } from './india/sources/yahooIn.js';
import { fetchYahooPastDates } from './india/sources/yahooPastDates.js';

const db = openDb(config.dbPath);
const sources = createSources(config);
const ctx: JobContext = { db, sources, now: () => new Date().toISOString(), today: () => todayET() };

const yahoo = makeHttp({ minIntervalMs: 300, headers: { 'User-Agent': BROWSER_UA } });
/** Batch Yahoo work of the foreign markets (HK daily closes) on the one cross-market Yahoo budget (1 request/s). */
const yahooBudgeted = makeHttp({ minIntervalMs: 1000, headers: { 'User-Agent': BROWSER_UA }, limiter: yahooLimiter });
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
const inPrices = InPrices.forContext(inCtx, (p) => live.publish('in-prices', { prices: p }), (ids) => live.publish('in-moves', { ids }),
  // Live index levels for the markets strip, in /api/in/markets's shape.
  (m) => live.publish('in-indices', {
    indices: [...m].map(([index, p]) => ({ index, price: p.price, changePct: p.changePct, asOf: p.at, source: p.source === 'stream' ? 'kite' : 'yahoo' })),
  }));
const kiteCreds = getKiteCredentials();
/**
 * Automatic Zerodha login (password + TOTP) only when KITE_AUTO_LOGIN=1: every failed try counts against the
 * account, and Zerodha blocks it after a few. Without it, the admin logs in on Zerodha's own page.
 */
const kiteAuto = kiteCreds && process.env.KITE_AUTO_LOGIN === '1' ? kiteCreds : null;
/** Daily (and admin-triggered) automatic Zerodha login: one try. */
const kiteLogin = async () => {
  if (!kiteAuto) return;
  await ensureSession(kiteAuto, { force: true, attempts: 1 });
  inPrices.refresh();
};

// Hong Kong: Yahoo `.HK` (summaries, past dates, closes, delayed prices), Cboe chains for the ADRs, and the
// one shared SEC client for 6-Ks (null without SEC_USER_AGENT: full-level SEC features are off).
const hkCtx: HkJobContext = {
  db,
  now: () => new Date().toISOString(),
  todayHKT,
  yahoo: createYahooHkFetcher(),
  yahooPastDates: yahooHkPastDates,
  yahooCloses: (s, f, t) => fetchYahooDailyCloses(yahooBudgeted, s, f, t, HKT),
  optionChain: (adr) => sources.optionChain(adr), // the shared Cboe limiter
  secHttp: sources.secHttp ?? null,
};
const hkPrices = new HkPrices(db, { quote: (s) => fetchStockQuote(yahoo, s), index: (s) => fetchIndexQuote(yahoo, s) },
  (p) => live.publish('hk-prices', { prices: p }), (m) => live.publish('hk-indices', { indices: m }));

// Japan: every Yahoo call (date sweep, summaries, batch quotes, closes, prices, indices) goes through this one client:
// one session, on the cross-market Yahoo budget (at most 1 request/s together with HK and India). EDINET only with a
// key; SEC through the one shared client (null without SEC_USER_AGENT).
const jpYahoo = createYahooClient({ limiter: yahooLimiter });
const jpCtx: JpJobContext = {
  db,
  now: () => new Date().toISOString(),
  todayJST,
  yahooCalendar: (f, t) => fetchJpEarningsCalendar(jpYahoo, f, t),
  yahooSummary: createYahooJpSummary(jpYahoo),
  yahooQuotes: (s) => fetchYahooQuotes(jpYahoo, s),
  yahooCloses: (s, f, t) => fetchYahooDailyCloses(jpYahoo, s, f, t, JST),
  edinetCodeList: () => fetchEdinetCodeList(),
  edinet: config.edinetApiKey ? makeEdinetClient({ key: config.edinetApiKey }) : null,
  optionChain: (adr) => sources.optionChain(adr), // the shared Cboe limiter
  secHttp: sources.secHttp ?? null,
  tierA: () => [...new Set([...jpPrices.visibleCodes(), ...allWatched(db, 'JP')])],
};
const jpPrices = new JpPrices(db, {
  quote: (s) => fetchStockQuote(jpYahoo, s),
  quotes: async (s) => toDelayedQuotes(await fetchYahooQuotes(jpYahoo, s)),
  index: (s) => fetchIndexQuote(jpYahoo, s),
}, (p) => live.publish('jp-prices', { prices: p }), (m) => live.publish('jp-indices', { indices: m }));

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
      else if (market === 'IN') syncInWatched();
      else if (market === 'HK') hkPrices.refresh();
      else if (market === 'JP') jpPrices.refresh();
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
    kiteLogin: kiteAuto ? () => ensureSession(kiteAuto, { force: true }).then(() => inPrices.refresh()) : undefined,
    kiteBrowserStart: kiteCreds ? () => startBrowserLogin(kiteCreds) : undefined,
    kiteBrowserComplete: kiteCreds ? async (token, state) => {
      const ok = await completeBrowserLogin(kiteCreds, token, state);
      if (ok) {
        inPrices.refresh();
        // Previous moves need Kite candles: without a session at start or 08:30 they were skipped.
        void job('india-prev-moves', () => computeInPrevMoves(inCtx))();
      }
      return ok;
    } : undefined,
  },
  hk: {
    prices: () => hkPrices.snapshot(),
    indices: () => hkPrices.indices(),
    indexQuote: (s) => fetchIndexQuote(yahoo, s),
    setVisible: (u, c) => hkPrices.setVisible(u, c),
  },
  jp: {
    prices: () => jpPrices.snapshot(),
    indices: () => jpPrices.indices(),
    indexQuote: (s) => fetchIndexQuote(jpYahoo, s),
    setVisible: (u, c) => jpPrices.setVisible(u, c),
  },
});
// Live stream: signed-in users only (the HTTP routes check the same session cookie).
registerStream(app, live, (cookie) => {
  const token = parseCookies(cookie)[SESSION_COOKIE];
  return !!token && findSessionUser(db, token, Date.now()) != null;
});
startSymbolRefresh(symbolIndex, {
  ...(config.secUserAgent ? { US: async () => usEntries(await ctx.sources.secTickers(), db) } : {}),
  HK: async () => hkEntries(db),
  JP: async () => jpEntries(db),
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
  // HK and Japan: one 6-K feed for both (2 s while either has a full-level report due, else 30 s); HK's YUMC and ONC
  // file 8-Ks, forwarded from the US feed below (no second 8-K request).
  const sixK = new SixKWatch([
    hkSixKMarket(hkCtx, (ids) => live.publish('hk-results', { ids })),
    jpSixKMarket(jpCtx, (ids) => live.publish('jp-results', { ids })),
  ], secHttp, { db, now: () => new Date().toISOString() });
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
  // Every 2 s: one feed request each (SEC allows 10/s); a release shows on screen within a few seconds of filing.
  new SecWatch(ctx, secHttp, (ids) => live.publish('results', { ids }), reader, (items) => sixK.onUsFeed(items)).start(2000);
  sixK.start();
}

startHkScheduler(hkCtx, job, {
  onResults: (ids) => live.publish('hk-results', { ids }),
  onMoves: (ids) => live.publish('hk-moves', { ids }),
});
const hkWarm = warmUpHk(hkCtx, job);
hkPrices.start();

const jpHooks: JpSchedulerHooks = {
  onResults: (ids) => live.publish('jp-results', { ids }),
  onMoves: (ids) => live.publish('jp-moves', { ids }),
  // The watchlist index takes the universe as soon as jp_stocks fills (until then PUT only checks the code format).
  onStocks: () => { const list = jpEntries(db); if (list.length > 0) symbolIndex.set('JP', list); },
};
startJpScheduler(jpCtx, job, jpHooks);
// Japan warms up after Hong Kong: both wait on the one Yahoo budget, and Japan's thousands of codes would otherwise
// slow HK's warm-up. Neither blocks US or India startup.
void hkWarm.then(() => warmUpJp(jpCtx, job, jpHooks)).catch((e) => console.error('[job jp-warm-up]', e));
jpPrices.start();

startInScheduler(inCtx, job, {
  onResults: (ids) => { live.publish('in-results', { ids }); inPrices.refresh(); },
  onMoves: (ids) => live.publish('in-moves', { ids }),
  login: kiteLogin,
});
// Without Kite credentials the calendar, estimates and results still work; prices and moves show "—".
void (async () => {
  if (kiteAuto) await ensureSession(kiteAuto, { attempts: 1 });
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
  new NseWatch({ ...inCtx, http: nseHttp }, (ids) => { live.publish('in-results', { ids }); inPrices.refresh(); }, inReader).start(3000);
  inPrices.refresh();
})();
