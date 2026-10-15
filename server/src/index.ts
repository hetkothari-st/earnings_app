import { buildServer } from './api/server.js';
import { config } from './config.js';
import { openDb } from './db/repo.js';
import { todayET } from './domain/marketCalendar.js';
import type { JobContext } from './jobs/context.js';
import { refreshCalendar } from './jobs/refreshCalendar.js';
import { refreshResults } from './jobs/refreshResults.js';
import { startScheduler } from './jobs/scheduler.js';
import { createSources } from './sources/index.js';

const db = openDb(config.dbPath);
const ctx: JobContext = { db, sources: createSources(config), now: () => new Date().toISOString(), today: () => todayET() };

const app = buildServer(db);
await app.listen({ port: config.port, host: '127.0.0.1' });
console.log(`API listening on http://127.0.0.1:${config.port}`);

startScheduler(ctx);
// Warm the cache on start; failures are recorded in /api/status.
void refreshResults(ctx).then(() => refreshCalendar(ctx));
