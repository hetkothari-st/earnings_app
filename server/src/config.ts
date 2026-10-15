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
};

export type Config = typeof config;
