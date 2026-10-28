# UK and Europe Earnings Calendar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two markets behind the switch, **UK** (LSE Main Market + AIM, about 1,800) and **Europe** (main continental exchanges, about 5,000). **Full level**: about 45 US-listed names with Cboe chains get SEC results, the reader (gated) and an ADR expected move. **Basic level**: everyone else gets Yahoo dates, estimates, prices and actuals, ESEF annual figures, and "results out" from PR Newswire and DILA. Prices are Tradegate real-time (EUR) where Tradegate quotes the ISIN, else Yahoo delayed.

**Architecture:**
- One module `server/src/europe/` serves both markets, parameterised by `EuropeMarket = 'UK' | 'EU'`:
  - `exchanges.ts`, `universe.ts`, `universeBuild.ts`
  - `domain/`, `sources/`, `db/`, `jobs/`, `live/`, `api/`
- Tables: shared `europe_*` tables with a `market` column. Ids: UK from `4_000_000_001`, EU from `5_000_000_001`. Routes: `/api/uk/*` and `/api/eu/*`.
- Shared pieces get new profiles or markets; nothing is copied:
  - `sixKClassify` profiles `'uk'` / `'eu'`
  - `SixKWatch` routes one filing to **every** market that holds its CIK (HSBC is HK and UK)
  - `releaseReader` profiles `'uk'` / `'eu'`
  - `exchangeCalendar`, `adrSessions`, `adrMoves`, `DelayedPrices`, `yahooClient` + `yahooLimiter`
  - the reader-gate scoring, moved from `jp/domain/readerGate.ts` to `domain/readerGate.ts`
- New free sources:
  - ESMA and FCA FIRDS, the SIX share list, GLEIF, OpenFIGI
  - Yahoo ISIN search
  - gov.uk bank holidays
  - PR Newswire RSS, DILA INFOFI, filings.xbrl.org
  - Tradegate `refresh.php`
- The JP, UK and EU rolling Yahoo date sweeps take turns through `sources/sweepTurns.ts`, inside the one `yahooLimiter`.

**Tech Stack:** Node 24, TypeScript (NodeNext, strict), Fastify 5, node:sqlite, zod 4, luxon, node-cron, Vitest. React 19 + Vite + Testing Library. No new dependencies. Zip uses `node:zlib`. Tar uses a small reader over `node:zlib` gunzip. XML is parsed with regex over records, as `india/sources/xbrl.ts` and `jp/sources/edinetXbrl.ts` do.

**Spec:** `docs/superpowers/specs/2026-10-28-uk-europe-earnings-design.md` (binding). It builds on the Japan spec and the Japan code as built. Anything the spec does not state behaves as the Japan tab. The Japan plan (`docs/superpowers/plans/2026-10-27-japan-earnings.md`) is the precedent for style and for every "as Japan" below.

## Global Constraints

- **Free sources only.** App and script code may fetch only these hosts:
  - SEC: `www.sec.gov`, `data.sec.gov`
  - Cboe: `cdn.cboe.com` (answers `307` to `cdn-api.cboe.com`; `makeHttp` follows it)
  - Yahoo: `fc.yahoo.com`, `query1.finance.yahoo.com`, `query2.finance.yahoo.com`
  - FIRDS: `registers.esma.europa.eu`, `firds.esma.europa.eu`, `api.data.fca.org.uk`, `data.fca.org.uk` (FIRDS files only)
  - SIX: `www.six-group.com` (the share-list download only)
  - GLEIF: `api.gleif.org`
  - OpenFIGI: `api.openfigi.com`
  - gov.uk: `www.gov.uk` (`/bank-holidays.json` only)
  - PR Newswire: `www.prnewswire.com`, `www.prnewswire.co.uk` (RSS only)
  - DILA: `echanges.dila.gouv.fr` (`/OPENDATA/INFOFI/` only), or the host Task 3 records
  - filings.xbrl.org: `filings.xbrl.org`
  - Tradegate: `www.tradegatebsx.com` (`/refresh.php` and `/robots.txt` only)
- **Never fetch, not even by hand or in scripts**, and never bypass a bot wall or CAPTCHA:
  - LSEG / LSE: `londonstockexchange.com`, `apidata.londonstockexchange.com`
  - Euronext: `euronext.com`, `live.euronext.com`
  - nasdaq.com Nordic pages
  - Investegate
  - info-financiere.fr `/api/`
  - Market sites: TradingView, FT, Google Finance, Stooq, Lang & Schwarz
  - Aggregators: MarketScreener, Investing.com, finanzen.net, onvista, lse.co.uk, Sharecast, Digital Look
  - Börse Frankfurt / `api.boerse-frankfurt.de`
  - the Tradegate `/json/` path
- **Request headers:**
  - No request ever carries a personal email.
  - Non-SEC, non-Yahoo requests use `EUROPE_UA = 'EarningsCalendarPrototype/1.0 (+https://github.com/ainaman2512)'` (the app's name, no email). Task 3 confirms the repository URL from `git remote -v`; with no remote, drop the `(+…)` part.
  - Yahoo keeps the existing client headers.
- **Uncertain means blank.** Never overwrite a stored value with a blank.
- **Actual precedence:** SEC > ESEF > Yahoo, per field group:
  - A lower source never replaces a higher one, and a higher one replaces a lower one.
  - The same source never replaces itself: the first wins.
- **SEC:**
  - The User-Agent comes only from env `SEC_USER_AGENT`. Scripts load it from `C:\Users\ST269\Desktop\earnings_app\.env` through `process.loadEnvFile`, as `config.ts` does, and **never print it**.
  - App SEC requests go only through `sources.secHttp` (120 ms). Each script uses its own 120 ms client, and scripts never run at the same time as each other.
  - Without the UA, full-level SEC features are off and everything else works.
- **Credentials:**
  - `OPENFIGI_API_KEY` is optional (`config.openFigiApiKey`).
  - Neither it nor `SEC_USER_AGENT` is ever logged, stored, put in an error, source-error row, API response or commit.
  - The OpenFIGI key travels only in the `X-OPENFIGI-APIKEY` header.
- **Yahoo:**
  - Every UK/EU Yahoo request goes through one `createYahooClient({ limiter: yahooLimiter })` built in `index.ts`.
  - The process total stays ≤ 1 request/s.
  - The JP, UK and EU rolling date sweeps run one at a time (`sweepTurns`).
- **Tradegate:**
  - On by default; `TRADEGATE_PRICES=0` turns it off.
  - One process-wide limiter, ≤ 1 request/s.
  - On a 429 or 403, stop for 1 h and fall back to Yahoo.
  - Refuse to run when `robots.txt` disallows `/refresh.php` (checked at start and weekly).
- **Cboe:** UK/EU chains go through a 15-minute cache over the existing shared Cboe client (2,500 ms ≤ 0.5 req/s, 15 s back-off on 429). US/HK/JP Cboe calls are unchanged.
- **No order code. No Zerodha/Kite changes or logins.** Do not run `npm start` / `npm run dev`. Never open `data/earnings.db`; live checks run against a copy (`--db <copy>`, which refuses `config.dbPath`).
- **Migrations are additive:**
  - New tables only.
  - The watchlists CHECK rebuild copies every row (as the existing `rebuildWatchlists`).
  - No existing column is dropped or renamed.
- **Times and timing:**
  - UK: `Europe/London`. EU: each exchange in its own zone (Rulings 3 and 9).
  - Timing is `UNKNOWN` unless a source states the time. **No 07:00 default.**
  - An `UNKNOWN` row's tooltip reads: `UK/EU companies usually release at 07:00 local; not confirmed for this row.`
  - US option logic: ET via `server/src/domain/marketCalendar.ts`.
- **Money:**
  - Figures are stored with the currency the source states and never converted.
  - Pence are `GBp`, pounds are `GBP`.
  - EPS is shown in the unit the release states (`p` or `£`), never converted silently.
- **Beat/miss colour** needs all four: the same currency string (`GBp` ≠ `GBP`), per-share basis, the same period end, and the same span. Never colour EPS when the actual is from SEC.
- **Reader gate** (exactly as Japan):
  - `config.fastFields.ukEps`, `ukRevenue`, `euEps` and `euRevenue` default `false`.
  - A profile's pair turns on only when its main set has **≥ 20 exact releases carrying a value and 0 wrong**, **and** every held-out set has **0 wrong** (blanks allowed).
  - The "results out" flip ships regardless.
- **US, India, HK and JP behaviour unchanged:**
  - The existing **1,128 server and 162 web tests** stay green.
  - Every existing file under `server/test/hk/` and `server/test/jp/` stays untouched; `web/test/HkStockList.test.tsx` and `web/test/JpStockList.test.tsx` stay untouched.
  - `npm run reader-corpus -w server`, `-- --hk`, `-- --jp` and `-- --jp-heldout` print byte-identical output before Task 7 and after every later task.
- **Style:** dark theme, Archivo, dots not stripes, no all-caps labels.
- **TDD:** red → green. Before every commit run all four:
  - `npm test` in `server/`
  - `npm test` in `web/`
  - `npx tsc --noEmit` in `server/`
  - `npx tsc --noEmit` in `web/`
- **Commit messages** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Work only in the worktree `C:\Users\ST269\Desktop\earnings_app-europe` (branch `feature/europe`).
- **Imports:** server imports use `.js` extensions. The web app imports server types type-only from `../../server/src/...`.

## Review Focus

1. **A late reporter's period is inferred wrong.**
   - Example: an AIM company publishes FY-Dec-2025 results on 2026-05-20. "Latest quarter end before the date" gives 2026-03-31.
   - Expected: the period label shows only when confirmed (Ruling 7), so the row shows `Period not stated`, never "Q1 FY26".
   - An ESEF or Yahoo actual for 2025-12-31 is never merged into the 2026-03-31 row.
   - Pinned in Tasks 5, 13 and 15.
2. **Pence and pounds.**
   - Yahoo `.L` prices in `GBp` show as `1,234.5p`. A `.L` line quoting `USD` or `EUR` shows that currency.
   - A release EPS "12.3p" is stored `12.3 GBp`. A Yahoo estimate in `GBP` (0.118) never colours against it, and neither value is divided by 100.
   - The market cap is shown only in the currency Yahoo states for it.
   - Pinned in Tasks 2, 7, 13 and 20.
3. **HSBC's one CIK serves two markets.**
   - One HSBC 6-K flips the HK row `0005` (as today) **and** the UK row `HSBA.L`.
   - A failure in the UK handler never blocks or re-queues the HK handling.
   - Pinned in Tasks 6 and 19.
4. **Fast-signal false positives.** A PR Newswire item whose issuer name normalises to two universe companies, or to one with no result date within ±3 days, or whose title is not a results title, flips nothing. A DILA document of a non-results type flips nothing. Pinned in Tasks 11 and 16.
5. **Tradegate failing or going stale.**
   - A 429/403, `robots.txt` disallowing `/refresh.php`, or `TRADEGATE_PRICES=0` → the row falls back to Yahoo, labelled `Delayed ~15 min`.
   - The percentage change never mixes Tradegate's price with Yahoo's previous close.
   - Outside 08:00–22:00 Berlin, the last Tradegate close is shown with its time.
   - Pinned in Tasks 10 and 19.

---

## Parallel execution map

| Group | Tasks | Starts when | Notes |
|---|---|---|---|
| A | 1, 2, 3, 4 | now | Live facts; disjoint files. Only Task 4 edits `server/package.json`. |
| B | 5, 6, 7, 8, 9, 10, 11, 12 | all of A merged | Pure modules; disjoint files. Only Task 7 edits `server/package.json`. |
| C | 13 | all of B merged | Defines every `europe_*` repo function, `EuropeJobContext`, config. |
| D | 14, 15, 16, 17 | 13 merged | Disjoint files. Only Task 17 edits `config.ts` (UK flags). |
| D′ | 18 | 17 merged | EU corpus (edits `config.ts` again). |
| E | 19, 20 | 14, 15, 16 merged | 19 = server live + `index.ts` (only task to edit it); 20 = web only. |
| F | 21 | all merged | Spot-check and full verification. |

Each task repeats its dependencies in its **Depends on** line.

## Rulings (where the spec is silent or leaves the builder's call)

1. **Storage.**
   - Shared tables `europe_*` with `market TEXT CHECK (market IN ('UK','EU'))`.
   - A new report id is `COALESCE(MAX(id) WHERE market = ?, base − 1) + 1`, with base `4_000_000_001` (UK) or `5_000_000_001` (EU).
2. **Identity.**
   - A stock is keyed by its **Yahoo symbol** (`AZN.L`, `BT-A.L`, `SAP.DE`, `ERIC-B.ST`); its ISIN is stored, `UNIQUE(market, isin)`.
   - Watch/visible codes are Yahoo symbols upper-cased, matching `^[A-Z0-9][A-Z0-9.\-]{0,14}\.(L|PA|AS|BR|LS|IR|MI|OL|DE|SW|ST|CO|HE|MC)$`. UK accepts `.L` only; EU accepts the others.
3. **Exchanges.** `europe/exchanges.ts` holds one row per exchange: `id`, `market`, `country`, `zone`, Yahoo suffix, FIRDS MICs, OpenFIGI `exchCode`, listing currency, session and Yahoo region.

   | Id | Exchange | Zone | Suffix | exchCode (verify) | Session (local) |
   |---|---|---|---|---|---|
   | `LSE` | London (Main + AIM) | Europe/London | `.L` | `LN` | 08:00–16:30 |
   | `PAR` | Euronext Paris | Europe/Paris | `.PA` | `FP` | 09:00–17:30 |
   | `AMS` | Euronext Amsterdam | Europe/Amsterdam | `.AS` | `NA` | 09:00–17:30 |
   | `BRU` | Euronext Brussels | Europe/Brussels | `.BR` | `BB` | 09:00–17:30 |
   | `LIS` | Euronext Lisbon | Europe/Lisbon | `.LS` | `PL` | 08:00–16:30 |
   | `DUB` | Euronext Dublin | Europe/Dublin | `.IR` | `ID` | 08:00–16:30 |
   | `MIL` | Euronext Milan | Europe/Rome | `.MI` | `IM` | 09:00–17:30 |
   | `OSL` | Oslo Børs | Europe/Oslo | `.OL` | `NO` | 09:00–16:20 |
   | `XET` | Xetra | Europe/Berlin | `.DE` | `GY` | 09:00–17:30 |
   | `SIX` | SIX Swiss | Europe/Zurich | `.SW` | `SE` | 09:00–17:20 |
   | `STO` | Nasdaq Stockholm | Europe/Stockholm | `.ST` | `SS` | 09:00–17:30 |
   | `CPH` | Nasdaq Copenhagen | Europe/Copenhagen | `.CO` | `DC` | 09:00–17:30 |
   | `HEL` | Nasdaq Helsinki | Europe/Helsinki | `.HE` | `FH` | 10:00–18:30 |
   | `MAD` | BME Madrid | Europe/Madrid | `.MC` | `SM` | 09:00–17:30 |

   - Lisbon and Dublin trade the same session as Paris; in their own zone that is 08:00–16:30.
   - Timing: `BMO` < open, `DMH` open..close−1, `AMC` ≥ close (`amcAtClose: true`, as Tokyo).
4. **Universe.**
   - **Sources:** shares (CFI `ES*`) from FCA FIRDS (UK MICs) and ESMA FIRDS (EU/EEA MICs). Switzerland is outside FIRDS, so `SIX` comes from the SIX share list (the spec's allowed substitute).
   - **Primary line:** the target-MIC record with `IssrReq = true`. With several, the one whose exchange country equals the ISIN country. Still several, or none → left out (counted, never guessed).
   - **UK first:** an ISIN with a primary UK line is never in EU.
   - **Segments:** the regulated markets plus each exchange's own growth segment, which Yahoo quotes under the same suffix (AIM is the UK one). Task 1 records the exact MIC list and the counts; the target is ≈ 1,800 UK and ≈ 5,000 EU.
   - **Names:** the GLEIF legal name for the issuer LEI. Without one, the FIRDS `FullNm` with its share-class words trimmed. The SIX list name for Swiss rows.
   - **Inactive:** after the 2nd consecutive weekly refresh in which a symbol is missing (`missed_refreshes ≥ 2`). Never deleted. A failed refresh changes nothing.
5. **Yahoo symbol.**
   - OpenFIGI maps ISIN + `exchCode` to a ticker. `yahooSymbolFor(exchange, figiTicker)` applies the exchange's exact transform (`/` → `-`, then the suffix).
   - Where Task 1 shows a transform is not deterministic (Nordic share classes: OpenFIGI `ERICB` vs Yahoo `ERIC-B.ST`), the candidates are checked by **Yahoo ISIN search**. Only a candidate the search returns for that ISIN is accepted.
   - No match, or more than one, → left out.
   - Mappings are cached in `europe_figi`; only new ISINs cost requests.
6. **Fiscal year end.**
   - First choice: the month of the latest ESEF annual `period_end` for the issuer LEI. Otherwise Yahoo `defaultKeyStatistics.lastFiscalYearEnd`.
   - None → the stock is kept, but no calendar row is made (as Japan).
7. **Periods and labels.**
   - The key is `periodEnd`: the latest quarter end (fyEnd month, +3, +6, +9) strictly before the report date. `fiscalQuarter` is 1–4. The fiscal year is named by the calendar year it ends in.
   - Labels: Q1 → `"Q1 FY26"`, Q2 → `"H1 FY26"`, Q3 → `"Q3 FY26"`, Q4 → `"FY26"`.
   - `period_confirmed` is 1 only when one of these confirms `periodEnd`:
     - a 6-K/8-K classified with that period end
     - a Yahoo `earningsTrend` `0q` end date equal to it
     - an ESEF filing for it
     - the row's own released actual
   - The DTO serves `period: null` until confirmed; the web shows `Period not stated`.
8. **Spans and units.**
   - Actuals carry `span: 'quarter' | 'ytd'`, with `ytdMonths: 6 | 9 | 12 | null`, exactly as Japan.
   - A half-year release's six-month column is `ytd 6` ("YTD (6 months)"). A standalone H2 column is never read. Nothing is ever computed by subtraction.
   - EPS currency is `GBp` when the release states pence (`p`, `pence`) and `GBP` for `£`. The revenue currency is stored separately.
   - Estimates carry `epsCurrency` and `revenueCurrency` as Yahoo states them.
9. **Timing.**
   - Sources, in order:
     1. a 6-K date notice that states a clock time or a session phrase
     2. a PR Newswire item's `pubDate`, read in the row's exchange zone (a timestamped release)
     3. a Yahoo `TAS` time
   - SEC acceptance never proves timing: EDGAR opens 06:00 ET, after the 07:00 London release.
   - A DILA timestamp is the AMF filing time and never sets timing.
10. **Results out.**
    - `recordEuropeRelease` keeps the **earliest** timestamp among `sec`, `prn`, `dila` and `yahoo`, together with its source, title and link. A later signal never moves it.
    - Yahoo counts only for basic rows; its timestamp is the job's run time.
    - The UI labels the source and the time: `Results out · PR Newswire 07:02`.
11. **Full-level date** (Japan Ruling 8 as amended).
    - The ADR's US row maps to a local date: US `AMC` → the next local trading day, otherwise the same day.
    - It is used when Yahoo's local-line date agrees, or Yahoo has none for that period, or Yahoo has only its own projection.
    - A date Yahoo marks announced wins a disagreement. With no flag, a disagreement writes nothing.
    - The row stays `estimated` until a 6-K date notice confirms it.
12. **Yahoo tiers** (shared limiter ≤ 1 req/s):
    - **Rolling date sweep:** every 10 min per market, through `sweepTurns`. Every symbol with a fiscal-year end once a day; near-term symbols (unreleased within 14 days, or no date seen in 7 days) every 6 h.
      - `perRun`: UK 20 (peak 60), EU 50 (peak 150).
      - Peak windows (MM-DD, inclusive): `01-20..03-10`, `04-20..05-31`, `07-20..08-31`, `10-20..11-30`.
      - With JP's 30/90, the peak total is 300 per 10 min = 0.5 req/s.
    - **Bulk calendar:** every 2 h, only for Yahoo regions Task 2 marks `bulkCalendar: true` (supplement only, as Japan).
    - **Batch quotes** (50/request): weekly for caps and names.
    - **Summaries:** tier A (visible ∪ watched) 25 min; tier B (report in today−3..+14) 12 h. At most 600 per run per market, nearest first.
    - **Closes:** for previous moves, at most 600 per night per market.
13. **Shared 6-K watcher.**
    - `SixKMarket.name` gains `'uk' | 'eu'`.
    - A feed item goes to **every** market whose `ciks()` holds its CIK. The queue key is `${market.name}:${accession}`, so one market's failure or "seen" never affects another.
    - 8-K 2.02 items fan out the same way.
14. **Prices.**
    - Tradegate is used for a row whose ISIN Tradegate quotes (a non-null `last` or `close`).
    - The change % is `(last − close) / close` from the same answer.
    - The poller covers visible ∪ watched ∪ reporting today/tomorrow. One request per second, round-robin, oldest first.
    - **In hours** (08:00–22:00 Europe/Berlin on Tradegate trading days): each ISIN at most every 30 s. Otherwise every 15 min.
    - Everything else comes from the shared `DelayedPrices` (Yahoo batch quotes, 60 s in session, 15 min out of session), labelled `Delayed ~15 min`.
    - Yahoo session window: UK 07:45–16:45 London; EU 08:45–18:45 Paris on any EU trading day.
15. **Coverage minimums (status page),** as Japan: `epsEstimate` 30 within 14 days, `marketCap` 90, `previousMove` 30 within a week, `expectedMove` 60 within a week (full level only).
16. **Not modelled:**
    - LSE half days (24 and 31 December count as trading days, per the spec)
    - Xetra / Euronext early closes
    - system outages
    - For dates ≥ `2028-01-01`, calendars count weekends only, and a `europe-holidays` status warning shows.
17. **Admin:** `GET /api/admin/europe` (admins only) serves both markets and never contains a key value.

## Source facts (verify live in Tasks 1–4; save real samples as fixtures, never invent them)

- **FIRDS:**
  - ESMA file index: `https://registers.esma.europa.eu/solr/esma_registers_firds_files/select?q=*&fq=publication_date:[FROM TO TO]&wt=json&rows=100`. `response.docs[].download_link` points to `FULINS_E_YYYYMMDD_NNofMM.zip` (equities, weekly full set, often several parts).
  - FCA index: `https://api.data.fca.org.uk/fca_data_firds_files?q=((file_type:FULINS)%20AND%20(publication_date:[FROM%20TO%20TO]))&from=0&size=100`.
  - Record fields: `FinInstrmGnlAttrbts/{Id (ISIN), FullNm, ClssfctnTp (CFI)}`, `Issr` (LEI), `TradgVnRltdAttrbts/{Id (MIC), IssrReq, AdmssnApprvlDtByIssr, FrstTradDt, TermntnDt}`.
  - Measure part sizes. Plan for streaming (Task 8). If a full set is impractical (> 2 GB unzipped per weekly run, or download blocked), record the ruling and switch that market to the spec's substitutes (Deutsche Börse Xetra instrument CSV, BME list, SIX list) in `exchanges.ts`.
- **SIX share list:** find the CSV/JSON download behind six-group.com "Share Explorer" (robots allows). It needs ISIN, symbol, name and currency.
- **GLEIF:** `https://api.gleif.org/api/v1/lei-records?filter[lei]=L1,L2,…&page[size]=200` → `data[].attributes.entity.legalName.name`. Verify the batch size and the rate limit (60 req/min documented).
- **OpenFIGI:**
  - `POST https://api.openfigi.com/v3/mapping` with body `[{ "idType": "ID_ISIN", "idValue": "GB0009895292", "exchCode": "LN" }]` → `[{ data: [{ ticker, exchCode, name, securityType, marketSector, shareClassFIGI }] } | { warning } | { error }]`.
  - Keyless: 25 requests/min, 10 jobs each. With a key: per the published limits.
- **Yahoo:**
  - ISIN search: `https://query2.finance.yahoo.com/v1/finance/search?q=<ISIN>&quotesCount=10&newsCount=0` → `quotes[].symbol`.
  - Visualization (as Japan) with `{ operator: 'eq', operands: ['region', R] }` for R in `gb, fr, nl, be, pt, ie, it, no, de, ch, se, dk, fi, es`. Record per region whether rows exist after 2026-01-01 (Japan's were stale since May 2025).
  - Summary modules: Japan's plus `defaultKeyStatistics`.
  - Indices:
    - UK: `^FTSE`, `^FTMC`, `^FTAI`
    - EU: `^STOXX50E`, `^GDAXI`, `^FCHI`, `^AEX`, `^IBEX`, `FTSEMIB.MI`, `^SSMI`, `^OMX`
- **gov.uk:** `https://www.gov.uk/bank-holidays.json` → `{ "england-and-wales": { division, events: [{ title, date, notes, bunting }] }, … }`.
- **PR Newswire RSS:** candidates to verify:
  - `https://www.prnewswire.co.uk/rss/news-releases-list.rss`
  - `https://www.prnewswire.com/rss/news-releases-list.rss`
  - the Europe / UK geography feeds and the "earnings" subject feed, listed on `https://www.prnewswire.com/rss/`

  Record the UK and Europe URLs and the item fields (`title`, `link`, `pubDate`, `description`, any `dc:contributor`).
- **DILA INFOFI:** `https://echanges.dila.gouv.fr/OPENDATA/INFOFI/` (check `robots.txt` first). Record:
  - the directory layout (per-day files, archive type)
  - the XML record fields: ISIN, issuer name, document type/subtype, timestamp, PDF link
  - the exact type values that mean results: annual / half-year financial report, quarterly financial information, results press release
- **filings.xbrl.org:**
  - `https://filings.xbrl.org/api/filings?filter[country]=GB&sort=-date_added&page[size]=100&include=entity` → `data[].attributes.{ fxo_id, country, period_end, date_added, processed, json_url, report_url, error_count }` and an entity relationship with the LEI (`included[].attributes.identifier`).
  - `json_url` is xBRL-JSON: `facts{ id: { value, dimensions: { concept, entity, period, unit, … } } }`.
- **Tradegate:**
  - `https://www.tradegatebsx.com/refresh.php?isin=DE0007164600` → `{ bid, ask, bidsize, asksize, last, high, low, close, stueck, umsatz, executions, delta }`.
  - Record the number format (JSON numbers, or German-format strings like `"1.234,56"`), what `close` means (the previous close), and the answer for an unknown ISIN.
  - `robots.txt` today: `User-agent: *` / `Disallow: /json/`.
- **Full level.** Ratios are local shares per ADS, **inferred from prices, to verify**. CIKs come from SEC `company_tickers.json`; HSBC is `1089113` (from `hk/universe.ts`).
  - **UK:** AZN→`AZN.L` 1 · SHEL→`SHEL.L` 2 · BP→`BP.L` 6 · HSBC→`HSBA.L` 5 · UL→`ULVR.L` 1 · GSK→`GSK.L` 2 · DEO→`DGE.L` 4 · VOD→`VOD.L` 10 · RIO→`RIO.L` 1 · BHP→`BHP.L` 2 · BTI→`BATS.L` 1 · NGG→`NG.L` 5 · BCS→`BARC.L` 4 · LYG→`LLOY.L` 4 · NWG→`NWG.L` 2 · RELX→`REL.L` 1 · PUK→`PRU.L` 2 · SNN→`SN.L` 2 · HLN→`HLN.L` 2 · WPP→`WPP.L` 5 · CCEP→`CCEP.L` 1 · ARM→(no London line expected)
  - **EU:** ASML→`ASML.AS` 1 · SAP→`SAP.DE` 1 · NVO→`NOVO-B.CO` 1 · TTE→`TTE.PA` 1 · SNY→`SAN.PA` 0.5 · NVS→`NOVN.SW` 1 · UBS→`UBSG.SW` 1 · ING→`INGA.AS` 1 · PHG→`PHIA.AS` 1 · ERIC→`ERIC-B.ST` 1 · NOK→`NOKIA.HE` 1 · EQNR→`EQNR.OL` 1 · STLA→`STLAM.MI` 1 · SAN→`SAN.MC` 1 · BBVA→`BBVA.MC` 1 · BUD→`ABI.BR` 1 · STM→`STMPA.PA` 1 · DB→`DBK.DE` 1 · AEG→`AGN.AS` 1 · CRH→(verify a European line) · SPOT, NXPI→(no European line expected) · optional: ARGX→`ARGX.BR`, LOGI→`LOGN.SW`; BNTX and CHKP have no EU line.
  - **Rule:** a name with no primary line on a target exchange is **not** added (no row without a local line) and is reported in the Task 4 commit for a user ruling.
- **Holidays.** Starting values: weekday closures only, `MM-DD`.
  - **Check:** check each list against the exchange's own published list where its site is not banned (Deutsche Börse/Xetra, SIX, BME, Tradegate; Oslo Børs now lives on the banned euronext.com). For Euronext and Nasdaq Nordic, whose sites are banned, keep these values, mark them `UNCONFIRMED (banned site)` in the module header, and list them in the Task 5 commit for the user to eyeball.
  - **UK** comes from gov.uk (England and Wales); these are the expected values for the tests.

  | Calendar | 2026 | 2027 |
  |---|---|---|
  | LSE (gov.uk E&W) | 01-01, 04-03, 04-06, 05-04, 05-25, 08-31, 12-25, 12-28 | 01-01, 03-26, 03-29, 05-03, 05-31, 08-30, 12-27, 12-28 |
  | Euronext PAR/AMS/BRU/LIS/DUB | 01-01, 04-03, 04-06, 05-01, 12-25 | 01-01, 03-26, 03-29 |
  | Milan | 01-01, 04-03, 04-06, 05-01, 12-24, 12-25, 12-31 | 01-01, 03-26, 03-29, 12-24, 12-31 |
  | Oslo | 01-01, 04-02, 04-03, 04-06, 05-01, 05-14, 05-25, 12-24, 12-25, 12-31 | 01-01, 03-25, 03-26, 03-29, 05-06, 05-17, 12-24, 12-31 |
  | Xetra | 01-01, 04-03, 04-06, 05-01, 12-24, 12-25, 12-31 | 01-01, 03-26, 03-29, 12-24, 12-31 |
  | SIX | 01-01, 01-02, 04-03, 04-06, 05-01, 05-14, 05-25, 12-24, 12-25, 12-31 | 01-01, 03-26, 03-29, 05-06, 05-17, 12-24, 12-31 |
  | Stockholm | 01-01, 01-06, 04-03, 04-06, 05-01, 05-14, 06-19, 12-24, 12-25, 12-31 | 01-01, 01-06, 03-26, 03-29, 05-06, 06-25, 12-24, 12-31 |
  | Copenhagen | 01-01, 04-02, 04-03, 04-06, 05-14, 05-15, 05-25, 06-05, 12-24, 12-25, 12-31 | 01-01, 03-25, 03-26, 03-29, 05-06, 05-07, 05-17, 12-24, 12-31 |
  | Helsinki | 01-01, 01-06, 04-03, 04-06, 05-01, 06-19, 12-24, 12-25, 12-31 | 01-01, 01-06, 03-26, 03-29, 06-25, 12-06, 12-24, 12-31 |
  | BME Madrid | 01-01, 04-03, 04-06, 05-01, 12-25 | 01-01, 03-26, 03-29 |
  | Tradegate | 01-01, 04-03, 04-06, 05-01, 12-24, 12-25, 12-31 | 01-01, 03-26, 03-29, 12-24, 12-31 |

## File map

**Server, create:**
- `src/europe/exchanges.ts`, `src/europe/universe.ts` (full lists), `src/europe/universeBuild.ts`
- `src/europe/domain/calendars.ts`, `src/europe/domain/period.ts`, `src/europe/domain/bankHolidays.ts`
- `src/europe/sources/`:
  - `sourceUrls.ts`, `yahooEurope.ts`, `firds.ts`, `sixList.ts`, `gleif.ts`, `openFigi.ts`
  - `tradegate.ts`, `robots.ts`, `prn.ts`, `dila.ts`, `issuerMatch.ts`, `esef.ts`, `releaseEurope.ts`
- `src/europe/db/schema.ts`, `src/europe/db/europeRepo.ts`
- `src/europe/api/types.ts`, `dto.ts`, `routes.ts`
- `src/europe/jobs/context.ts`:
  - `stocks.ts`, `calendar.ts`, `pastDates.ts`, `estimates.ts`, `results.ts`, `prevMoves.ts`
  - `signals.ts`, `esefResults.ts`, `moves.ts`, `secSweep.ts`, `scheduler.ts`
- `src/europe/live/europeSixK.ts`, `src/europe/live/tradegatePoller.ts`, `src/europe/live/europePrices.ts`
- Shared: `src/sources/sweepTurns.ts`, `src/sources/cboeCache.ts`, `src/sources/tar.ts`, `src/domain/readerGate.ts`
- `src/cli/verifyEuropeUniverse.ts`, `src/cli/collectEuropeCorpus.ts`, `src/cli/europeSpotCheck.ts`

**Server, modify:**
- `src/sources/sixKClassify.ts`, `sixKWatch.ts`, `releaseReader.ts`, `yahooForeignSummary.ts`, `zip.ts`
- `src/jp/domain/readerGate.ts` (becomes wrappers), `src/jp/jobs/scheduler.ts` (calendar job inside `sweepTurns`)
- `src/live/delayedPrices.ts` (`market` union)
- `src/config.ts`, `src/db/repo.ts`, `src/index.ts`, `package.json`
- `src/india/api/types.ts`, `src/india/db/inRepo.ts`, `src/india/api/routes.ts`
- `src/watchlist/{store,routes,search}.ts`, `src/notes/{store,routes}.ts`
- `src/jobs/coverage.ts`, `src/cli/coverageCheck.ts`, `src/cli/readerCorpus.ts`
- `src/api/{types,server}.ts`

**Web, create:** `src/components/EuropeStockList.tsx`

**Web, modify:**
- `src/lib/{market,format,liveCap}.ts`
- `src/hooks/{useMarket,useLiveResults,useVisibleSymbols}.ts`
- `src/components/{Header,Calendar,MarketBar,WatchlistView,StatusPage,AdminPage}.tsx`
- `src/api.ts`, `src/adminApi.ts`

**Fixtures:** `server/test/fixtures/europe/` (subfolders `universe/`, `yahoo/`, `feeds/`, `sec/`, `releases/uk/`, `releases/eu/`, each with `heldout/`).

---

### Task 1: Live facts: universe sources (FIRDS, SIX, GLEIF, OpenFIGI) and the exchange table  [Group A]

**Depends on:** nothing.

**Files:**
- Create:
  - `server/src/europe/exchanges.ts`
  - `server/test/europe/exchanges.test.ts`
  - Fixtures in `server/test/fixtures/europe/universe/`:
    - `esma_index.json`, `fca_index.json`: the real file-index answers
    - `firds_sample.xml`: the first ~60 real `<RefData>` records of one FULINS_E part, cut at record boundaries, with ≥ 1 AIM, ≥ 1 XETR and ≥ 1 record with two venues
    - `six_list_sample.csv` (or `.json`): 30 real rows
    - `gleif_batch.json`: one real batch of ≥ 5 LEIs
    - `openfigi_batch.json`: real answers for 10 ISINs, among them `GB0009895292`, `GB0030913577` (BT), `SE0000108656` (Ericsson B), `DK0062498333` (Novo B), one unknown ISIN, one with two tickers on one exchange
    - `yahoo_isin_search.json`: the search answer for `SE0000108656`

**Interfaces:**
- `type EuropeMarket = 'UK' | 'EU'`
- `type ExchangeId = 'LSE' | 'PAR' | 'AMS' | 'BRU' | 'LIS' | 'DUB' | 'MIL' | 'OSL' | 'XET' | 'SIX' | 'STO' | 'CPH' | 'HEL' | 'MAD'`
- `interface ExchangeInfo { id: ExchangeId; market: EuropeMarket; name: string; country: string; zone: string; suffix: string; mics: readonly string[]; figiExchCode: string; currency: string; openMin: number; closeMin: number; universeSource: 'fca-firds' | 'esma-firds' | 'six-list' | string /* a recorded substitute */; tickerTransform: 'exact' | 'search' }`
- `EXCHANGES: Readonly<Record<ExchangeId, ExchangeInfo>>` (Ruling 3, with the MICs and exchCodes as verified)
- `exchangeOfSymbol(symbol: string): ExchangeId | null` (by suffix)
- `exchangesOf(market: EuropeMarket): ExchangeId[]`
- `UNIVERSE_URLS = { esmaIndex, fcaIndex, sixList, gleif, openFigi, yahooSearch } as const`

- [ ] **Step 1: Probe live** with throwaway scripts in the scratchpad: honest UA `EUROPE_UA`, no email, a 1 s gap between requests.
  - Fetch both FIRDS indexes for the latest weekly full set. Download **one** FULINS_E part from each and record its zipped and unzipped size.
  - Count shares (`ES*`) per candidate MIC with `IssrReq = true`, and decide the MIC list (Ruling 4).
  - Find the SIX download link.
  - Run one GLEIF batch.
  - Run one keyless OpenFIGI request of 10 jobs.
  - Run one Yahoo ISIN search through a crumb-less GET (`fetch` with `BROWSER_UA`). If it needs a crumb, note that the job uses the shared Yahoo client.
  - Save the fixtures. Put the findings (sizes, counts per MIC, ticker shapes per exchange, rate-limit headers, whether streaming is required) in the `exchanges.ts` header comment.
- [ ] **Step 2: Write failing tests** (`exchanges.test.ts`):
  - `'14 exchanges, UK has only LSE, suffixes unique'`
  - `'exchangeOfSymbol: BT-A.L → LSE, ERIC-B.ST → STO, FTSEMIB.MI → MIL, AAPL → null'`
  - `'sessions as Ruling 3: HEL 600–1110, OSL 540–980, SIX 540–1040, LIS 480–990'`
  - `'fixtures are real answers'`:
    - `firds_sample.xml` has ≥ 60 `<RefData>` blocks.
    - `openfigi_batch.json` has 10 entries.
    - `yahoo_isin_search.json` lists `ERIC-B.ST`.
  - `'tickerTransform is search for STO, CPH, HEL'` (or whatever Step 1 found; assert the recorded values)
- [ ] **Step 3: Run** `npx vitest run test/europe/exchanges.test.ts` in `server/`. Expected: FAIL.
- [ ] **Step 4: Implement** `exchanges.ts` from the Step 1 findings.
- [ ] **Step 5: Run** the full server suite and `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(europe): exchange table and live-verified universe sources`. The body states:
  - the FIRDS part sizes
  - the MIC list with counts
  - any substitute ruling
  - the OpenFIGI limit observed

### Task 2: Live facts and module: Yahoo for `.L` and EU suffixes  [Group A]

**Depends on:** nothing.

**Files:**
- Create: `server/src/europe/sources/yahooEurope.ts`, `server/test/europe/yahooEurope.test.ts`
- Modify: `server/src/sources/yahooForeignSummary.ts`
  - Add `fyEndMonth: number | null`, from `defaultKeyStatistics.lastFiscalYearEnd`, as the month in UTC.
  - Make `capCurrency` accept `string | ((priceCurrency: string | null) => string | null)`.
  - The HK and JP calls are unchanged.
- Fixtures in `server/test/fixtures/europe/yahoo/`, saved as fetched:
  - `y_cal_<region>.json`: one per region tried, for a window that should have rows (e.g. `2026-10-20..2026-11-20`)
  - `y_quote_batch.json`: 50 symbols mixing `.L` (one in GBp, one `.L` in USD such as `IHG.L`, `BT-A.L`), `.DE`, `.PA`, `.ST`, `.SW`, `.CO`, and one unknown
  - summaries `y_AZN.L.json`, `y_VOD.L.json` (March FY), `y_SAP.DE.json`, `y_NOVO-B.CO.json`, `y_<an AIM name>.json`
  - the 11 index symbols, as `y_idx_<symbol>.json`
  - `y_chart_SHEL.L.json`

**Interfaces:**
- `yahooEurope.ts`:
  - `YAHOO_REGIONS: Readonly<Record<ExchangeId, { region: string; bulkCalendar: boolean }>>`, as verified in Step 1 (Japan precedent: stale regions are `false`)
  - `parseEuropeCalendarPage(json: unknown, zoneOf: (symbol: string) => string | null): { rows: EuropeCalRow[]; total: number | null }`
    - `EuropeCalRow = { symbol: string; date: string; timing: LocalTiming; timeType: string; epsActual: number | null }`
    - TAS rows: the local date and timing in the symbol's exchange zone. Other rows: the UTC date and `UNKNOWN`.
    - Rows whose suffix is not one of ours are dropped.
  - `fetchEuropeEarningsCalendar(y: YahooClient, region: string, from: string, to: string, zoneOf): Promise<{ rows: EuropeCalRow[]; complete: boolean }>`: as `fetchJpEarningsCalendar` (pages of 100, at most 80 pages, a mid-sweep failure gives `complete: false`)
  - `createYahooEuropeSummary(y: YahooClient): (symbol: string, maxAgeMs: number) => Promise<YahooForeignSummary | null>`
    - Modules: Japan's plus `defaultKeyStatistics`.
    - Zone: the symbol's exchange.
    - `capCurrency`: the currency Step 1 shows Yahoo uses for caps (e.g. `GBp` price → `GBP` cap; record the rule).
  - `yahooIsinSearch(y: YahooClient, isin: string): Promise<string[]>`: the symbols from the search answer
  - `EUROPE_INDICES: { UK: readonly { name: string; yahoo: string }[]; EU: readonly { name: string; yahoo: string }[] }`
    - Names: `FTSE 100`, `FTSE 250`, `FTSE AIM All-Share`, `Euro Stoxx 50`, `DAX`, `CAC 40`, `AEX`, `IBEX 35`, `FTSE MIB`, `SMI`, `OMXS30`
  - `interface EuropeQuote { symbol: string; price: number | null; prevClose: number | null; time: number | null; currency: string | null; marketCap: number | null; marketCapCurrency: string | null; name: string | null }`
  - `fetchEuropeQuotes(y: YahooClient, symbols: string[]): Promise<Map<string, EuropeQuote>>`: the `fetchYahooQuotes` request (50 per call), but the cap is kept with the currency Step 1 shows it is in, never filtered to one currency. Unknown symbols are absent.

- [ ] **Step 1: Probe live** through `createYahooClient()` from a scratchpad script.
  - For each region, run the visualization with the region operand. Record whether rows exist dated after `2026-01-01`, and their `startdatetimetype` mix.
  - Batch quote: record `currency` for `.L` lines and what `marketCap` means for GBp lines.
  - Summaries: is `earningsTrend` present for UK half-year reporters, and in which currency is the EPS (GBp or GBP)? Is `defaultKeyStatistics.lastFiscalYearEnd` present?
  - Indices: every symbol answers.
  - Save the fixtures. Put the findings in the header of `yahooEurope.ts`.
- [ ] **Step 2: Write failing tests** (`yahooEurope.test.ts`):
  - `'regions recorded: bulkCalendar flags match the fixtures'`: a region is `true` only if its fixture has a row dated ≥ 2026-01-01
  - `'TAS row on .L gets London date and timing; .HE row uses Helsinki'`: inline rows. `['AZN.L','2026-11-06T07:00:00.000Z','TAS']` → `{ date: '2026-11-06', timing: 'BMO' }`; `['NOKIA.HE','2026-10-23T05:00:00.000Z','TAS']` → 08:00 Helsinki, `BMO`.
  - `'quotes: GBp line, USD .L line and EUR line keep their currencies; cap kept with its currency; unknown absent'` (Review Focus 2)
  - `'summary: fyEndMonth 12 for SAP.DE, 3 for VOD.L; trend EPS currency as stated'`
  - `'ISIN search returns ERIC-B.ST for SE0000108656'`
  - `'all 11 indices parse'`
  - `'HK and JP summary parsing unchanged'`: `test/hk/yahooHk.test.ts` and `test/jp/yahooJp.test.ts` pass untouched
- [ ] **Step 3: Run** `npx vitest run test/europe/yahooEurope.test.ts test/hk/yahooHk.test.ts test/jp/yahooJp.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run** the full server suite and `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(europe): Yahoo for UK/EU suffixes (live-checked regions, quotes, summaries, ISIN search, indices)`.

### Task 3: Live facts: PR Newswire, DILA, filings.xbrl.org, gov.uk, Tradegate  [Group A]

**Depends on:** nothing.

**Files:**
- Create: `server/src/europe/sources/sourceUrls.ts`, `server/test/europe/sourceUrls.test.ts`
- Fixtures in `server/test/fixtures/europe/feeds/`:
  - `prn_uk.rss`, `prn_eu.rss`: real feeds; at least one item should be a results release (keep fetching every few hours in the session window until one appears, or take one from the feed's archive pages if the RSS exposes them)
  - `dila_listing.html`: a day directory listing
  - `dila_sample.taz` (or the real archive type): one real archive, ≤ 2 MB
  - `dila_robots.txt`
  - `xbrl_filings_gb.json`, `xbrl_filings_fr.json`: `include=entity`
  - `xbrl_facts_sample.json`: one real `json_url` answer, trimmed to the facts of the 6 concepts in Task 12 plus all `dei`/period facts. Keep its original `documentInfo`.
  - `govuk_bank_holidays.json`
  - `tradegate_DE0007164600.json`, `tradegate_GB0009895292.json`, `tradegate_unknown.json`
  - `tradegate_robots.txt`
  - `prn_robots.txt`, `xbrl_robots.txt` (or a note that it is 404)

**Interfaces:**
- `sourceUrls.ts`:
  - `PRN_FEEDS: { UK: readonly string[]; EU: readonly string[] }`
  - `DILA_BASE: string`, `DILA_RESULTS_TYPES: readonly string[]` (the exact type values from the sample)
  - `XBRL_FILINGS_URL: string`
  - `GOVUK_BANK_HOLIDAYS_URL = 'https://www.gov.uk/bank-holidays.json'`
  - `TRADEGATE_REFRESH = 'https://www.tradegatebsx.com/refresh.php'`, `TRADEGATE_ROBOTS = 'https://www.tradegatebsx.com/robots.txt'`
  - `EUROPE_UA: string` (the Global Constraints value)
  - A header comment recording:
    - every robots result
    - the Tradegate number format and the meaning of `close`
    - the DILA layout
    - the PRN item fields

- [ ] **Step 1: Probe live** with `EUROPE_UA` and a 1 s gap. Read each host's `robots.txt` **first**; skip any path it disallows and record that. Save the fixtures.
- [ ] **Step 2: Write failing tests** (`sourceUrls.test.ts`):
  - `'PRN fixtures are RSS with pubDate to the second'`
  - `'DILA sample contains ISIN-tagged records with a results type from DILA_RESULTS_TYPES'`
  - `'xbrl filings have json_url and an entity LEI'`
  - `'gov.uk has england-and-wales events for 2026 and 2027'`
  - `'Tradegate answers have last and close; unknown ISIN recorded'`
  - `'robots: tradegate disallows /json/ only'`
- [ ] **Step 3: Run** `npx vitest run test/europe/sourceUrls.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement** `sourceUrls.ts`.
- [ ] **Step 5: Run** the full server suite and `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(europe): live-verified feed, filing, holiday and Tradegate source facts`.

### Task 4: Full-level lists and live verification (CIKs, ADR ratios, Cboe chains, filer form)  [Group A]

**Depends on:** nothing. Needs `SEC_USER_AGENT` from the live checkout's `.env` (never printed); if absent, stop and ask.

**Files:**
- Create: `server/src/europe/universe.ts`, `server/src/cli/verifyEuropeUniverse.ts`, `server/test/europe/universe.test.ts`
- Modify: `server/package.json` (`"verify-europe-universe": "tsx src/cli/verifyEuropeUniverse.ts"`)
- Fixtures in `server/test/fixtures/europe/sec/`: one real results 6-K exhibit each for AZN, HSBC, ASML and NVO, and one 8-K Ex-99.1 for an 8-K filer if any (Task 6 and Task 7 use them).

**Interfaces:**
- `interface EuropeFullEntry { market: EuropeMarket; symbol: string; isin: string; adr: string; adrRatio: number; adrRatioVerified: boolean; cik: number; secForm: '6-K' | '8-K'; names: readonly string[] }`
- `UK_FULL`, `EU_FULL: readonly EuropeFullEntry[]`, as verified
- `europeFullFor(market, symbol): EuropeFullEntry | undefined`
- `europeIssuerFor(adrOrSymbol: string): { names: readonly string[]; ticker: string } | undefined` (the reader's issuer guard, as `jpIssuerFor`)
- `europeLevel(e: { cik: number | null; adr: string | null }): 'full' | 'basic'`
- `europeAdrRatioShown(e): number | null`: the ratio only when `adrRatioVerified`
- `verifyEuropeUniverse.ts [--market uk|eu]`: the JP script adapted. Its own 120 ms SEC client and a 2,500 ms Cboe client. Per entry it prints:
  - `company_tickers.json` CIK vs `cik`
  - the forms of the last 24 months (`6-K` vs `8-K`/`10-Q`) vs `secForm`
  - the Cboe chain (exists / 403)
  - the ADR-ratio sentence from the latest 20-F (or "ordinary share" for 10-K/8-K filers, ratio 1)
  - the price-implied ratio: ADR close × FX ÷ local close (GBp ÷ 100), FX from Yahoo `GBPUSD=X` / `EURUSD=X` / …
  - `adrRatioVerified` is printed `true` only when the 20-F ratio and the implied ratio agree within 15% (JP rule)

  It exits 1 on any mismatch and never touches a database. The ratio regexes are JP's plus `one-half of one`.

- [ ] **Step 1: Write failing tests** (`universe.test.ts`):
  - `'symbols, ADRs and ISINs unique per market'`
  - `'HSBC is UK full with HSBA.L and CIK 1089113'`
  - `'every symbol suffix matches its market (UK .L only)'`
  - `'ratio shown only when verified'`
  - `'no entry without a local line'`
- [ ] **Step 2: Run** `npx vitest run test/europe/universe.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `universe.ts` with the Source-facts rows and the CLI.
- [ ] **Step 4: Verify live.**
  - Run `npm run verify-europe-universe -w server -- --market uk`, then `-- --market eu`.
  - Fix each CIK, form and ratio from SEC.
  - Drop a name with no Cboe chain (it stays basic through the universe).
  - Drop a name with no local primary line (ARM, SPOT, NXPI, BNTX and CHKP are expected; CRH to check).
  - Save the four fixtures.
  - Re-run until both exit 0.
- [ ] **Step 5: Run** the full server suite and `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(europe): live-verified UK and EU full-level lists`. The body pastes both CLI outputs and lists the dropped names for a user ruling.

### Task 5: Calendars, gov.uk bank holidays, periods  [Group B]

**Depends on:** Tasks 1 and 3.

**Files:**
- Create: `server/src/europe/domain/calendars.ts`, `server/src/europe/domain/bankHolidays.ts`, `server/src/europe/domain/period.ts`
- Test: `server/test/europe/calendars.test.ts`, `server/test/europe/period.test.ts`

**Interfaces:**
- `bankHolidays.ts`:
  - `parseGovUkBankHolidays(json: unknown): string[]`: the `england-and-wales` dates, sorted. A wrong shape throws `SourceFormatError`.
  - `LSE_HOLIDAYS_SEED: Record<number, ReadonlySet<string>>`: 2026–2027 from the Source-facts table (used until the job has stored the JSON)
- `calendars.ts`:
  - `calendarFor(ex: ExchangeId, extraHolidays?: ReadonlySet<string>): ExchangeCalendar`: `makeExchangeCalendar` with the exchange zone, the holidays, `openMin`/`closeMin` from `EXCHANGES`, `amcAtClose: true` and `unknownFrom: '2028-01-01'`. `extraHolidays` (LSE: the stored gov.uk dates) are unioned with the seed.
  - `TRADEGATE_CAL: ExchangeCalendar` (Europe/Berlin, 08:00–22:00)
  - `marketToday(market: EuropeMarket): string`: London for UK, Paris for EU
  - `europeDateFromUs(ex: ExchangeId, usDate: string, usTiming: LocalTiming): string`, via `localDateFromUs`
  - `europeReactionWindow(ex, reportDate, timing)`, via `reactionWindow`
  - `holidaysUnknown(ex, d): boolean`
- `period.ts`:
  - `interface EuropePeriod { periodEnd: string; fiscalQuarter: 1 | 2 | 3 | 4; fyEnd: string }`
  - `europePeriodFor(reportDate: string, fyEndMonth: number): EuropePeriod` (Ruling 7)
  - `europePeriodLabel(p: EuropePeriod): string`

- [ ] **Step 1: Write failing tests.**
  - `calendars.test.ts`:
    - `'gov.uk JSON parsed; 2026-12-28 substitute day closed on LSE; 2026-12-24 open'`
    - `'Oslo closed 2026-05-14 (Ascension) and 2027-05-17; Xetra open 2026-05-25 (Whit Monday)'`
    - `'SIX closed 2026-01-02; Milan closed 2026-12-24; Stockholm closed 2026-06-19'`
    - `'timing: LSE 07:59 BMO, 08:00 DMH, 16:29 DMH, 16:30 AMC; Helsinki 18:30 AMC; Oslo 16:20 AMC'`
    - `'US AMC 2026-11-05 → LSE 2026-11-06; US BMO → same day'`
    - `'reaction window across the LSE Christmas closure'`: `europeReactionWindow('LSE', '2026-12-24', 'AMC')` → `{ before: '2026-12-24', after: '2026-12-29' }`
    - `'2028 dates: weekends only and holidaysUnknown true'`
  - `period.test.ts`:
    - `('2026-07-30', 12)` → `2026-06-30`, Q2, `'H1 FY26'`
    - `('2026-11-05', 3)` → `2026-09-30`, Q2, fyEnd `2027-03-31`, `'H1 FY27'` (Vodafone)
    - `('2027-02-12', 12)` → `2026-12-31`, Q4, `'FY26'`
    - `('2026-05-20', 12)` → `2026-03-31`, Q1, `'Q1 FY26'`: the raw rule. Review Focus 1 is handled by `period_confirmed` in Task 13.
    - `('2026-10-22', 6)` → `2026-09-30`, Q1, `'Q1 FY27'`
- [ ] **Step 2: Run** `npx vitest run test/europe/calendars.test.ts test/europe/period.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Check the holiday lists per the Source-facts rule before typing; mark the Euronext and Nordic lists `UNCONFIRMED (banned site)` in the header.
- [ ] **Step 4: Run** the full server suite and `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(europe): per-exchange calendars, gov.uk bank holidays, fiscal periods`. The body lists the unconfirmed holiday lists.

### Task 6: Shared 6-K classifier profiles `'uk'`/`'eu'` and a fan-out watcher  [Group B]

**Depends on:** Task 4 (fixtures).

**Files:**
- Modify: `server/src/sources/sixKClassify.ts`, `server/src/sources/sixKWatch.ts`
- Test: `server/test/sources/sixKEurope.test.ts`, `server/test/sources/sixKFanout.test.ts`. Existing `test/sources/sixKClassify.test.ts`, `sixKWatch.test.ts`, `test/hk/*` and `test/jp/*` stay untouched.

**Interfaces:**
- `SixKProfile = 'hk' | 'jp' | 'uk' | 'eu'`. For `'hk'` and `'jp'`, every branch stays byte for byte.
- Profiles `'uk'` and `'eu'` add:
  - **Results phrases:**
    - `(half[- ]year|interim|full[- ]year|preliminary|annual|first quarter|third quarter|second quarter|fourth quarter|Q[1-4]|H[12]|[1-4]Q) (\d{4} )?(financial )?(results|report|trading (update|statement))`
    - `results for the (three|six|nine|twelve) months ended`
    - `(half|full)[- ]year \d{4} results`
    - `interim management statement`
  - **Period mentions:**
    - `(three|six|nine|twelve) months (ended|to) <date>`
    - `(half year|six months) to <date>`
    - `year (ended|to) <date>`
    - `Q[1-4] \d{4}` with the issuer's fiscal year end if given, else calendar quarters
  - **Date notices:**
    - `will (announce|publish|report) (its )?<results phrase> on <date>`, with an optional clock
    - clock zones `(UK|London) time|BST|GMT` (Europe/London) and `CET|CEST|Central European (Summer )?Time` (Europe/Paris)
    - session phrases `before (the )?(London Stock Exchange|LSE|market) opens?` → `BMO`, `after (the )?close` → `AMC`
  - **`other`:** dividend declarations, buyback / "Transaction in own shares", "Total voting rights", "Director/PDMR shareholding", "Form 20-F" filing notices.
- `sixKWatch.ts`:
  - `SixKMarket.name: 'hk' | 'jp' | 'uk' | 'eu'`
  - `private static routeAll(markets, cik): SixKMarket[]` replaces `route`. `tick` and `onUsFeed` enqueue one job per (market, item).
  - `queued`, `tries` and `gaveUp` are keyed `${market.name}:${accession}`.
  - With every CIK in exactly one market (HK + JP today), behaviour is identical.

- [ ] **Step 1: Write failing tests.**
  - `sixKEurope.test.ts`:
    - `'AZN results 6-K is results for its quarter end'` (fixture from Task 4)
    - `'HSBC interim 6-K under profile uk: results, half'`
    - `'ASML Q3 6-K under profile eu: results, quarter'`
    - `'NVO 9M release: results, nine'`
    - `'"Transaction in own shares" is other'`
    - `'"will announce its half year results on 29 July 2026 at 7.00am (UK time)" → 2026-07-29 BMO'`
    - `'"publish Q3 2026 results on 22 October 2026 at 07:00 CET" → 2026-10-22 BMO'`
    - `'"after the close" → AMC'`
    - `'hk and jp profiles unchanged'`: HK BABA and JP Toyota fixtures give the same results as before
  - `sixKFanout.test.ts`:
    - `'one feed item for a CIK held by HK and UK reaches both handlers'` (Review Focus 3)
    - `'UK handler throwing never re-queues or blocks HK; HK seen does not hide UK'`
    - `'8-K 2.02 fans out the same way'`
    - `'one feed request per tick'`
- [ ] **Step 2: Run** `npx vitest run test/sources/sixKEurope.test.ts test/sources/sixKFanout.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** with `profile === 'uk' || profile === 'eu'` guards.
- [ ] **Step 4: Run** the full server suite and `npx tsc --noEmit`. Expected: PASS; `git diff --stat server/test/hk server/test/jp server/test/sources/sixKClassify.test.ts server/test/sources/sixKWatch.test.ts` is empty.
- [ ] **Step 5: Commit** `feat(sec): 6-K profiles uk/eu; watcher routes a CIK to every market that holds it`.

### Task 7: Reader profiles `'uk'`/`'eu'`, shared gate scoring, corpus CLI  [Group B]

**Depends on:** Task 4 (full lists, fixtures). Needs `SEC_USER_AGENT` for the CLI dry run.

**Files:**
- Create:
  - `server/src/domain/readerGate.ts`
  - `server/src/europe/sources/releaseEurope.ts`
  - `server/src/cli/collectEuropeCorpus.ts`
- Modify:
  - `server/src/sources/releaseReader.ts`
  - `server/src/jp/domain/readerGate.ts` (re-exports with JP's six fields)
  - `server/src/cli/readerCorpus.ts` (`--uk`, `--uk-heldout`, `--eu`, `--eu-heldout`)
  - `server/package.json` (`"collect-europe-corpus": "tsx src/cli/collectEuropeCorpus.ts"`)
- Test: `server/test/europe/releaseEurope.test.ts`, `server/test/domain/readerGate.test.ts`. `test/jp/readerGate*.test.ts` stay untouched.

**Interfaces:**
- `domain/readerGate.ts`:
  - `type GateMark = 'exact' | 'blank' | 'wrong'`
  - `gateMarks(fields, expected, got)`, `gateVerdict(fields, expected, got)`, `carriesValue(fields, expected)`
  - `gateCounts(fields, rows): GateCounts`
  - `gatePasses(c, heldout): boolean`
  - `GATE_MIN_EXACT = 20`
  - The bodies are JP's, with the field list as a parameter.
- `releaseReader.ts`:
  - `ReaderOptions.profile` adds `'uk' | 'eu'`
  - `Currency` adds `'EUR' | 'GBP' | 'GBp' | 'CHF' | 'DKK' | 'SEK' | 'NOK'`, produced only under `'uk'` / `'eu'`
  - `ReaderResult` gains `revenueCurrency` and `epsCurrency` (null for the other profiles)
- **Profiles `'uk'` / `'eu'` rules:**
  1. **Units:** allowlisted captions only, each with an optional `, except per share`:
     - `£m`, `£ million(s)`, `£bn`, `$m`, `US$ million(s)`, `€m`, `€ million(s)`, `EUR million(s)`, `EUR m`, `CHF million(s)`
     - `DKK million(s)`, `SEK m(illion)`, `MSEK`, `NOK million(s)`, `MNOK`, `(in millions of …)`
  2. **EPS units:** `pence`, `p`, `(p)` → `GBp`; `£`, `pounds` → `GBP`; `€`, `EUR` → `EUR`; `$`, `US$`, `USD` → `USD`; `DKK`; `SEK`; `CHF`; `NOK`.
     - A per-ADS / per-ADR row is never read.
  3. **Spans:**
     - **Quarter:** `Q3 2026`, `Q3 26`, `3Q 2026`, `Three months ended/to <date>`, `July–September 2026`.
     - **YTD:** `H1 2026`, `Half year 2026`, `Six months ended/to <date>`, `9M 2026`, `Nine months …`, `FY 2026`, `Year ended <date>`, `Full year`.
     - A dated column must be within 15 days of `periodEnd`.
     - A comparative-year column is never read. `H2` / `Second half` / `Q4` standalone columns are never read for Q4 rows; the FY column is.
  4. **EPS:**
     - Basic: `basic earnings per share`, `basic EPS`, `earnings per share – basic`, `(statutory|reported|IFRS) basic EPS`.
     - Diluted: `diluted`.
     - **Never read:** `underlying`, `adjusted`, `core`, `headline`, `normalised`, `pre-exceptional`, `continuing operations` when a total row exists.
  5. **Revenue:**
     - Read: `revenue(s)`, `total revenue(s)`, `turnover`, `net sales`, `sales`, `group revenue`, `total income` (banks: HSBC, BCS, LYG, NWG, ING, SAN, BBVA, UBS, DB), `net operating income`.
     - **Never read:** `net interest income`, `operating profit`, `profit before tax`, `gross profit`, `adjusted revenue`, `underlying revenue`, `revenue at constant currency`, `organic`.
  6. **Columns:** a column in another currency than the caption's (convenience translation) is skipped. When two currencies remain, the field is null.
- `releaseEurope.ts`:
  - `interface EuropeReleaseValues { revenue: number | null; revenueCurrency: string | null; eps: number | null; epsDiluted: number | null; epsCurrency: string | null; span: 'quarter' | 'ytd' | null; ytdMonths: 6 | 9 | 12 | null; notes: string[] }`
  - `readEuropeRelease(html: string, period: { periodEnd: string; fiscalQuarter: 1 | 2 | 3 | 4; profile: 'uk' | 'eu'; issuer?: { names: readonly string[]; ticker: string } }): EuropeReleaseValues`
  - Algorithm: the JP order. Quarter first; else YTD (`half` / `nine` / `year` for Q2 / Q3 / Q4) with `ytdMonths` 6 / 9 / 12. One span per release; never computed.
- `EUROPE_GATE_FIELDS = ['revenue', 'revenueCurrency', 'eps', 'epsDiluted', 'epsCurrency', 'span', 'ytdMonths'] as const` (in `releaseEurope.ts`)
- `collectEuropeCorpus.ts --profile uk|eu [--heldout]`:
  - JP's collector over `UK_FULL` / `EU_FULL`: 6-K for `6-K` filers, 8-K Ex-99.1 for `8-K` filers, the last 24 months.
  - It uses `classifySixK(…, { profile, filedOn })` and saves `results` exhibits ≤ 3 MB as `<ADR>_<periodEnd>.htm` in `test/fixtures/europe/releases/<profile>/[heldout/]`.
  - Entries carry the 7 gate fields as null, `checked: false` and `note: ''`. Existing entries are never changed.
- `readerCorpus.ts --uk | --uk-heldout | --eu | --eu-heldout`: as `runJp`, with `EUROPE_GATE_FIELDS`. It prints the `ukEps`/`ukRevenue` (or `eu…`) config lines.

- [ ] **Step 1: Snapshot.** Write each to the scratchpad:
  - `npm run reader-corpus -w server > eu-before-us.txt`
  - `-- --hk > eu-before-hk.txt`
  - `-- --jp > eu-before-jp.txt`
  - `-- --jp-heldout > eu-before-jph.txt`
- [ ] **Step 2: Write failing tests.**
  - `readerGate.test.ts`: JP's scoring cases re-asserted through `gateCounts(JP_GATE_FIELDS, …)`, and one 7-field case
  - `releaseEurope.test.ts`, as small inline tables:
    - `'UK pence EPS: Basic earnings per share (pence) 12.3 → eps 12.3 GBp, revenue £m → GBP'` (Review Focus 2)
    - `'£ EPS stays GBP'`
    - `'H1 only → ytd 6; Q2 column present → quarter'`
    - `'underlying/adjusted/core EPS never read; statutory basic read'`
    - `'bank: total income read, net interest income never'`
    - `'US$ convenience column skipped in a € table'`
    - `'Q4 row reads FY column, never H2'`
    - `'trading update with revenue only → eps null'`
    - `'no unit caption → revenue null'`
  - The AZN, HSBC, ASML and NVO fixtures from Task 4 give the hand-read values typed in the test from each document (never copied from reader output).
- [ ] **Step 3: Run** `npx vitest run test/europe/releaseEurope.test.ts test/domain/readerGate.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement** with `profile === 'uk' || profile === 'eu'` guards. Then run `npm run collect-europe-corpus -w server -- --profile uk` once as a dry run, and delete the output: Task 17 collects for real.
- [ ] **Step 5: Run** the four corpus commands again and `fc` them against Step 1. Expected: identical. Then the full server suite and `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(europe): reader profiles uk/eu, shared gate scoring, corpus collector`.

### Task 8: Universe build: FIRDS, SIX list, GLEIF, OpenFIGI, Yahoo symbols  [Group B]

**Depends on:** Tasks 1, 2 and 4.

**Files:**
- Create:
  - `server/src/europe/sources/firds.ts`, `sixList.ts`, `gleif.ts`, `openFigi.ts`
  - `server/src/europe/universeBuild.ts`
- Modify: `server/src/sources/zip.ts` (add streaming)
- Test: `server/test/europe/firds.test.ts`, `server/test/europe/openFigi.test.ts`, `server/test/europe/universeBuild.test.ts`, `server/test/sources/zipStream.test.ts`. `test/sources/zip.test.ts` stays untouched.

**Interfaces:**
- `zip.ts`: `streamZipEntryText(buf: Uint8Array, want: (name: string) => boolean): AsyncIterable<string>`. Method 8 through `zlib.createInflateRaw`, UTF-8 chunks.
  - If Task 1 found a part too big to hold zipped in memory, the signature takes a file path and the zip is downloaded to the scratch/data dir. Record which in the header.
- `firds.ts`:
  - `interface FirdsShare { isin: string; fullName: string; cfi: string; lei: string | null; mic: string; issuerRequested: boolean; terminated: boolean }`
  - `parseFirdsRecords(xml: string): FirdsShare[]`: complete `<RefData>` blocks only, `ES*` CFI only
  - `fetchFirdsShares(http: Http, source: 'esma' | 'fca', mics: ReadonlySet<string>, onShare: (s: FirdsShare) => void): Promise<{ files: number; complete: boolean }>`: index → each FULINS_E part → stream → records whose MIC is in `mics`
- `sixList.ts`: `parseSixList(text: string): { isin: string; symbol: string; name: string; currency: string }[]`
- `gleif.ts`: `fetchLegalNames(http: Http, leis: string[]): Promise<Map<string, string>>`. Batches as Task 1 found; a failed batch leaves its LEIs absent.
- `openFigi.ts`:
  - `interface FigiAnswer { isin: string; exchCode: string; tickers: string[] }`
  - `createOpenFigi(o: { key?: string; fetchImpl?: typeof fetch; now?: () => number }): { map(jobs: { isin: string; exchCode: string }[]): Promise<FigiAnswer[]> }`
    - 10 jobs and 2.5 s per request without a key (25/min); with a key, the published limits.
    - The key goes only in a header; errors never contain it.
- `universeBuild.ts`:
  - `interface EuropeUniverseEntry { market: EuropeMarket; symbol: string; isin: string; lei: string | null; name: string; exchange: ExchangeId; mic: string; country: string; currency: string; adr: string | null; adrRatio: number | null; adrRatioVerified: boolean; cik: number | null; secForm: '6-K' | '8-K' | null }`
  - `pickPrimaryLines(shares: FirdsShare[]): { picked: Map<string, FirdsShare>; ambiguous: string[] }` (Ruling 4)
  - `yahooSymbolFor(ex: ExchangeId, figiTicker: string): { exact: string } | { candidates: string[] }` (Ruling 5). For `search` exchanges, the candidates split a trailing class letter: `ERICB` → `['ERIC-B.ST', 'ERICB.ST']`.
  - `buildEuropeUniverse(o: { firdsUk; firdsEu; six; names: Map<string, string>; figi: FigiAnswer[]; searched: Map<string, string[]>; full: readonly EuropeFullEntry[] }): { uk: EuropeUniverseEntry[]; eu: EuropeUniverseEntry[]; leftOut: { isin: string; reason: 'ambiguous-line' | 'no-ticker' | 'ambiguous-ticker' | 'not-confirmed' }[] }`
    - Full entries override level/ADR/CIK.
    - A full symbol missing from the build is still kept, and logged.

- [ ] **Step 1: Write failing tests.**
  - `zipStream.test.ts`: `'streams a deflated entry in chunks equal to the whole'`
  - `firds.test.ts`:
    - `'parses real records: ISIN, CFI, LEI, MIC, IssrReq'`
    - `'non-share CFI and terminated lines dropped'`
    - `'a record cut mid-block is not emitted'`
  - `openFigi.test.ts`:
    - `'10 jobs per request; 2.5 s apart'` (fake clock)
    - `'key only in header; 401 error text has no key'` (key `sekrit-123`)
    - `'warning answer → no tickers'`
  - `universeBuild.test.ts`:
    - `'IssrReq primary line; dual line resolved by ISIN country; still two → ambiguous, left out'`
    - `'UK primary ISIN never in EU'` (Shell `GB00BP6MXD84` on XLON and XAMS)
    - `'BT/A → BT-A.L exact'`
    - `'ERICB on STO → confirmed ERIC-B.ST by ISIN search; unconfirmed → left out'`
    - `'two figi tickers on one exchange → ambiguous-ticker, left out'`
    - `'full entry overrides: HSBA.L full with HSBC'`
    - `'GLEIF name preferred; FIRDS FullNm trimmed otherwise'`
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the full server suite and `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(europe): universe from FIRDS/SIX + GLEIF names + OpenFIGI/Yahoo symbols`.

### Task 9: Shared Yahoo sweep turns and the UK/EU Cboe cache  [Group B]

**Depends on:** nothing in this plan (the existing JP scheduler).

**Files:**
- Create: `server/src/sources/sweepTurns.ts`, `server/src/sources/cboeCache.ts`
- Modify: `server/src/jp/jobs/scheduler.ts`: `calendarJob` runs `refreshJpCalendar` inside `sweepTurns.run('jp', …)`. Nothing else changes.
- Test: `server/test/sources/sweepTurns.test.ts`, `server/test/sources/cboeCache.test.ts`. `test/jp/scheduler.test.ts` stays untouched and green.

**Interfaces:**
- `sweepTurns.ts`:
  - `interface SweepTurns { run<T>(who: 'jp' | 'uk' | 'eu', fn: () => Promise<T>): Promise<T>; active(): string | null }`
  - `createSweepTurns(): SweepTurns`: one at a time, FIFO. A run that throws releases the turn.
  - `sweepTurns: SweepTurns`: the process singleton
  - `EUROPE_DATE_SWEEP = { UK: { perRun: 20, peakPerRun: 60 }, EU: { perRun: 50, peakPerRun: 150 }, peakWindows: [['01-20','03-10'],['04-20','05-31'],['07-20','08-31'],['10-20','11-30']] } as const` (Ruling 12)
  - `europeDateSweepPerRun(market: EuropeMarket, today: string): number`
- `cboeCache.ts`: `cachedChains(fetch: (adr: string) => Promise<OptionChain | null>, o?: { ttlMs?: number /* 900_000 */; now?: () => number }): (adr: string) => Promise<OptionChain | null>`
  - One in-flight request per ADR.
  - `null` (no chain) is cached; thrown errors are not.

- [ ] **Step 1: Write failing tests.**
  - `sweepTurns.test.ts`:
    - `'jp, uk and eu runs never overlap and run in arrival order'`
    - `'a throwing run releases the turn'`
    - `'perRun: UK 20 on 2026-09-15, 60 on 2026-10-28; EU 150 on 2026-02-01'`
    - `'peak total with JP stays ≤ 300 per 10 min'`: `europeDateSweepPerRun('UK', d) + europeDateSweepPerRun('EU', d) + jpDateSweepPerRun(d) <= 300` for every MM-DD
  - `cboeCache.test.ts`:
    - `'second call within 15 min served from cache'`
    - `'concurrent calls share one fetch'`
    - `'errors not cached'`
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the full server suite and `npx tsc --noEmit`. Expected: PASS; `git diff --stat server/test/jp` is empty.
- [ ] **Step 5: Commit** `feat(sources): Yahoo sweep turns shared by JP/UK/EU; 15-minute Cboe chain cache`.

### Task 10: Tradegate client, robots check, limiter and back-off  [Group B]

**Depends on:** Task 3.

**Files:**
- Create: `server/src/europe/sources/robots.ts`, `server/src/europe/sources/tradegate.ts`
- Test: `server/test/europe/robots.test.ts`, `server/test/europe/tradegate.test.ts`

**Interfaces:**
- `robots.ts`: `robotsAllows(robotsTxt: string, path: string, ua?: string): boolean`
  - Groups by `User-agent`. The `*` group applies unless a group names the UA's product token.
  - Longest-match `Allow`/`Disallow`, `*` and `$` wildcards (RFC 9309).
- `tradegate.ts`:
  - `interface TradegateQuote { isin: string; last: number | null; close: number | null; bid: number | null; ask: number | null; changePct: number | null; at: string /* fetch time, ISO */ }`
  - `parseTradegate(json: unknown, isin: string, at: string): TradegateQuote | null`
    - Number format as Task 3 recorded.
    - `null` when neither `last` nor `close` is a number (not quoted).
    - `changePct` only when both are numbers and `close > 0`.
  - `type TradegateState = 'on' | 'off-env' | 'off-robots' | 'backoff'`
  - `createTradegate(o: { enabled: boolean; fetchImpl?: typeof fetch; now?: () => number; limiter?: SlotLimiter }): { quote(isin: string): Promise<TradegateQuote | null>; checkRobots(): Promise<void>; state(): TradegateState; backoffUntil(): string | null; lastPollAt(): string | null }`
    - One `createSlotLimiter(1000)`, process-wide.
    - Headers: `User-Agent: EUROPE_UA`, `Accept: application/json`.
    - A 429 or 403 → `backoff` for 3,600,000 ms; `quote` returns null without fetching until then.
    - `checkRobots` fetches `TRADEGATE_ROBOTS`. Disallowed → `off-robots` until a later check allows it again. A failed robots fetch keeps the previous state; the first ever failure is `off-robots`.
    - `enabled: false` → `off-env`; it never fetches, not even robots.

- [ ] **Step 1: Write failing tests.**
  - `robots.test.ts`:
    - `'tradegate fixture: /refresh.php allowed, /json/x disallowed'`
    - `'Disallow: / blocks everything'`
    - `'longest match wins'`
  - `tradegate.test.ts`:
    - `'parses the SAP and AZN fixtures; unknown ISIN → null'`
    - `'change from the same answer's close'`
    - `'requests 1 s apart'` (fake clock)
    - `'429 → backoff 1 h, no fetch during it, resumes after'` (Review Focus 5)
    - `'robots disallowing /refresh.php → off-robots, no quote fetch'`
    - `'TRADEGATE_PRICES=0 → off-env, never fetches'`
    - `'User-Agent has no @'`
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the full server suite and `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(europe): Tradegate client with robots self-check, 1 req/s limiter and 1 h back-off`.

### Task 11: PR Newswire and DILA parsers and the issuer matcher  [Group B]

**Depends on:** Task 3.

**Files:**
- Create:
  - `server/src/sources/tar.ts`
  - `server/src/europe/sources/prn.ts`, `server/src/europe/sources/dila.ts`, `server/src/europe/sources/issuerMatch.ts`
- Test: `server/test/sources/tar.test.ts`, `server/test/europe/prn.test.ts`, `server/test/europe/dila.test.ts`, `server/test/europe/issuerMatch.test.ts`

**Interfaces:**
- `tar.ts`: `untarEntries(buf: Uint8Array, want: (name: string) => boolean): Map<string, Uint8Array>`
  - gzip detected by magic bytes; ustar headers.
  - A truncated archive throws `SourceFormatError`.
- `prn.ts`:
  - `interface PrnItem { id: string /* link */; title: string; link: string; publishedAt: string /* ISO */; description: string; contributor: string | null }`
  - `parsePrnRss(xml: string): PrnItem[]`
  - `isResultsTitle(title: string): boolean`:
    - Matches: `(half[- ]year|interim|full[- ]year|preliminary|annual|Q[1-4]|first|second|third|fourth quarter|nine[- ]month|9M|H1|H2|FY) .*results`, `results for the`, `trading (update|statement)`, `interim management statement`.
    - Never: `notice of|date of|to announce|will (announce|report|publish)|conference call|webcast`.
- `dila.ts`:
  - `interface DilaDoc { id: string; isin: string | null; issuer: string; type: string; subtype: string | null; filedAt: string; title: string; url: string | null }`
  - `listDilaFiles(html: string, day: string): string[]`
  - `parseDilaArchive(buf: Uint8Array): DilaDoc[]`
  - `isDilaResults(d: DilaDoc): boolean`, via `DILA_RESULTS_TYPES`
- `issuerMatch.ts`:
  - `normaliseIssuer(name: string): string`: lower case, accents folded, punctuation stripped. It also strips `plc`, `p.l.c.`, `limited`, `ltd`, `group`, `holdings?`, `se`, `n.v.`, `nv`, `ag`, `s.a.`, `sa`, `s.p.a.`, `spa`, `asa`, `ab (publ)`, `ab`, `a/s`, `as`, `oyj`, `abp`, `sca`, `kgaa`, `& co`, and `the` at the start.
  - `createIssuerIndex(entries: { symbol: string; isin: string; name: string }[]): { byName(name: string): string[]; byIsinIn(text: string): string[] }`

- [ ] **Step 1: Write failing tests.**
  - `tar.test.ts`:
    - `'reads the DILA sample'`
    - `'truncated archive throws'`
  - `prn.test.ts`:
    - `'parses items with pubDate to the second'`
    - `'results titles yes; "to announce Q3 results on" no; "conference call" no'`
  - `dila.test.ts`:
    - `'listing → today's files'`
    - `'archive → ISIN-tagged docs; results type recognised; AGM notice not'`
  - `issuerMatch.test.ts`:
    - `'"Shell plc" and "SHELL PLC." normalise equal'`
    - `'"Shell Midstream Partners" does not match Shell plc'`
    - `'two companies with one normalised name → byName returns both'` (Review Focus 4)
    - `'ISIN in text found'`
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the full server suite and `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(europe): PR Newswire and DILA INFOFI parsers, tar reader, issuer matcher`.

### Task 12: filings.xbrl.org ESEF client and xBRL-JSON parser  [Group B]

**Depends on:** Task 3.

**Files:**
- Create: `server/src/europe/sources/esef.ts`
- Test: `server/test/europe/esef.test.ts`
- Fixture corpus in `server/test/fixtures/europe/esef/`: ≥ 5 real `json_url` answers, gzipped:
  - a UK GBP filer
  - a EUR filer
  - a bank (no `Revenue` fact)
  - an SEK/DKK/CHF filer, if any is in ESEF (CH is not)
  - a filer reporting EPS in pence

  Plus `expected.json`, typed by hand from the same filing's `report_url` xHTML, **never** from the parser.

**Interfaces:**
- `interface EsefFiling { fxoId: string; lei: string; country: string; periodEnd: string; dateAdded: string; jsonUrl: string; reportUrl: string | null }`
- `createEsefClient(o?: { fetchImpl?: typeof fetch; minIntervalMs?: number /* 1000 */ }): { recent(countries: readonly string[], sinceDateAdded: string): Promise<EsefFiling[]>; facts(jsonUrl: string): Promise<unknown> }`: `sort=-date_added`, paging until older than `since` (max 20 pages)
- `interface EsefFigures { revenue: number | null; revenueCurrency: string | null; epsBasic: number | null; epsDiluted: number | null; epsCurrency: string | null; notes: string[] }`
- `parseEsefFacts(json: unknown, periodEnd: string): EsefFigures`
  - The duration must be 12 months ending `periodEnd` (± 3 days). No dimension other than `concept`/`entity`/`period`/`unit`/`language`.
  - Concepts:
    - revenue: `ifrs-full:Revenue`, `ifrs-full:RevenueFromContractsWithCustomers`
    - EPS: `ifrs-full:BasicEarningsLossPerShare`, `ifrs-full:DilutedEarningsLossPerShare`
  - Units: `iso4217:XXX` → `XXX`; `iso4217:XXX/xbrli:shares` → EPS `XXX`. `GBX` per share is EPS `GBp`.
  - Disagreeing facts for one field → that field is blank. Bank interest-income concepts are never revenue.

- [ ] **Step 1: Write failing tests.**
  - `'every corpus filing matches expected exactly'`
  - `'bank: revenue null, EPS read'`
  - `'dimensioned fact ignored'`
  - `'6-month duration ignored'`
  - `'two different Revenue values → revenue null'`
  - `'GBX/shares → GBp'`
  - `'client pages until since; 1 s apart'`
- [ ] **Step 2: Run** `npx vitest run test/europe/esef.test.ts`. Expected: FAIL.
- [ ] **Step 3: Collect the corpus** (1 req/s) and type the expected values.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run** the full server suite and `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(europe): filings.xbrl.org ESEF client and annual revenue/EPS parser`.

### Task 13: `europe_*` tables, repository, job context, DTO, read routes, config  [Group C]

**Depends on:** Tasks 1, 2, 4, 5, 8, 10, 11 and 12 (types).

**Files:**
- Create:
  - `server/src/europe/db/schema.ts`, `server/src/europe/db/europeRepo.ts`
  - `server/src/europe/jobs/context.ts`
  - `server/src/europe/api/types.ts`, `dto.ts`, `routes.ts`
- Modify:
  - `server/src/db/repo.ts`: `openDb` calls `ensureEuropeSchema` after `ensureJpSchema`.
  - `server/src/api/server.ts`: `ServerOptions.europe?: { UK?: EuropeServerOptions; EU?: EuropeServerOptions }`; calls `registerEuropeRoutes` per market.
  - `server/src/config.ts`:
    - `openFigiApiKey: process.env.OPENFIGI_API_KEY ?? ''`
    - `tradegatePrices: process.env.TRADEGATE_PRICES !== '0'`
    - `fastFields.ukEps?`, `ukRevenue?`, `euEps?`, `euRevenue?`, all `false`
    - the comment `UK/EU reader gate: not yet run`
- Test: `server/test/europe/europeRepo.test.ts`, `server/test/europe/api.test.ts`

**Interfaces:**
- **Schema** (additive; `ADDED_COLUMNS` as JP):
  - `europe_stocks`:
    - Identity and listing: `symbol PK, market, exchange, isin, lei, name, mic, country, currency`
    - Fiscal year: `fy_end_month NULL, fy_end_source ('esef'|'yahoo')`
    - Full level: `level, adr, adr_ratio, adr_ratio_verified, cik, sec_form`
    - Profile: `sector, industry, market_cap, market_cap_currency, market_cap_as_of`
    - State: `active, missed_refreshes, updated_at`
    - `UNIQUE(market, isin)`
  - `europe_reports`:
    - Identity, date and period: `id PK, market, symbol, name, exchange, period_end, fiscal_quarter, fy_end, period_label, period_confirmed, report_date, date_status, rescheduled_from`
    - Timing and release: `timing, timing_source ('sec-notice'|'yahoo'|'prn'), released_at, released_source ('sec'|'prn'|'dila'|'yahoo'), signal_title, signal_url`
    - Revenue actual: `revenue_actual, revenue_currency, revenue_source ('sec'|'esef'|'yahoo'), revenue_span, revenue_ytd_months`
    - EPS actual: `eps_actual, eps_diluted_actual, eps_currency, eps_source, eps_span, eps_ytd_months`
    - Documents: `sec_doc_url, esef_url`
    - Estimates: `eps_estimate, eps_analysts, eps_estimate_currency, revenue_estimate, revenue_analysts, revenue_estimate_currency, estimate_span, estimates_fetched_at`
    - Previous move: `prev_move_pct, prev_move_date, prev_move_basis, prev_move_checked_at, calendar_fetched_at`
    - `UNIQUE(symbol, period_end)`
  - `europe_expected_moves`, `europe_live_moves`: as JP
  - `europe_sec_seen (market, accession, cik, kind, seen_at, PK(market, accession))`
  - `europe_date_sweep (symbol PK, checked_at, date_seen_at, announced_date)`
  - `europe_past_dates (symbol, date, timing, PK(symbol, date))`
  - `europe_signal_seen (source, item_id, symbol, outcome, seen_at, PK(source, item_id))`
  - `europe_esef_seen (fxo_id PK, symbol, period_end, outcome, seen_at)`
  - `europe_figi (isin, exch_code, tickers_json, yahoo_symbol, outcome, checked_at, PK(isin, exch_code))`
  - `europe_bank_holidays (date PK, title, fetched_at)`
- **Repo** (`europeRepo.ts`). Each function mirrors its JP namesake unless stated:
  - Setup and stocks:
    - `UK_ID_BASE = 4_000_000_001`, `EU_ID_BASE = 5_000_000_001`, `ensureEuropeSchema(db)`
    - `syncEuropeUniverse(db, market, entries, now): { upserted: number; deactivated: number }`: Ruling 4, inactive after 2 misses. An empty `entries` is refused (throws) so a failed build never deactivates.
    - `setEuropeProfile(db, symbol, p: { name; sector; industry; marketCap; marketCapCurrency; asOf; fyEndMonth?: { month: number; source: 'esef' | 'yahoo' } }, now)`: COALESCE; `esef` beats `yahoo` for the fiscal year end.
    - `europeStocks(db, market)`, `europeFullLevelStocks(db, market)`, `europeStockByIsin(db, market, isin)`, `europeStocksByLei(db, lei)`
  - Calendar and release:
    - `upsertEuropeCalendarRow(db, market, row: { symbol; name; exchange; period: EuropePeriod; periodLabel; periodConfirmed: boolean; reportDate; dateStatus; timing?; timingSource? }, now): number`
    - `confirmEuropePeriod(db, id): void`
    - `recordEuropeRelease(db, id, r: { at: string; source: 'sec' | 'prn' | 'dila' | 'yahoo'; timing: LocalTiming | null; title?: string | null; url?: string | null }): boolean` (Ruling 10)
    - `nearestUnreleasedEurope(db, symbol, day, windowDays = 3)`, `findEuropeReportId(db, symbol, periodEnd)`, `moveEuropeReportDate(db, id, newDate, opts?)`
    - `setEuropeTiming(db, id, timing, source: 'sec-notice' | 'yahoo' | 'prn'): boolean`
  - Actuals and estimates:
    - `mergeEuropeActuals(db, id, a: { revenue?: { value: number; currency: string; span: 'quarter' | 'ytd'; ytdMonths: 6 | 9 | 12 | null } | null; eps?: { basic: number | null; diluted: number | null; currency: string; span; ytdMonths } | null; source: 'sec' | 'esef' | 'yahoo'; docUrl?: string | null; esefUrl?: string | null }, now): boolean`
      - Rank `sec 3 > esef 2 > yahoo 1`. A successful merge sets `period_confirmed = 1`.
    - `setEuropeEstimates(db, id, e: { eps; epsAnalysts; epsCurrency; revenue; revenueAnalysts; revenueCurrency; span: 'quarter' | 'year' }, now)`
  - Lists: `listEuropeRange(db, market, f: { from; to; q: string | null; exchange: ExchangeId | null })`, `listEuropeForSymbols(db, market, symbols, from, to)`, `getEuropeReport(db, id)`
  - Moves: `saveEuropeExpectedMove`, `saveEuropeLiveMove`, `storedEuropeExpectedMove`, `setEuropePrevMove`
  - Job queries:
    - `europeReportsBetween(db, market, from, to): EuropePending[]`, where `EuropePending = { id; symbol; exchange; reportDate; timing; periodEnd; fiscalQuarter; releasedAt; level; adr; cik; hasEps; hasRevenue; expectedFinal }`
    - `europeReportsNeedingPrevMove`, `priorEuropeReleased`
    - `upsertEuropePastDates`, `europePastDates`, `europePastDatesCount(db, market)`
  - SEC, signals, ESEF, FIGI and holidays bookkeeping:
    - `europeSecSeen(db, market, acc)`, `markEuropeSecSeen(db, market, acc, cik, kind, now)`, `lastEuropeSecSeenAt(db, market)`
    - `signalSeen(db, source, itemId)`, `markSignalSeen(db, source, itemId, symbol, outcome, now)`, `lastSignalAt(db, source)`
    - `esefSeen`, `markEsefSeen`, `lastEsefAt`
    - `figiCached(db, isin, exchCode)`, `saveFigi(db, …)`
    - `saveBankHolidays(db, dates: { date: string; title: string }[], now)`, `storedBankHolidays(db): Set<string>`
- **`EuropeJobContext`** (`jobs/context.ts`, re-exports `guardedIn` / `trackIn`):
  ```ts
  interface EuropeJobContext {
    db: DatabaseSync; market: EuropeMarket; now(): string; today(): string;   // London (UK) / Paris (EU)
    yahooCalendar(region: string, from: string, to: string): Promise<{ rows: EuropeCalRow[]; complete: boolean }>;
    yahooSummary(symbol: string, maxAgeMs: number): Promise<YahooForeignSummary | null>;
    yahooQuotes(symbols: string[]): Promise<Map<string, EuropeQuote>>;
    yahooCloses(symbol: string, from: string, to: string): Promise<Map<string, number>>;
    buildUniverse(): Promise<{ entries: EuropeUniverseEntry[]; leftOut: number; complete: boolean }>;
    bankHolidaysJson(): Promise<unknown>;                // UK only; EU never calls it
    esef: ReturnType<typeof createEsefClient>;
    prnFeed(): Promise<PrnItem[]>;                       // this market's PRN_FEEDS, merged, de-duplicated by link
    dila: { list(day: string): Promise<string[]>; archive(name: string): Promise<Uint8Array> } | null; // EU only
    optionChain(adr: string): Promise<OptionChain | null>;   // cboeCache over sources.optionChain
    secHttp: Http | null;
    tierA(): string[];
  }
  ```
- **Types** (`api/types.ts`):
  - `EuropeFigureDto`: JP's `JpFigureDto`, with `actualSource: 'sec' | 'esef' | 'yahoo' | null`.
  - `EuropeReportDto`:
    - Identity: `{ id; market: 'UK' | 'EU'; symbol; isin; name; exchange: ExchangeId; exchangeName; country; level; adrTicker; adrRatio }`
    - Date and period: `reportDate; dateStatus; period: string | null; periodEnd; fiscalQuarter; fyEnd`
    - Timing and release: `timing; timingSource; releasedAt; releasedSource; signal: { title: string; url: string } | null`
    - Company: `sector; industry; marketCap; marketCapCurrency; marketCapAsOf`
    - Documents: `secDocUrl; esefUrl`
    - Figures: `eps: EuropeFigureDto; epsDiluted: number | null; revenue: EuropeFigureDto`
    - Moves: `expectedMove; liveMove; previousMove`
  - `EuropeLivePriceDto { price: number; prevClose: number | null; changePct: number | null; at: string; currency: string | null; venue: 'tradegate' | 'yahoo' }`
  - `EuropeMarketDto` (as JP)
  - `EuropeAdminDto { UK: EuropeMarketAdmin; EU: EuropeMarketAdmin; tradegate: { state: TradegateState; backoffUntil: string | null; lastPollAt: string | null }; secConfigured: boolean; openFigiConfigured: boolean }`
  - `EuropeMarketAdmin { full: number; basic: number; inactive: number; leftOut: number; lastUniverseAt: string | null; lastSixKAt: string | null; lastPrnAt: string | null; lastDilaAt: string | null; lastEsefAt: string | null; readerOn: boolean }`
- **DTO:** `toEuropeDto(r: EuropeReport): EuropeReportDto`. The JP comparison rule, with **EPS compared only when `epsCurrency === epsEstimateCurrency`** and revenue only when `revenueCurrency === revenueEstimateCurrency`. `period` is null when `period_confirmed = 0`.
- **Routes:** `registerEuropeRoutes(app, db, market, currentUser, nowFn, opts: EuropeServerOptions)`:
  - `GET /api/{uk|eu}/earnings?from&to&q&exchange`, `/earnings/:id`, `/prices`, `/markets`
  - `EuropeServerOptions` = `JpServerOptions` with the Europe DTOs

- [ ] **Step 1: Write failing tests.**
  - `europeRepo.test.ts`:
    - `'UK ids from 4_000_000_001, EU from 5_000_000_001, independent'`
    - `'precedence sec > esef > yahoo; equal first wins; null never blanks'`
    - `'GBp EPS and GBP revenue kept apart'`
    - `'earliest release signal wins; later sec does not move releasedAt'`
    - `'inactive after two consecutive misses, not one; empty build refused'`
    - `'esef fiscal year end beats yahoo'`
    - `'merge confirms the period'`
    - `'migration is additive: opening an existing JP database adds tables and changes no jp_ row'`
  - `api.test.ts`:
    - `'GBp actual vs GBP estimate: no colour, both shown'` (Review Focus 2)
    - `'unconfirmed period served as null'` (Review Focus 1)
    - `'exchange filter on /api/eu/earnings'`
    - `'/api/uk/earnings/:id 404 for an EU id'`
    - `'markets falls back to index quotes'`
- [ ] **Step 2: Run** `npx vitest run test/europe/europeRepo.test.ts test/europe/api.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the full server suite and `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(europe): europe_* tables, repository, job context, DTO and /api/uk, /api/eu read routes`.

### Task 14: Markets `'UK'` and `'EU'` across shared server plumbing, status and admin  [Group D]

**Depends on:** Task 13.

**Files:**
- Modify:
  - `server/src/india/api/types.ts`: `Market = 'US' | 'IN' | 'HK' | 'JP' | 'UK' | 'EU'`
  - `server/src/india/db/inRepo.ts`: prefs round-trip both
  - `server/src/india/api/routes.ts`: error text names all six
  - `server/src/watchlist/store.ts`: CHECK lists six. `rebuildWatchlists` runs when the stored SQL lacks `'EU'`; rows are copied.
  - `server/src/watchlist/routes.ts`: `asMarket` accepts both; normalise with the Ruling 2 regexes; `/rows` via `listEuropeForSymbols` + `toEuropeDto`.
  - `server/src/watchlist/search.ts`: `europeEntries(db, market): IndexEntry[]` (`exchange` = the exchange name)
  - `server/src/notes/store.ts`:
    - `europeNoteDeadline(r: { reportDate; timing; releasedAt; exchange })`: `releasedAt` + 24 h; else BMO open, UNKNOWN 23:59:59, otherwise close, in the exchange zone, + 24 h.
    - The LEFT JOIN on `europe_reports`.
  - `server/src/notes/routes.ts`: the lookup tries `getEuropeReport`.
  - `server/src/jobs/coverage.ts`: Ruling 15 fields for UK and EU; `runCoverageCheck(db, todayUs, todayIn, todayHk, todayJp, todayUk, todayEu, log)`.
  - `server/src/cli/coverageCheck.ts`
  - `server/src/api/types.ts`: `StatusResponse.coverage.UK/EU`; `WatchRow` includes `EuropeReportDto`.
  - `server/src/api/server.ts`: `/api/status` adds UK and EU; `PUT /api/live/visible` accepts `market: 'UK' | 'EU'` with the Ruling 2 regexes.
  - `server/src/europe/api/routes.ts`: `registerEuropeAdmin(app, db, admin: () => Pick<EuropeAdminDto, 'tradegate'>)` → `GET /api/admin/europe`
- Test: `server/test/europe/plumbing.test.ts`, plus signature updates in existing coverage tests only.

- [ ] **Step 1: Write failing tests** (`plumbing.test.ts`):
  - `'prefs round-trip UK and EU'`
  - `'watchlists table without EU is rebuilt and keeps US/HK/JP rows'`
  - `'UK watch accepts bt-a.l (stored BT-A.L), rejects SAP.DE; EU accepts ERIC-B.ST, rejects AZN.L'`
  - `'note deadline: LSE AMC without release → 16:30 London + 24 h'`: `europeNoteDeadline({ reportDate: '2026-11-05', timing: 'AMC', releasedAt: null, exchange: 'LSE' }) === '2026-11-06T16:30:00.000Z'`
  - `'status has UK and EU coverage; expectedMove counts full only'`
  - `'admin europe: admins only; openFigiConfigured; body never contains the key'`: set `config.openFigiApiKey = 'sekrit-123'`
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the full server suite and `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(europe): markets UK and EU in prefs, watchlists, notes, search, coverage, status and admin`.

### Task 15: Yahoo-side jobs: universe, holidays, date sweep, bulk supplement, past dates, estimates, Yahoo results, previous moves  [Group D]

**Depends on:** Tasks 2, 5, 8, 9 and 13.

**Files:**
- Create: `server/src/europe/jobs/stocks.ts`, `calendar.ts`, `pastDates.ts`, `estimates.ts`, `results.ts`, `prevMoves.ts`
- Test: `server/test/europe/jobs.test.ts` (stub `EuropeJobContext`, fixtures from Tasks 1, 2 and 8)

**Interfaces:**
- `refreshEuropeStocks(ctx): Promise<void>`
  1. `buildUniverse()`, then `syncEuropeUniverse` (skipped when `complete` is false: nothing is deactivated, and a source error `europe-universe` is recorded).
  2. `yahooQuotes` for active symbols → `setEuropeProfile` (cap with its currency).
  3. UK only: `bankHolidaysJson()` → `parseGovUkBankHolidays` → `saveBankHolidays`; a failure keeps the stored dates.
  4. A `europe-holidays` warning when `holidaysUnknown(ex, today + 60)` for any exchange of the market.
- `refreshEuropeCalendar(ctx, opts: { perRun: number }): Promise<void>`: the JP rolling sweep (`jp/jobs/calendar.ts`) over `europe_date_sweep`, **always inside `sweepTurns.run(market)`**.
  - Rows go through `europePeriodFor` with `periodConfirmed` from a trend `0q` end date equal to `periodEnd`.
  - Full level merges the ADR US row per Ruling 11 with `europeDateFromUs`.
  - `nextDateEstimated === false` writes the date as announced (still `estimated` status, as JP).
  - Summary `fyEndMonth` → `setEuropeProfile(… { fyEndMonth: { month, source: 'yahoo' } })` when none is stored.
- `refreshEuropeBulkCalendar(ctx): Promise<void>`: JP's supplement, once per region of the market with `bulkCalendar: true`. It creates rows only for periods without one and sets TAS timing; it never moves a stored date. A no-op when no region is enabled.
- `refreshEuropePastDates(ctx): Promise<number>`: bulk `[today−400, today−1]` per enabled region; 0 requests when none is enabled.
- `refreshEuropeEstimates(ctx): Promise<void>`:
  - Tiers and budget per Ruling 12.
  - A Q4 row takes the year item, otherwise quarter items (JP Ruling 5).
  - Currencies are as stated.
  - `assetProfile` → sector/industry.
- `refreshEuropeYahooResults(ctx): Promise<number[]>`: basic rows in `[today−20, today]` without actuals.
  - The signal is a summary `epsHistory` entry whose period end equals the row's.
  - `mergeEuropeActuals(…, source: 'yahoo', span: 'quarter')`, then `recordEuropeRelease({ at: ctx.now(), source: 'yahoo', timing: null })`.
- `computeEuropePrevMoves(ctx): Promise<void>`: JP's rules with the exchange calendar.
  - Prior date from `priorEuropeReleased`, else the ADR US row, else `europePastDates`, within 45–140 days.
  - Unknown timing → `AMC`, basis `assumed`.

- [ ] **Step 1: Write failing tests** (`jobs.test.ts`):
  - `'universe sync: incomplete build deactivates nothing and records europe-universe'`
  - `'gov.uk holidays stored; fetch failure keeps stored'`
  - `'sweep runs inside sweepTurns and respects perRun'`: the stub turns object records `run('uk', …)`
  - `'AIM FY results dated 2026-05-20 with no confirming source → row period unconfirmed; a Yahoo epsHistory for 2025-12-31 never merges into it'` (Review Focus 1)
  - `'trend 0q end equal to periodEnd confirms the period'`
  - `'full level: US AMC 2026-11-05 + Yahoo AZN.L 2026-11-06 → row 2026-11-06; disagreement without flag → nothing'`
  - `'no fyEndMonth → no row'`
  - `'bulk supplement no-op when no region enabled'`
  - `'estimates: GBp EPS estimate stored GBp; Q4 takes year item; budget respected'`
  - `'Yahoo results flip released with source yahoo and never replace an ESEF value'`
  - `'previous move from the ADR US row maps to the LSE window'`
- [ ] **Step 2: Run** `npx vitest run test/europe/jobs.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the full server suite and `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(europe): universe, holidays, date sweep, estimates, Yahoo results and previous-move jobs`.

### Task 16: Fast signals (PRN, DILA), ESEF results job, ADR expected moves  [Group D]

**Depends on:** Tasks 11, 12 and 13.

**Files:**
- Create: `server/src/europe/jobs/signals.ts`, `esefResults.ts`, `moves.ts`
- Fixture: `server/test/fixtures/europe/cboe_AZN.json` (a live chain, saved as-is)
- Test: `server/test/europe/signals.test.ts`, `server/test/europe/esefResults.test.ts`, `server/test/europe/moves.test.ts`

**Interfaces:**
- `refreshPrnSignals(ctx): Promise<number[]>`. Per unseen item (`signal_seen` source `'prn'`), it flips only when **all** hold (Review Focus 4):
  - `isResultsTitle(title)`
  - the issuer is exactly one active symbol of the market, by `byName(contributor ?? title prefix before the first ' - '/':')` or exactly one `byIsinIn(title + description)`
  - that symbol has an unreleased row with `reportDate` within ±3 days of the item's local date

  Then `recordEuropeRelease({ at: publishedAt, source: 'prn', timing: calendarFor(ex).timingFromClock(local hh:mm), title, url: link })`, and `setEuropeTiming(id, timing, 'prn')` when the row's timing is `UNKNOWN`.

  Outcomes: `flipped` / `no-match` / `ambiguous` / `not-results` / `no-row`. An item is marked seen only after it is handled.
- `refreshDilaSignals(ctx): Promise<number[]>`: EU only, French ISINs.
  - Per unseen file of today's directory, each `isDilaResults` doc whose ISIN is an active EU symbol with a row within ±3 days → `recordEuropeRelease({ at: filedAt, source: 'dila', timing: null, title, url })`.
  - Without `ctx.dila`, a no-op.
- `refreshEsefResults(ctx, since: string): Promise<number[]>`:
  - `esef.recent(countries of the market, since)`, then per unseen `fxoId` whose LEI is an active stock: `parseEsefFacts`, then `findEuropeReportId(symbol, periodEnd)`.
  - Merge with `source: 'esef'`, `span: 'ytd'`, `ytdMonths: 12`, and `esefUrl` (the report URL). Then `setEuropeProfile` with `fyEndMonth` source `esef`.
  - Outcomes: `merged` / `no-row` / `blank` / `error`; an error is not marked seen.
  - UK countries: `['GB']`. EU: the EEA countries of the market's exchanges.
- `snapshotEuropeMoves(ctx)`, `refreshEuropeLiveMoves(ctx)`: `snapshotAdrMoves` / `refreshAdrLiveMoves` with Europe repo deps and the row's exchange calendar.

- [ ] **Step 1: Write failing tests.**
  - `signals.test.ts`, stubbing `prnFeed` with the Task 3 fixtures plus inline items:
    - `'results item for one matched issuer with a row tomorrow flips; timing from pubDate in London'`
    - `'two issuers with one normalised name → ambiguous, no flip'`
    - `'no row within ±3 days → no flip'`
    - `'"to announce results on" → not-results'`
    - `'item seen once'`
    - `'DILA results doc flips the French row; non-results doc does not; DILA never sets timing'`
  - `esefResults.test.ts`:
    - `'FY row merged ytd 12 with source esef and url'`
    - `'never replaces SEC; replaces Yahoo'`
    - `'no row → no-row, nothing created'`
    - `'fyEndMonth from ESEF'`
    - `'fetch error not marked seen'`
  - `moves.test.ts`:
    - `'AZN chain: LSE report 2026-11-06, quote after 16:00 ET on 11-05 → final'`
    - `'basic rows skipped'`
    - `'second chain call within 15 min hits the cache'`
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the full server suite and `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(europe): PR Newswire and DILA results-out, ESEF annual figures, ADR expected moves`.

### Task 17: UK release corpus, held-out set and reader gate (profile `'uk'`)  [Group D]

**Depends on:** Tasks 6, 7 and 13. Needs `SEC_USER_AGENT` (never printed).

**Files:**
- Create:
  - `server/test/fixtures/europe/releases/uk/*.htm` and `expected.json`
  - `server/test/fixtures/europe/releases/uk/heldout/*.htm` and `heldout/expected.json`
  - `server/test/europe/readerGateUk.test.ts`
- Modify: `server/src/config.ts`: `ukEps` / `ukRevenue` and the comment, only per the gate.

**Interfaces:**
- Main set ≥ 20 checked. Required coverage:
  - ≥ 12 of the UK issuers
  - ≥ 3 banks (HSBC, BCS, LYG, NWG)
  - ≥ 3 pence-EPS releases
  - ≥ 3 half-year-only releases
  - ≥ 3 Q1/Q3 trading updates (EPS null expected)
- `--heldout`: 6 releases not in the main set, the newest of 6 different issuers.
- Exact rule: all 7 `EUROPE_GATE_FIELDS` are `===` the hand-read values.

- [ ] **Step 1: Write the failing gate test** (`readerGateUk.test.ts`):
  - `'never wrong'`: every checked entry of both sets gives null or equal on each field
  - `'flags follow both gates'`: `config.fastFields.ukEps === (main && heldout)`, and the same for `ukRevenue`
  - `'corpus big enough'`: main `exactWithValues >= 20` or the flags are false; held-out `checked >= 6`
- [ ] **Step 2: Run** it. Expected: FAIL (no corpus).
- [ ] **Step 3: Collect** both sets before touching the reader: `npm run collect-europe-corpus -w server -- --profile uk`, then `-- --profile uk --heldout`.
- [ ] **Step 4: Hand-check every file.**
  - Read each value from the release itself (basic EPS and its unit, diluted EPS, revenue and its currency, span, YTD months).
  - `note` quotes the row label and the column header.
  - Never copy reader output.
- [ ] **Step 5: Run** `npm run reader-corpus -w server -- --uk`. Fix each `wrong` generically in the `'uk'` profile; Task 7's tests stay green. **Do not open or tune on held-out files.**
- [ ] **Step 6: Run** `-- --uk-heldout` once.
  - On any wrong: fix generically, collect **6 new** held-out releases (moving the failed ones into the main set), and repeat.
  - Flip `ukEps` / `ukRevenue` only when both gates pass; otherwise leave them `false` and record the score in the comment.
  - The four Task 7 snapshot commands still match.
- [ ] **Step 7: Run** the full server suite and `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 8: Commit** `test(europe): UK 6-K release corpus, held-out set and reader gate`. The body gives both scores.

### Task 18: EU release corpus, held-out set and reader gate (profile `'eu'`)  [Group D′]

**Depends on:** Task 17 (it edits `config.ts` after it).

**Files:** as Task 17, with `eu` in place of `uk`; test `server/test/europe/readerGateEu.test.ts`; config `euEps` / `euRevenue`.

**Interfaces:**
- Main set ≥ 20 checked. Required coverage:
  - ≥ 12 EU issuers across ≥ 5 currencies of EUR / USD / CHF / DKK / SEK / NOK
  - ≥ 3 banks (ING, SAN, BBVA, UBS, DB)
  - ≥ 3 nine-month (`ytd 9`) releases
  - ≥ 2 8-K filer releases if any EU full name files 8-K
- Held-out: 6.

- [ ] **Step 1: Write the failing gate test** (`readerGateEu.test.ts`, the three Task 17 cases).
- [ ] **Step 2: Run** it. Expected: FAIL.
- [ ] **Step 3: Collect** `-- --profile eu` and `-- --profile eu --heldout`.
- [ ] **Step 4: Hand-check every file** (as Task 17 Step 4).
- [ ] **Step 5: Run** `-- --eu` and fix wrongs generically under `'eu'`; never touch held-out.
- [ ] **Step 6: Run** `-- --eu-heldout` once.
  - Apply the gate as Task 17.
  - Re-run `-- --uk` and `-- --uk-heldout`: they must not regress, since both profiles share code paths.
  - The four snapshots still match.
- [ ] **Step 7: Run** the full server suite and `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 8: Commit** `test(europe): EU 6-K/8-K release corpus, held-out set and reader gate`. The body gives both scores.

### Task 19: Live: Europe on the shared 6-K watcher, SEC sweep, prices (Tradegate + Yahoo), scheduler, wiring  [Group E]

**Depends on:** Tasks 6, 9, 10, 13, 14, 15 and 16.

**Files:**
- Create:
  - `server/src/europe/live/europeSixK.ts`, `tradegatePoller.ts`, `europePrices.ts`
  - `server/src/europe/jobs/secSweep.ts`, `scheduler.ts`
- Modify:
  - `server/src/live/delayedPrices.ts`: `DelayedMarket.market: 'HK' | 'JP' | 'UK' | 'EU'`; `test/live/delayedPrices.test.ts` stays untouched
  - `server/src/index.ts`
- Test: `server/test/europe/europeSixK.test.ts`, `tradegatePoller.test.ts`, `europePrices.test.ts`, `scheduler.test.ts`

**Interfaces:**
- `europeSixK.ts`:
  - `handleEuropeFiling(ctx, f: ForeignFiling, gates = config.fastFields): Promise<{ released: number[]; dated: number[] }>`: JP's `handleJpFiling` with:
    - `classifySixK(…, { profile, filedOn: local date of acceptance })`
    - timing from acceptance always `null` (Ruling 9); a date notice sets `confirmed` and `setEuropeTiming(…, 'sec-notice')`
    - `readEuropeRelease` behind `ukEps`/`ukRevenue` or `euEps`/`euRevenue`
    - `recordEuropeRelease({ at: acceptedAt, source: 'sec', timing: null, url: docUrl })`
    - A results classification with the row's `periodEnd` → `confirmEuropePeriod`.
  - `europeSixKMarket(ctx, onChanged): SixKMarket`:
    - `name` is `'uk'` / `'eu'`
    - `ciks()`: the active full-level `6-K` filers; `eightKCiks()`: the `8-K` filers
    - `due()` as JP
- `secSweep.ts`: `sweepEuropeSec(ctx) = sweepSixK(…, europeSixKMarket(ctx, () => {}), today − 45)`
- `tradegatePoller.ts`: `class TradegatePoller`
  - Constructor: `(client: ReturnType<typeof createTradegate>, wanted: () => { isin: string; symbol: string }[], publish: (changed: Record<string, TradegateQuote>) => void, now?: () => number)`
  - Methods: `start()`, `stop()`, `snapshot(): Record<string /* symbol */, TradegateQuote>`, `tick(): Promise<void>`
  - Ruling 14 cadence with `TRADEGATE_CAL`.
  - `checkRobots()` at start and every 7 days.
  - In state `backoff` / `off-*`, `tick` fetches nothing.
- `europePrices.ts`: `class EuropePrices`, which composes `DelayedPrices` (Yahoo, market `UK`/`EU`, Ruling 14 session window, `EUROPE_INDICES`, failover names `yahoo-uk-prices` / `yahoo-uk-indices` / `yahoo-eu-…`) and the one shared `TradegatePoller`.
  - `snapshot(): Record<string, EuropeLivePriceDto>`: the Tradegate quote when the client state is `on` and the symbol has a quote younger than 24 h (`venue: 'tradegate'`, `currency: 'EUR'`, `changePct` from Tradegate only). Else the Yahoo price (`venue: 'yahoo'`, Yahoo `currency`).
  - `visibleCodes()`, `setVisible`, `refresh`, `indices`
- `EUROPE_CRONS`, timezone Europe/London (UK) / Europe/Paris (EU) unless marked ET:
  - `stocks: '0 5 * * 1'`
  - `pastDates: '0 3 * * 0'`
  - `calendar: '*/10 * * * *'` (UK) / `'3-59/10 * * * *'` (EU)
  - `bulkCalendar: '15 */2 * * *'`
  - `estimates: '20,50 * * * *'`
  - `results: '35 */2 * * *'`
  - `prn: '*/2 6-17 * * 1-5'` (London; the job also checks 06:00–18:00 London)
  - `dila: '*/15 7-19 * * *'` (Paris; EU only)
  - `esef: '0 2 * * *'` (since = last seen `date_added`, else today − 30)
  - `secSweep: '25,55 * * * *'`
  - `prevMoves: '40 1 * * *'`
  - `movesSnapshot: '20 16 * * 1-5'` (ET), `liveMoves: '* 9-15 * * 1-5'` (ET)
- `startEuropeScheduler(ctx, job, hooks)` and `warmUpEurope(ctx, job, hooks)`, with job names prefixed `uk-` / `eu-`. Warm-up order:
  1. stocks
  2. pastDates, only when the count is 0
  3. calendar
  4. bulkCalendar
  5. results
  6. secSweep
  7. esef (30 days)
  8. estimates
  9. prevMoves
  10. moves snapshot
- **`index.ts` wiring.** Do not run the server; tests and typecheck only.
  - `const euYahoo = createYahooClient({ limiter: yahooLimiter })`: the one UK/EU client.
  - `const chains = cachedChains((a) => sources.optionChain(a))`
  - `const tradegate = createTradegate({ enabled: config.tradegatePrices })`
  - One `TradegatePoller` whose `wanted()` is the union of UK and EU visible ∪ watched ∪ reporting today/tomorrow, by ISIN.
  - `ukCtx` and `euCtx` (`buildUniverse` runs Task 8's pipeline with `createOpenFigi({ key: config.openFigiApiKey || undefined })`).
  - `ukPrices` and `euPrices` publish `uk-prices` / `uk-indices` / `eu-prices` / `eu-indices`.
  - `buildServer(…, { europe: { UK: {...}, EU: {...} } })`, and `registerEuropeAdmin` with `tradegate.state()`.
  - `startSymbolRefresh` gets `UK` and `EU`; `onWatchAdded` refreshes the matching prices.
  - With `secHttp`: `new SixKWatch([hkSixKMarket(...), jpSixKMarket(...), europeSixKMarket(ukCtx, publish 'uk-results'), europeSixKMarket(euCtx, publish 'eu-results')], …)`.
  - Start both schedulers. Warm-ups chain after JP's (`warmUpJpAfter` pattern: UK after JP settles, EU after UK).
  - `ukPrices.start()`, `euPrices.start()`, `tradegatePoller.start()`.

- [ ] **Step 1: Write failing tests.**
  - `europeSixK.test.ts` (stub `Http` serving the Task 4 fixtures):
    - `'AZN results 6-K flips the matching UK row; timing stays UNKNOWN; period confirmed'`
    - `'gate closed: flipped, no actuals; gate open: SEC actuals with GBp/USD currencies from the reader'`
    - `'HSBC 6-K flips HK 0005 and UK HSBA.L through one SixKWatch tick'` (Review Focus 3)
    - `'date notice confirms date and sets sec-notice timing'`
  - `tradegatePoller.test.ts`:
    - `'1 req/s round-robin, oldest first; ≤ every 30 s in hours, 15 min outside'` (fake clock, Berlin 21:59 vs 22:01)
    - `'backoff state → no fetch'`
  - `europePrices.test.ts`:
    - `'Tradegate quote wins with venue tradegate and EUR; change from Tradegate close only'`
    - `'state backoff/off-env/off-robots → Yahoo price with Yahoo currency'` (Review Focus 5)
    - `'GBp Yahoo price keeps GBp'`
    - `'outside 08:00–22:00 Berlin the last Tradegate close is served with its time'`
  - `scheduler.test.ts`: `'warm-up order; skips pastDates when populated; survives a failing source; calendar job runs inside sweepTurns'`
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement**, then the wiring.
- [ ] **Step 4: Run** the full server suite and `npx tsc --noEmit`. Expected: PASS; `git diff --stat server/test/hk server/test/jp server/test/live` is empty.
- [ ] **Step 5: Commit** `feat(europe): shared 6-K watcher for UK/EU, SEC sweep, Tradegate + Yahoo prices, scheduler and wiring`.

### Task 20: Web: UK and Europe markets, list, exchange filter, strips, status and admin  [Group E]

**Depends on:** Tasks 13 and 14.

**Files:**
- Create: `web/src/components/EuropeStockList.tsx`
- Modify:
  - `web/src/lib/market.ts`: `Market` adds `'UK' | 'EU'`
  - `web/src/hooks/useMarket.ts`
  - `web/src/components/Header.tsx`: buttons `id="market-uk"` labelled `UK` and `id="market-eu"` labelled `Europe`; search placeholder `Find a ticker or company`
  - `web/src/lib/format.ts`
  - `web/src/lib/liveCap.ts`: `todayLondon()`, `todayParis()`
  - `web/src/api.ts`: `fetchEuropeEarnings(market, from, to, q, exchange)`, `fetchEuropePrices(market)`; `fetchReport` handles both; types re-exported
  - `web/src/adminApi.ts`: `fetchEuropeAdmin()`
  - `web/src/hooks/useLiveResults.ts`: 8th and 9th parameters `uk?: EuropeLive`, `eu?: EuropeLive`; events `uk-results`, `uk-moves`, `uk-prices`, `uk-indices` and the `eu-` ones
  - `web/src/hooks/useVisibleSymbols.ts`: market adds `'UK' | 'EU'`
  - `web/src/components/WatchlistView.tsx`: UK/EU branch
  - `web/src/components/Calendar.tsx`: UK/EU state, effects, live groups and render branches. The footers:
    - UK: `Data from SEC EDGAR, Cboe (delayed), Yahoo Finance (delayed ~15 min), Tradegate (real-time, EUR), PR Newswire and ESEF filings via filings.xbrl.org. Times in London time. Prototype, not trading advice.`
    - EU: the same with `DILA (AMF regulated information)` added and `Times in each exchange's local time.`
  - `web/src/components/MarketBar.tsx`: `EuropeMarketBar({ market, live }: { market: 'UK' | 'EU'; live?: EuropeMarketDto[] })` polls `/api/{uk|eu}/markets` every 15 s, merges pushes, and puts `· delayed` after each name.
  - `web/src/components/StatusPage.tsx`: `CoverageTable` for `UK` and `Europe`.
  - `web/src/components/AdminPage.tsx`: a read-only `EuropePanel` with these lines:
    - per market: "Full level N · Basic level M · Inactive I · Left out L"
    - "SEC access: configured / not configured (set SEC_USER_AGENT)"
    - "OpenFIGI key: configured / not configured (optional, OPENFIGI_API_KEY)"
    - "Tradegate real-time prices: on / off (TRADEGATE_PRICES=0) / blocked by robots.txt / paused after 429 until {time}" · "Last Tradegate poll: …"
    - "Universe refreshed: …"
    - "Last PR Newswire item: …" · "Last DILA document: …" (EU) · "Last ESEF filing: …"
    - "6-K reader UK / Europe: on / off until 20 releases and the held-out set are read exactly right"
- Test: `web/test/EuropePlumbing.test.tsx`, `web/test/EuropeStockList.test.tsx`, plus cases in `format.test.ts`, `MarketBar.test.tsx`, `StatusPage.test.tsx`, `AdminPage.test.tsx` and `useLiveResults.test.tsx`

**Interfaces:**
- `format.ts`:
  - `formatEuropePrice(n: number | null, currency: string | null)`:
    - `GBp` → `'1,234.5p'`; `GBP` → `'£12.34'`; `EUR` → `'€12.34'`; `USD` → `'$12.34'`
    - `CHF` / `SEK` / `DKK` / `NOK` → `'CHF 12.34'`; null currency → `'12.34'`; `'—'` for null
  - `formatEuropeMoney(n, currency)`: compact (`'£48.04B'`, `'€1.2T'`, `'SEK 12.4B'`). A GBp cap is never shown as pounds; the cap uses its stated currency.
  - `formatEuropeEps(n, currency)`: `GBp` → `'12.3p'`, `GBP` → `'£0.12'`, `EUR` → `'€1.23'`, negatives with `−`
- `EuropeStockList(props)`: `JpStockList`'s props plus `market: 'UK' | 'EU'`. The key is `${market}:${symbol}`.
- **Row head:**
  - dot, symbol, name
  - `Basic data` tag (title: "Only Yahoo, ESEF and news-feed data is available for this stock: no SEC results or option data")
  - the price with its venue label: `Real-time · Tradegate · EUR`, or `<span className="delayed">Delayed ~15 min</span>`
  - timing; `Time not announced` carries `title="UK/EU companies usually release at 07:00 local; not confirmed for this row."`
- **EU exchange filter:** a select above the list, `All exchanges` plus each exchange present in the rows (`Euronext Paris (FR)`, …). It filters client-side; the choice is kept in `localStorage['eu-exchange']` inside try/catch. UK has no filter.
- **Details** (from `foreignParts`):
  - Stock: `symbol name · {exchangeName}`, and `· ADR AZN (1 ADS = 1 share)` for the full level.
  - Period: `period ?? 'Period not stated'`.
  - Release:
    - `Results out · {PR Newswire | DILA | SEC 6-K | Yahoo} {clock in exchange zone}`, with the signal title as a link when present
    - unreleased full level: muted `SEC 6-K usually arrives within hours of the 07:00 release`
  - Figures: `CurrencyFigure` with `formatEuropeEps` / `formatEuropeMoney` and each side's currency; source `Yahoo` / `ESEF annual report`; the span label via `jpSpanLabel`; the "not compared" note as JP.
  - Moves: expected / live / previous moves from the parts.
  - `NoteEditor`.

- [ ] **Step 1: Write failing tests.**
  - `EuropePlumbing.test.tsx`:
    - `'UK button switches market, PUTs prefs and requests /api/uk/earnings'`
    - `'Europe button requests /api/eu/earnings'`
    - `'stored EU market restored'`
  - `format.test.ts`:
    - `formatEuropePrice(1234.5, 'GBp') === '1,234.5p'`
    - `formatEuropePrice(12.34, 'CHF') === 'CHF 12.34'`
    - `formatEuropeEps(12.3, 'GBp') === '12.3p'`
    - `formatEuropeEps(-0.5, 'EUR') === '−€0.50'`
    - `formatEuropeMoney(48_040_000_000, 'GBP') === '£48.04B'`
  - `EuropeStockList.test.tsx`:
    - `'Tradegate price labelled Real-time · Tradegate · EUR; Yahoo price labelled Delayed ~15 min'` (Review Focus 5)
    - `'GBp EPS vs GBP estimate shows both, no colour, not-compared note'` (Review Focus 2)
    - `'unconfirmed period shows Period not stated'` (Review Focus 1)
    - `'PR Newswire results out shows source, local time and title link'`
    - `'UNKNOWN timing tooltip text'`
    - `'EU exchange filter narrows rows and survives a localStorage throw'`
    - `'expanded key is EU:<symbol>'`
  - `MarketBar.test.tsx`: `'UK strip shows FTSE 100, FTSE 250, FTSE AIM All-Share; EU strip shows 8 indices, delayed'`
  - `StatusPage.test.tsx`: `'UK and Europe coverage tables'`
  - `AdminPage.test.tsx`: `'Europe panel: Tradegate paused until, OpenFIGI not configured, readers off'`
  - `useLiveResults.test.tsx`: `'uk-prices and eu-results reach their groups'`
- [ ] **Step 2: Run** them in `web/`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test` and `npx tsc --noEmit` in `web/`. Expected: PASS; `git diff --stat web/test/HkStockList.test.tsx web/test/JpStockList.test.tsx` is empty.
- [ ] **Step 5: Commit** `feat(web): UK and Europe markets, list with venue-labelled prices and exchange filter, strips, status and admin`.

### Task 21: Live spot-check and full verification  [Group F]

**Depends on:** all tasks.

**Files:**
- Create: `server/src/cli/europeSpotCheck.ts`
- Modify: `server/package.json` (`"europe-spot-check": "tsx src/cli/europeSpotCheck.ts"`)

**Interfaces:**
- `europeSpotCheck.ts --market uk|eu --db <copy.db> [--symbols …] [--universe-limit N]`
  - It requires `--db` and refuses `config.dbPath`.
  - It runs `warmUpEurope` once against the copy with a real context: one Yahoo client on `yahooLimiter`, a 120 ms SEC client, Cboe at 2,500 ms with the cache, `TradegatePoller.tick()` once for the listed symbols, and OpenFIGI keyless unless the key is set.
  - `--universe-limit` caps the OpenFIGI/Yahoo-search mapping to N new ISINs so a spot run stays short. The full mapping happens in production.
  - No watchers, no Kite.
  - Per symbol it prints:
    - level, exchange, period label or "not stated", report date and status, timing and source
    - released source and time
    - estimates with currencies, actuals with source/span/currencies
    - cap and its currency
    - expected move, previous move
    - Tradegate vs Yahoo price and venue
    - the latest SEC 6-K URL
  - It also prints the Tradegate state and whether the OpenFIGI key is configured (never the value).

- [ ] **Step 1: Copy the live database** to the scratchpad (`copy C:\Users\ST269\Desktop\earnings_app\data\earnings.db <scratchpad>\europe-check.db`) without opening the original. The production server keeps running untouched.
- [ ] **Step 2: Run** `npm run europe-spot-check -w server -- --market uk --db <copy> --symbols AZN.L,HSBA.L,SHEL.L,VOD.L,BT-A.L,TSCO.L,<2 AIM names> --universe-limit 300`, and the EU equivalent with `ASML.AS,SAP.DE,NOVO-B.CO,TTE.PA,SAN.MC,NESN.SW,VOLV-B.ST,ENI.MI,<2 small caps>`. Both need `SEC_USER_AGENT` from the live `.env`.
- [ ] **Step 3: Compare by hand** against EDGAR (full level), Yahoo quote pages, the Cboe delayed-quotes page, the Tradegate page for the ISIN, and the ESEF report xHTML.
  - **Never** open a banned site (Global Constraints).
  - Record each field as match / blank / wrong in the commit body.
  - Any **wrong** value is a bug: fix it test-first in the owning task's module. A blank is acceptable only where the spec or a Ruling says blank.
- [ ] **Step 4: Run the full verification.**
  - In `server/`: `npm test` and `npx tsc --noEmit`.
  - In `web/`: `npm test` and `npx tsc --noEmit`.
  - `npm run coverage-check -w server -- --db <copy>`: UK and EU rows print.
  - The four reader-corpus snapshot commands from Task 7 Step 1, `fc` against the saved files: identical.
  - `npm run reader-corpus -w server -- --uk`, `--uk-heldout`, `--eu`, `--eu-heldout`: each prints its gate verdict, consistent with `config.fastFields`.
  - `git diff main --stat -- server/test/hk server/test/jp web/test/HkStockList.test.tsx web/test/JpStockList.test.tsx`: empty.

  Expected: all tests pass (1,128+ server, 162+ web), no type errors.
- [ ] **Step 5: Commit** `chore(europe): live spot-check script and results`. The body has the spot-check table, the Tradegate state, the gate scores and the open user rulings (dropped full-level names, unconfirmed holiday lists).
