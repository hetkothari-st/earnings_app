import { fileURLToPath } from 'node:url';

try {
  process.loadEnvFile(fileURLToPath(new URL('../../.env', import.meta.url)));
} catch {
  // No .env file: rely on the real environment.
}

export const config = {
  port: Number(process.env.PORT ?? 3001),
  /** 0.0.0.0 when hosted; loopback locally. */
  host: process.env.HOST ?? '127.0.0.1',
  trustProxy: process.env.TRUST_PROXY === '1',
  /** Built web app to serve from the API process (production). */
  webRoot: process.env.WEB_ROOT ?? (process.env.NODE_ENV === 'production' ? fileURLToPath(new URL('../../web/dist', import.meta.url)) : undefined),
  dbPath: process.env.DB_PATH ?? fileURLToPath(new URL('../../data/earnings.db', import.meta.url)),
  finnhubToken: process.env.FINNHUB_TOKEN ?? '',
  secUserAgent: process.env.SEC_USER_AGENT ?? '',
  /** Investing.com scraper (needs Chrome; ToS forbids scraping): off unless INVESTING_SCRAPER=1. */
  investingScraper: process.env.INVESTING_SCRAPER === '1',
  // Kite credentials (India). All optional — India features degrade gracefully without them.
  kiteApiKey: process.env.KITE_API_KEY ?? '',
  kiteApiSecret: process.env.KITE_API_SECRET ?? '',
  kiteUserId: process.env.KITE_USER_ID ?? '',
  kitePassword: process.env.KITE_PASSWORD ?? '',
  kiteTotpSecret: process.env.KITE_TOTP_SECRET ?? '',
  /**
   * Fast-reader gate: a field read from the press release goes live only if its
   * corpus match rate is >= 95% (npm run reader-corpus -w server).
   * US corpus (48 releases): adjusted EPS 8/11 = 72.7% vs Nasdaq (company non-GAAP often
   * differs from Nasdaq's), GAAP EPS 31/31 = 100%, revenue 24/24 = 100%.
   * Quick US EPS is shown GAAP-labelled, without colour. India reader not built yet.
   */
  fastFields: { usEpsAdjusted: false, usEpsGaap: true, usRevenue: true, inEps: false, inRevenue: false, inProfit: false } as {
    usEpsAdjusted: boolean; usEpsGaap: boolean; usRevenue: boolean; inEps: boolean; inRevenue: boolean; inProfit: boolean;
  },
};

export type Config = typeof config;
