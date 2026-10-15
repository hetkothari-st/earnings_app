import { config } from '../config.js';
import { openDb } from '../db/repo.js';
import { addDays, todayET } from '../domain/marketCalendar.js';
import { computePrevMoves } from '../jobs/prevMoves.js';
import { createSources } from '../sources/index.js';
const today = todayET();
const ctx = { db: openDb(config.dbPath), sources: createSources(config), now: () => new Date().toISOString(), today: () => today };
await computePrevMoves(ctx, { from: addDays(today, -730) });
console.log('prev moves (2y) done');
