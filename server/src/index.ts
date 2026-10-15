import { buildServer } from './api/server.js';
import { Broadcaster, registerStream } from './api/stream.js';
import { config } from './config.js';
import { openDb } from './db/repo.js';
import { todayET } from './domain/marketCalendar.js';
import type { JobContext } from './jobs/context.js';
import { startScheduler, warmUp } from './jobs/scheduler.js';
import { BROWSER_UA, makeHttp } from './sources/http.js';
import { createSources } from './sources/index.js';
import { fetchIndexQuote } from './sources/yahoo.js';

const db = openDb(config.dbPath);
const ctx: JobContext = { db, sources: createSources(config), now: () => new Date().toISOString(), today: () => todayET() };

const yahoo = makeHttp({ minIntervalMs: 300, headers: { 'User-Agent': BROWSER_UA } });
const app = buildServer(db, { indexQuote: (s) => fetchIndexQuote(yahoo, s) });
const live = new Broadcaster();
registerStream(app, live);
await app.listen({ port: config.port, host: '127.0.0.1' });
console.log(`API listening on http://127.0.0.1:${config.port}`);

const job = startScheduler(ctx, (ids) => live.publish('results', { ids }));
// Warm the cache on start, under the scheduler's overlap guard; failures are recorded in /api/status.
void warmUp(ctx, job);
