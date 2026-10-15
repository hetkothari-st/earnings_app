import { fileURLToPath } from 'node:url';

try {
  process.loadEnvFile(fileURLToPath(new URL('../../.env', import.meta.url)));
} catch {
  // No .env file: rely on the real environment.
}

export const config = {
  port: Number(process.env.PORT ?? 3001),
  dbPath: process.env.DB_PATH ?? fileURLToPath(new URL('../../data/earnings.db', import.meta.url)),
  finnhubToken: process.env.FINNHUB_TOKEN ?? '',
  secUserAgent: process.env.SEC_USER_AGENT ?? '',
};

export type Config = typeof config;
