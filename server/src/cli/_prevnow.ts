import { config } from '../config.js';
import { openDb } from '../db/repo.js';
import { todayET } from '../domain/marketCalendar.js';
import { computePrevMoves } from '../jobs/prevMoves.js';
import { createSources } from '../sources/index.js';
const db = openDb(config.dbPath);
await computePrevMoves({ db, sources: createSources(config), now: () => new Date().toISOString(), today: () => todayET() });
console.log('prev moves done');
