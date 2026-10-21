import { buildServer } from './api/server.js';
import { Broadcaster, registerStream } from './api/stream.js';
import { LivePrices } from './live/livePrices.js';
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
import { IN_INDICES, InPrices } from './india/live/inPrices.js';
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

const app = buildServer(db, {
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
  inPrices.refresh();
})();
