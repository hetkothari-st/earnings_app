import { config } from '../config.js';
import { openDb } from '../db/repo.js';
import { addDays, todayET } from '../domain/marketCalendar.js';
import { backfill } from '../jobs/backfill.js';
import { createSources } from '../sources/index.js';

const today = todayET();
const start = process.argv[2] ?? addDays(today, -730);
const db = openDb(config.dbPath);
await backfill({ db, sources: createSources(config), now: () => new Date().toISOString(), today: () => today }, start);
console.log('Backfill complete');
