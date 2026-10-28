/**
 * UK and Europe SQLite schema (europe_* tables, shared by both markets with a `market` column; Ruling 1). Columns
 * added later are applied by `ensureEuropeSchema` from EUROPE_ADDED_COLUMNS.
 */
export const EUROPE_SCHEMA = `
CREATE TABLE IF NOT EXISTS europe_stocks (
  symbol TEXT PRIMARY KEY,           -- Yahoo symbol, e.g. 'AZN.L', 'BT-A.L', 'SAP.DE', 'ERIC-B.ST' (Ruling 2)
  market TEXT NOT NULL CHECK (market IN ('UK','EU')),
  exchange TEXT NOT NULL,            -- ExchangeId
  isin TEXT,                         -- NULL only when a newer symbol of the market took this ISIN
  lei TEXT,
  name TEXT NOT NULL,                -- universe name (curated for full level, GLEIF / FIRDS / SIX otherwise)
  profile_name TEXT,                 -- Yahoo name; served in preference for basic rows
  mic TEXT,
  country TEXT,
  currency TEXT,                     -- listing currency as Yahoo quotes it ('GBp' = pence)
  fy_end_month INTEGER,              -- NULL: unknown; no calendar rows are created (Ruling 6)
  fy_end_source TEXT,                -- 'esef' | 'yahoo'
  level TEXT NOT NULL,               -- 'full' | 'basic'
  adr TEXT,
  adr_ratio REAL,                    -- local shares per US share (display only)
  adr_ratio_verified INTEGER NOT NULL DEFAULT 0,
  cik INTEGER,
  sec_form TEXT,                     -- '6-K' | '8-K'
  sector TEXT,
  industry TEXT,
  market_cap REAL,
  market_cap_currency TEXT,          -- as Yahoo states it; never converted
  market_cap_as_of TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  missed_refreshes INTEGER NOT NULL DEFAULT 0,  -- consecutive universe refreshes without this symbol; inactive at 2
  updated_at TEXT NOT NULL,
  UNIQUE (market, isin)
);
CREATE INDEX IF NOT EXISTS idx_europe_stocks_lei ON europe_stocks (lei);

CREATE TABLE IF NOT EXISTS europe_reports (
  id INTEGER PRIMARY KEY,            -- UK from 4_000_000_001, EU from 5_000_000_001
  market TEXT NOT NULL CHECK (market IN ('UK','EU')),
  symbol TEXT NOT NULL,
  name TEXT NOT NULL,
  exchange TEXT NOT NULL,
  period_end TEXT NOT NULL,
  fiscal_quarter INTEGER NOT NULL,   -- 1..4; 4 = full year
  fy_end TEXT NOT NULL,
  period_label TEXT NOT NULL,
  period_confirmed INTEGER NOT NULL DEFAULT 0,  -- 1 once a source confirms period_end (Ruling 7)
  report_date TEXT NOT NULL,
  date_status TEXT NOT NULL DEFAULT 'estimated',  -- 'confirmed' | 'estimated'
  rescheduled_from TEXT,
  timing TEXT NOT NULL DEFAULT 'UNKNOWN',
  timing_source TEXT,                -- 'sec-notice' | 'prn' | 'yahoo'
  released_at TEXT,                  -- earliest results-out signal (Ruling 10)
  released_source TEXT,              -- 'sec' | 'prn' | 'dila' | 'yahoo'
  signal_title TEXT,
  signal_url TEXT,
  revenue_actual REAL,
  revenue_currency TEXT,
  revenue_source TEXT,               -- 'sec' | 'esef' | 'yahoo'
  revenue_span TEXT,                 -- 'quarter' | 'ytd'
  revenue_ytd_months INTEGER,        -- 6 | 9 | 12 for span 'ytd'
  eps_actual REAL,                   -- basic EPS per share
  eps_diluted_actual REAL,
  eps_currency TEXT,                 -- 'GBp' for pence, 'GBP' for pounds
  eps_source TEXT,
  eps_span TEXT,
  eps_ytd_months INTEGER,
  sec_doc_url TEXT,
  esef_url TEXT,
  eps_estimate REAL,
  eps_analysts INTEGER,
  eps_estimate_currency TEXT,
  revenue_estimate REAL,
  revenue_analysts INTEGER,
  revenue_estimate_currency TEXT,
  estimate_span TEXT,                -- 'quarter' | 'year'
  estimates_fetched_at TEXT,
  prev_move_pct REAL,
  prev_move_date TEXT,
  prev_move_basis TEXT,              -- 'known' | 'assumed'
  prev_move_checked_at TEXT,
  calendar_fetched_at TEXT,
  UNIQUE (symbol, period_end)
);
CREATE INDEX IF NOT EXISTS idx_europe_reports_date ON europe_reports (market, report_date);

CREATE TABLE IF NOT EXISTS europe_expected_moves (
  report_id INTEGER PRIMARY KEY REFERENCES europe_reports (id) ON DELETE CASCADE,
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

CREATE TABLE IF NOT EXISTS europe_live_moves (
  report_id INTEGER PRIMARY KEY REFERENCES europe_reports (id) ON DELETE CASCADE,
  move_pct REAL NOT NULL,
  illiquid INTEGER NOT NULL,
  quote_time TEXT,
  fetched_at TEXT NOT NULL
);

-- One filing can serve two markets (HSBC: HK and UK), so "seen" is per market (Ruling 13).
CREATE TABLE IF NOT EXISTS europe_sec_seen (
  market TEXT NOT NULL CHECK (market IN ('UK','EU')),
  accession TEXT NOT NULL,
  cik INTEGER,
  kind TEXT NOT NULL,                -- 'results' | 'date-notice' | 'other'
  seen_at TEXT NOT NULL,
  PRIMARY KEY (market, accession)
);

-- Rolling per-symbol date sweep progress, so a restart resumes the cycle.
CREATE TABLE IF NOT EXISTS europe_date_sweep (
  symbol TEXT PRIMARY KEY,
  checked_at TEXT NOT NULL,
  date_seen_at TEXT,
  announced_date TEXT
);

CREATE TABLE IF NOT EXISTS europe_past_dates (
  symbol TEXT NOT NULL,
  date TEXT NOT NULL,
  timing TEXT,                       -- NULL: unknown
  PRIMARY KEY (symbol, date)
);

-- Fast signals (PR Newswire, DILA): each item handled once.
CREATE TABLE IF NOT EXISTS europe_signal_seen (
  source TEXT NOT NULL,              -- 'prn' | 'dila' (and 'dila-file' for a whole day file)
  item_id TEXT NOT NULL,
  symbol TEXT,
  outcome TEXT NOT NULL,
  seen_at TEXT NOT NULL,
  PRIMARY KEY (source, item_id)
);

CREATE TABLE IF NOT EXISTS europe_esef_seen (
  fxo_id TEXT PRIMARY KEY,
  symbol TEXT,
  period_end TEXT,
  outcome TEXT NOT NULL,             -- 'merged' | 'no-row' | 'blank' (an error is never recorded)
  seen_at TEXT NOT NULL,
  date_added TEXT                    -- the filing's filings.xbrl.org date_added (ESEF paging); NULL when unknown
);

-- OpenFIGI answers (Ruling 5): only new ISINs cost requests. A failed request is never stored.
CREATE TABLE IF NOT EXISTS europe_figi (
  isin TEXT NOT NULL,
  exch_code TEXT NOT NULL,
  tickers_json TEXT NOT NULL,        -- JSON array of tickers ([] = OpenFIGI has none)
  yahoo_symbol TEXT,
  outcome TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  PRIMARY KEY (isin, exch_code)
);

-- gov.uk England and Wales bank holidays (the LSE's closed weekdays).
CREATE TABLE IF NOT EXISTS europe_bank_holidays (
  date TEXT PRIMARY KEY,
  title TEXT,
  fetched_at TEXT NOT NULL
);

-- The last complete universe build per market (synced), for the admin page after a restart. No row: never built.
CREATE TABLE IF NOT EXISTS europe_universe_runs (
  market TEXT PRIMARY KEY CHECK (market IN ('UK','EU')),
  left_out INTEGER NOT NULL,
  built_at TEXT NOT NULL
);
`;

/** Columns that databases created before they existed still need. */
export const EUROPE_ADDED_COLUMNS: Record<string, [string, string][]> = {
  europe_esef_seen: [['date_added', 'TEXT']],
};
