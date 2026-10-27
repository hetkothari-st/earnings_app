/** Hong Kong SQLite schema (hk_* tables). Columns added later are applied by `ensureHkSchema`. */
export const HK_SCHEMA = `
CREATE TABLE IF NOT EXISTS hk_stocks (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,                -- universe name
  profile_name TEXT,                 -- name from Yahoo; served in preference to the universe name
  yahoo_symbol TEXT NOT NULL,
  level TEXT NOT NULL,               -- 'full' | 'basic'
  adr TEXT,
  adr_ratio REAL,
  cik INTEGER,
  cadence TEXT NOT NULL,             -- 'Q' | 'H'
  fy_end_month INTEGER NOT NULL,
  sector TEXT,
  industry TEXT,
  market_cap REAL,                   -- HKD
  market_cap_as_of TEXT,
  active INTEGER NOT NULL DEFAULT 1, -- in the current universe
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS hk_reports (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  period_end TEXT NOT NULL,
  period_kind TEXT NOT NULL,         -- 'Q' | 'H' | 'FY'
  period_label TEXT NOT NULL,
  report_date TEXT NOT NULL,
  date_status TEXT NOT NULL DEFAULT 'estimated',  -- 'confirmed' | 'estimated'
  timing TEXT NOT NULL DEFAULT 'UNKNOWN',
  timing_source TEXT,                -- 'sec-6k' | 'sec-8k' | 'sec-notice' | 'yahoo'
  released_at TEXT,
  rescheduled_from TEXT,
  revenue_actual REAL,
  revenue_currency TEXT,
  eps_actual REAL,
  eps_currency TEXT,
  eps_basis TEXT,                    -- 'share' | 'ads'
  actual_source TEXT,                -- 'sec' | 'yahoo'
  sec_doc_url TEXT,
  eps_estimate REAL,
  eps_analysts INTEGER,
  revenue_estimate REAL,
  revenue_analysts INTEGER,
  estimate_currency TEXT,
  estimates_fetched_at TEXT,
  prev_move_pct REAL,
  prev_move_date TEXT,
  prev_move_basis TEXT,              -- 'known' | 'assumed'
  prev_move_checked_at TEXT,
  calendar_fetched_at TEXT,
  UNIQUE (code, period_end)
);
CREATE INDEX IF NOT EXISTS idx_hk_reports_date ON hk_reports (report_date);

CREATE TABLE IF NOT EXISTS hk_expected_moves (
  report_id INTEGER PRIMARY KEY REFERENCES hk_reports (id) ON DELETE CASCADE,
  adr TEXT,
  expiry TEXT NOT NULL,
  strike REAL NOT NULL,
  call_mid REAL NOT NULL,
  put_mid REAL NOT NULL,
  underlying REAL NOT NULL,          -- US$ ADR close
  move_pct REAL NOT NULL,
  illiquid INTEGER NOT NULL,
  final INTEGER NOT NULL DEFAULT 0,  -- 1 = taken at the last close before release
  quote_date TEXT,
  snapshot_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS hk_live_moves (
  report_id INTEGER PRIMARY KEY REFERENCES hk_reports (id) ON DELETE CASCADE,
  move_pct REAL NOT NULL,
  illiquid INTEGER NOT NULL,
  quote_time TEXT,
  fetched_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS hk_sec_seen (
  accession TEXT PRIMARY KEY,
  cik INTEGER,
  kind TEXT NOT NULL,                -- 'results' | 'date-notice' | 'other'
  seen_at TEXT NOT NULL
);
`;

/** Columns that databases created before they existed still need. */
export const HK_ADDED_COLUMNS: Record<string, [string, string][]> = {
  hk_stocks: [['profile_name', 'TEXT']],
};
