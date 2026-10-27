/** Japan SQLite schema (jp_* tables). Columns added later are applied by `ensureJpSchema`. */
export const JP_SCHEMA = `
CREATE TABLE IF NOT EXISTS jp_stocks (
  code TEXT PRIMARY KEY,             -- 4 characters, e.g. '7203', '285A'
  edinet_code TEXT,
  name TEXT NOT NULL,                -- universe name (English when the code list has one)
  name_ja TEXT,
  profile_name TEXT,                 -- name from Yahoo; served in preference to the universe name
  yahoo_symbol TEXT NOT NULL,
  level TEXT NOT NULL,               -- 'full' | 'basic'
  adr TEXT,
  adr_ratio REAL,                    -- Tokyo shares per ADS (may be fractional)
  cik INTEGER,
  fy_end_month INTEGER,              -- NULL: unparseable; no calendar rows are created
  industry_ja TEXT,
  sector TEXT,
  industry TEXT,
  market_cap REAL,                   -- JPY
  market_cap_as_of TEXT,
  active INTEGER NOT NULL DEFAULT 1, -- in the current universe
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jp_reports (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  period_end TEXT NOT NULL,
  fiscal_quarter INTEGER NOT NULL,   -- 1..4; 4 = full year
  fy_end TEXT NOT NULL,
  period_label TEXT NOT NULL,
  report_date TEXT NOT NULL,
  date_status TEXT NOT NULL DEFAULT 'estimated',  -- 'confirmed' | 'estimated'
  timing TEXT NOT NULL DEFAULT 'UNKNOWN',
  timing_source TEXT,                -- 'sec-6k' | 'sec-notice' | 'yahoo'
  released_at TEXT,
  rescheduled_from TEXT,
  revenue_actual REAL,
  revenue_currency TEXT,
  revenue_source TEXT,               -- 'sec' | 'edinet' | 'yahoo'
  revenue_span TEXT,                 -- 'quarter' | 'ytd'
  revenue_ytd_months INTEGER,        -- 6 | 9 | 12 for span 'ytd'
  eps_actual REAL,                   -- basic EPS per share
  eps_diluted_actual REAL,
  eps_currency TEXT,
  eps_source TEXT,                   -- 'sec' | 'edinet' | 'yahoo'
  eps_span TEXT,                     -- 'quarter' | 'ytd'
  eps_ytd_months INTEGER,
  sec_doc_url TEXT,
  edinet_doc_id TEXT,
  eps_estimate REAL,
  eps_analysts INTEGER,
  revenue_estimate REAL,
  revenue_analysts INTEGER,
  estimate_currency TEXT,
  estimate_span TEXT,                -- 'quarter' | 'year'
  estimates_fetched_at TEXT,
  prev_move_pct REAL,
  prev_move_date TEXT,
  prev_move_basis TEXT,              -- 'known' | 'assumed'
  prev_move_checked_at TEXT,
  calendar_fetched_at TEXT,
  UNIQUE (code, period_end)
);
CREATE INDEX IF NOT EXISTS idx_jp_reports_date ON jp_reports (report_date);

CREATE TABLE IF NOT EXISTS jp_expected_moves (
  report_id INTEGER PRIMARY KEY REFERENCES jp_reports (id) ON DELETE CASCADE,
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

CREATE TABLE IF NOT EXISTS jp_live_moves (
  report_id INTEGER PRIMARY KEY REFERENCES jp_reports (id) ON DELETE CASCADE,
  move_pct REAL NOT NULL,
  illiquid INTEGER NOT NULL,
  quote_time TEXT,
  fetched_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jp_sec_seen (
  accession TEXT PRIMARY KEY,
  cik INTEGER,
  kind TEXT NOT NULL,                -- 'results' | 'date-notice' | 'other'
  seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jp_edinet_seen (
  doc_id TEXT PRIMARY KEY,
  code TEXT,
  doc_type TEXT,
  period_end TEXT,
  outcome TEXT NOT NULL,             -- 'merged' | 'superseded' | 'no-row' | 'blank' | 'parse-error' | 'error'
  seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jp_past_dates (
  code TEXT NOT NULL,
  date TEXT NOT NULL,
  timing TEXT,                       -- NULL: unknown
  PRIMARY KEY (code, date)
);
`;

/** Columns that databases created before they existed still need. */
export const JP_ADDED_COLUMNS: Record<string, [string, string][]> = {
  // An 'error' outcome is retried with backoff: attempts so far, and when the next attempt is due.
  jp_edinet_seen: [['attempts', 'INTEGER NOT NULL DEFAULT 1'], ['retry_after', 'TEXT']],
};
