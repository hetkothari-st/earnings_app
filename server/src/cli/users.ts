import { runUsersCommand } from '../auth/cli.js';
import { config } from '../config.js';
import { openDb } from '../db/repo.js';

const db = openDb(config.dbPath);
process.exitCode = await runUsersCommand(db, process.argv.slice(2), (line) => console.log(line));
db.close();
