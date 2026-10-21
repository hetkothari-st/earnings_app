/** India-specific SQLite schema (in_* tables). Columns added later are applied by `migrateInSchema`. */
export const IN_SCHEMA = `
CREATE TABLE IF NOT EXISTS in_stocks (
  symbol TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  lot_size INTEGER,
  active INTEGER NOT NULL DEFAULT 1,  -- in the current NSE F&O list
  eq_token INTEGER,                   -- Kite NSE equity instrument token
  sector TEXT,
  industry TEXT,
  market_cap REAL,                    -- rupees
  market_cap_as_of TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS in_reports (
  id INTEGER PRIMARY KEY,
  symbol TEXT NOT NULL,
  name TEXT NOT NULL,
  quarter_end TEXT NOT NULL,
  quarter_label TEXT NOT NULL,
  report_date TEXT,
  date_status TEXT NOT NULL DEFAULT 'confirmed',  -- 'confirmed' (NSE filing) | 'estimated' (Yahoo)
  timing TEXT NOT NULL DEFAULT 'UNKNOWN',
  timing_source TEXT,
  released_at TEXT,      -- ISO instant of the earliest NSE results announcement/filing
  rescheduled_from TEXT,
  -- Actuals (INR, full rupees as filed)
  revenue_actual REAL,
  revenue_kind TEXT,
  pnl_actual REAL,
  eps_actual REAL,
  nature TEXT,           -- 'Standalone' | 'Consolidated'
  -- Estimates (Yahoo, only for the same quarter end)
  eps_estimate REAL,
  eps_analysts INTEGER,
  revenue_estimate REAL,
  revenue_analysts INTEGER,
  estimates_fetched_at TEXT,
  -- Moves
  prev_move_pct REAL,
  prev_move_date TEXT,
  prev_move_basis TEXT,  -- 'known' | 'assumed' (timing of that earlier report)
  prev_move_checked_at TEXT,
  -- Meta
  filing_fetched_at TEXT,
  calendar_fetched_at TEXT,
  UNIQUE (symbol, quarter_end)
);
CREATE INDEX IF NOT EXISTS idx_in_reports_date ON in_reports (report_date);

CREATE TABLE IF NOT EXISTS in_expected_moves (
  report_id INTEGER PRIMARY KEY REFERENCES in_reports (id) ON DELETE CASCADE,
  expiry TEXT NOT NULL,
  strike REAL NOT NULL,
  call_mid REAL NOT NULL,
  put_mid REAL NOT NULL,
  underlying REAL NOT NULL,
  move_pct REAL NOT NULL,
  illiquid INTEGER NOT NULL,
  final INTEGER NOT NULL DEFAULT 0,  -- 1 = taken at the last close before release
  snapshot_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS in_live_moves (
  report_id INTEGER PRIMARY KEY REFERENCES in_reports (id) ON DELETE CASCADE,
  move_pct REAL NOT NULL,
  illiquid INTEGER NOT NULL,
  quote_time TEXT,
  fetched_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_prefs (
  user_id TEXT PRIMARY KEY,
  market TEXT NOT NULL DEFAULT 'US',
  updated_at TEXT NOT NULL
);
`;

/** Columns that databases created before they existed still need. */
export const IN_ADDED_COLUMNS: Record<string, [string, string][]> = {
  in_reports: [
    ['date_status', "TEXT NOT NULL DEFAULT 'confirmed'"],
    ['released_at', 'TEXT'],
    ['eps_analysts', 'INTEGER'],
    ['revenue_estimate', 'REAL'],
    ['revenue_analysts', 'INTEGER'],
    ['estimates_fetched_at', 'TEXT'],
    ['prev_move_basis', 'TEXT'],
    // Preliminary values from the results PDF, shown until the XBRL filing confirms or corrects them.
    ['eps_prelim', 'REAL'],
    ['revenue_prelim', 'REAL'],
    ['pnl_prelim', 'REAL'],
    ['prelim_basis', 'TEXT'],
    ['prelim_at', 'TEXT'],
    ['eps_corrected', 'INTEGER'],
    ['revenue_corrected', 'INTEGER'],
    ['pnl_corrected', 'INTEGER'],
  ],
  in_expected_moves: [['final', 'INTEGER NOT NULL DEFAULT 0']],
};
