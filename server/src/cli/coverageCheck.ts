import { config } from '../config.js';
import { openDb } from '../db/repo.js';
import { todayET } from '../domain/marketCalendar.js';
import { todayIST } from '../india/domain/nseCalendar.js';
import { todayHKT } from '../hk/domain/hkCalendar.js';
import { runCoverageCheck } from '../jobs/coverage.js';

// `--db <path>` points the check at a copy of the database.
const at = process.argv.indexOf('--db');
const path = at >= 0 && process.argv[at + 1] ? process.argv[at + 1]! : config.dbPath;
const db = openDb(path);
process.exitCode = runCoverageCheck(db, todayET(), todayIST(), todayHKT(), (line) => console.log(line));
db.close();
