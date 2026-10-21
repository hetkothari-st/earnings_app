import type { Config } from '../config.js';
import type { Sources } from '../jobs/context.js';
import { fetchCboeChain } from './cboe.js';
import { fetchFinnhubEarnings } from './finnhub.js';
import { BROWSER_UA, makeHttp } from './http.js';
import { fetchDailyCloses, fetchNasdaqCalendar, fetchSectors } from './nasdaq.js';
import { fetchAcceptance, fetchEarningsFilings, fetchSecTickers } from './sec.js';
import { createYahooSummaryFetcher } from './yahooEarnings.js';

export function createSources(cfg: Config): Sources {
  const nasdaq = makeHttp({ minIntervalMs: 1000, headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' } });
  const cboe = makeHttp({ minIntervalMs: 2500, backoffMs: 15_000, headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' } });
  const finnhub = makeHttp({ minIntervalMs: 1100, headers: { 'X-Finnhub-Token': cfg.finnhubToken } });
  const sec = makeHttp({ minIntervalMs: 150, headers: { 'User-Agent': cfg.secUserAgent } });

  const requireSecUa = () => {
    if (!cfg.secUserAgent) throw new Error('SEC_USER_AGENT is not set (see .env.example)');
  };

  return {
    calendar: (date) => fetchNasdaqCalendar(nasdaq, date),
    earningsDetails: async (from, to) => {
      if (!cfg.finnhubToken) throw new Error('FINNHUB_TOKEN is not set (see .env.example)');
      return fetchFinnhubEarnings(finnhub, from, to);
    },
    optionChain: (symbol) => fetchCboeChain(cboe, symbol),
    secTickers: async () => { requireSecUa(); return fetchSecTickers(sec); },
    secEarningsFilings: async (cik) => { requireSecUa(); return fetchEarningsFilings(sec, cik); },
    secAcceptance: async (cik, accession) => { requireSecUa(); return fetchAcceptance(sec, cik, accession); },
    dailyCloses: (symbol, from, to) => fetchDailyCloses(nasdaq, symbol, from, to),
    sectors: () => fetchSectors(nasdaq),
    yahooSummary: createYahooSummaryFetcher(),
    // Opt-in only: Investing.com's terms forbid automated access, and it needs a local Chrome.
    ...(cfg.investingScraper ? {
      investing: async (tab: 'today' | 'yesterday', date: string) =>
        (await import('./investingScraper.js')).investingScraper().fetchCalendar(tab, date),
    } : {}),
  };
}
