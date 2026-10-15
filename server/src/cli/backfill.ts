import { config } from '../config.js';
import { openDb } from '../db/repo.js';
import { addDays, todayET } from '../domain/marketCalendar.js';
import { backfill } from '../jobs/backfill.js';
import { computePrevMoves } from '../jobs/prevMoves.js';
import { createSources } from '../sources/index.js';

const today = todayET();
const start = process.argv[2] ?? addDays(today, -730);
const db = openDb(config.dbPath);
const ctx = { db, sources: createSources(config), now: () => new Date().toISOString(), today: () => today };
await backfill(ctx, start);
await computePrevMoves(ctx);
console.log('Backfill complete');
