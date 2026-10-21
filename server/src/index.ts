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
import { fetchIndexQuote } from './sources/yahoo.js';
import { todayIST } from './india/domain/nseCalendar.js';
import type { InJobContext } from './india/jobs/context.js';
import { startInScheduler, warmUpIndia } from './india/jobs/scheduler.js';
import { getInReport, saveInPrelim } from './india/db/inRepo.js';
import { fetchResultsPdf, readInResultsPdf } from './india/sources/resultsPdf.js';
import { IN_INDICES, InPrices } from './india/live/inPrices.js';
import { SymbolIndex, loadInEntries, startSymbolRefresh, usEntries } from './watchlist/search.js';
import { createKiteApi } from './india/sources/kiteApi.js';
import { ensureSession, getKiteCredentials, getSession, kiteStatus } from './india/sources/kiteLogin.js';
import { createYahooInFetcher, fetchYahooIndex } from './india/sources/yahooIn.js';

const db = openDb(config.dbPath);
const ctx: JobContext = { db, sources: createSources(config), now: () => new Date().toISOString(), today: () => todayET() };

const yahoo = makeHttp({ minIntervalMs: 300, headers: { 'User-Agent': BROWSER_UA } });
const live = new Broadcaster();
const finnhubQuotes = makeHttp({ minIntervalMs: 1100, headers: { 'X-Finnhub-Token': config.finnhubToken } });
const prices = new LivePrices(db, config.finnhubToken, finnhubQuotes, () => todayET(), (p) => live.publish('prices', { prices: p }));

// India: NSE archives and Kite instrument dumps are public; Kite REST/ticker need the daily session.
const inCtx: InJobContext = {
  db,
  http: makeHttp({ minIntervalMs: 300, headers: { 'User-Agent': BROWSER_UA } }),
  kite: createKiteApi(getSession),
  kiteSession: getSession,
  yahoo: createYahooInFetcher(),
  now: () => new Date().toISOString(),
  todayIST,
};
const inPrices = new InPrices(db, getSession, todayIST, (p) => live.publish('in-prices', { prices: p }));
const kiteCreds = getKiteCredentials();
/** Daily (and admin-triggered) Zerodha login: 3 tries 5 minutes apart. */
const kiteLogin = async () => {
  if (!kiteCreds) return;
  await ensureSession(kiteCreds, { force: true, attempts: 3, retryMs: 5 * 60_000 });
  inPrices.refresh();
};

// Search and validation lists for watchlists: built in memory, refreshed daily (started below).
const symbolIndex = new SymbolIndex();
const app = buildServer(db, {
  watchlist: { index: symbolIndex },
  indexQuote: (s) => fetchIndexQuote(yahoo, s), requireAuth: true, webRoot: config.webRoot, trustProxy: config.trustProxy,
  prices: () => prices.snapshot(),
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
  IN: () => loadInEntries(inCtx.http, db),
});
await app.listen({ port: config.port, host: config.host });
console.log(`API listening on http://${config.host}:${config.port}`);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const job = startScheduler(ctx, (ids) => live.publish('results', { ids }), (ids) => live.publish('moves', { ids }));
// Warm the cache on start, under the scheduler's overlap guard; failures are recorded in /api/status.
void warmUp(ctx, job);
if (config.finnhubToken) prices.start();
// One shared SEC client (<= 10 req/s overall). The 8-K watcher flips US reports to released within seconds.
if (config.secUserAgent) {
  const secHttp = makeHttp({ minIntervalMs: 120, headers: { 'User-Agent': config.secUserAgent } });
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
