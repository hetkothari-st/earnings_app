# Japan Earnings Calendar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fourth market, Japan, behind the US / India / Hong Kong / Japan switch. It covers every TSE-listed company from the EDINET code list (about 3,800). **Full level**: 8 SEC 6-K filers with Cboe ADR chains get SEC results and an ADR expected move. **Basic level**: everyone else gets Yahoo dates, estimates, prices and actuals, plus exact half-year and annual figures from EDINET XBRL.

**Architecture:**
- All Japan code lives in `server/src/jp/`, mirroring `server/src/hk/`: `universe.ts`, `domain/`, `sources/`, `db/` (`jp_*` tables, ids from `3_000_000_001`), `jobs/`, `live/`, `api/` (`/api/jp/*`).
- HK pieces that only differ by market become shared modules parameterised by market. HK keeps its exported names as thin wrappers, so HK behaviour and every HK test stay unchanged:
  - exchange calendar
  - ADR session mapping
  - 6-K classifier and date-notice parser
  - 6-K feed watcher and per-CIK sweep
  - Yahoo summary parser
  - ADR expected-move jobs
  - delayed-prices poller
  - web list parts
- New free sources:
  - EDINET API v2 (FSA, PDL1.0), with a key from env.
  - The Yahoo bulk earnings calendar (the visualization endpoint) and batch quotes. All Japan Yahoo traffic goes through one client: one session, ≤ 1 request/s.

**Tech Stack:** Node 24, TypeScript (NodeNext, strict), Fastify 5, node:sqlite, zod 4, luxon, node-cron, Vitest. React 19 + Vite + Testing Library. No new dependencies. Zip reading uses `node:zlib`. Shift_JIS decoding uses `TextDecoder('shift_jis')`.

**Spec:** `docs/superpowers/specs/2026-10-27-japan-earnings-design.md` (binding). It builds on the Hong Kong spec and on the HK code as built. Anything the Japan spec does not state behaves as the Hong Kong tab.

## Global Constraints

- **Free sources only.** App and script code may fetch only these hosts:
  - SEC: `www.sec.gov`, `data.sec.gov`
  - Cboe: `cdn.cboe.com`. It now answers `307` to `cdn-api.cboe.com`; `makeHttp` follows the redirect.
  - Yahoo: `fc.yahoo.com`, `query1.finance.yahoo.com`, `query2.finance.yahoo.com`
  - EDINET: `api.edinet-fsa.go.jp` (API v2), `disclosure2dl.edinet-fsa.go.jp` (code-list download only)
- **Never fetch, not even by hand or in scripts:**
  - any `jpx.co.jp` host (TDnet, JPX files and pages)
  - `release.tdnet.info`
  - `jpx-jquants.com` / `api.jquants.com`
  - `webapi.yanoshin.jp`
  - any other Japanese data aggregator
- **Read by hand only, never fetched by app code:**
  - the Cabinet Office holiday page `https://www8.cao.go.jp/chosei/shukujitsu/gaiyou.html`
  - the EDINET viewer `https://disclosure2.edinet-fsa.go.jp/` (for hand-downloading fixture documents)
  - FSA taxonomy pages on `www.fsa.go.jp`
- **Uncertain means blank.** Never overwrite a stored value with a blank.
- **Actual precedence:** SEC > EDINET > Yahoo, per field. A lower source never replaces a higher one; a higher one replaces a lower one; the same source never replaces itself (the first wins).
- **SEC:**
  - User-Agent only from env `SEC_USER_AGENT`.
  - Every app SEC request goes through the one shared client `sources.secHttp` (`minIntervalMs: 120`).
  - Scripts use their own 120 ms client and never run at the same time as each other.
  - Without `SEC_USER_AGENT`, full-level SEC features are off and everything else works.
- **EDINET:**
  - The key comes only from env `EDINET_API_KEY` (`config.edinetApiKey`).
  - The key is **never** logged, stored or put into an error message, source-error row, API response or commit. Any text holding a request URL has the key replaced by `***`.
  - Without the key, EDINET is off and everything else works.
  - Credit line wherever EDINET figures show: `Source: EDINET (Financial Services Agency), edited` (PDL1.0).
- **Yahoo (Japan):**
  - Every Japan Yahoo request goes through the single `YahooClient` built in `index.ts` (Task 5): one session/crumb, ≤ 1 request/s overall for summary, calendar, quotes, charts and prices together.
  - HK, US and India Yahoo clients are unchanged.
- **No Zerodha/Kite logins.** Do not run any Kite login, do not set `KITE_AUTO_LOGIN`, and do not call `/api/admin/kite/*`.
- **Do not restart the running production server.** Do not run `npm start` / `npm run dev`, and never open `data/earnings.db`. Live checks run as CLI scripts against a **copy** (`--db <copy>`, which refuses `config.dbPath`).
- **Times:**
  - Japan: `Asia/Tokyo` (JST, no DST). TSE session 09:00–11:30 and 12:30–15:30 JST.
  - Timing: `BMO` < 09:00, `DMH` 09:00–15:30 inclusive (lunch counts as during), `AMC` > 15:30.
  - US option logic: ET, via `server/src/domain/marketCalendar.ts`.
- **Money:**
  - Japan figures are stored with the currency the source states (`JPY` expected) and never converted.
  - Prices and market cap: ¥.
  - Display prefix `JPY` → `¥`. No prefix when the currency is unknown.
- **Beat/miss colour** needs all four of: the same currency, per-share basis, the same period end, and **the same span**. A quarter estimate against a quarter actual, or a year estimate against a 12-month actual. A YTD actual against a quarter estimate gets no colour. There is never EPS colour when the EPS actual is from SEC.
- **Reader gate:** reading values out of 6-Ks stays off (`config.fastFields.jpEps` / `jpRevenue` default `false`) until the `'jp'` profile reads ≥ 20 hand-checked releases all exact with 0 wrong, **and** the held-out set is all exact with 0 wrong. The "Results out" flip ships regardless.
- **HK, US and India behaviour unchanged:**
  - The existing 805 server and 139 web tests stay green.
  - Every existing HK test file stays untouched.
  - `npm run reader-corpus -w server` and `npm run reader-corpus -w server -- --hk` print byte-identical output before and after Task 3.
- **Style:** dark theme, Archivo, dots not stripes, no all-caps labels.
- **TDD:** red → green. Before every commit run all four:
  - `npm test` in `server/`
  - `npm test` in `web/`
  - `npx tsc --noEmit` in `server/`
  - `npx tsc --noEmit` in `web/`
- **Commit messages** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Imports:** server imports use `.js` extensions. The web app imports server types type-only from `../../server/src/...`.

## Review Focus

1. **The EDINET key leaking through an error.** A 401/404/500 from EDINET, or a network error, must surface as a message with `Subscription-Key=***`, both in `recordSourceError` and in console output. Pinned in Task 4 and Task 11.
2. **A 2Q release with no standalone-quarter column** (MUFG-style summary reports; most 半期報告書):
   - The six-month figure is stored as span `ytd`, `ytdMonths: 6`, and shows "YTD (6 months)".
   - It gets no colour against a quarter estimate and is never turned into a quarter by subtraction.
   - A later Yahoo quarterly value never replaces it.

   Pinned in Tasks 3, 8 and 11.
3. **Banks and brokers:**
   - 経常収益 / "Ordinary income" (MUFG, SMFG, Mizuho; XBRL `OrdinaryIncome…`) is never read as revenue: revenue stays blank.
   - A line labelled "Net revenue" (Nomura) is read.
   - EPS is still read.

   Pinned in Tasks 3 and 4.
4. **Alphanumeric securities codes and names without a `.T` quote:**
   - EDINET `285A0` becomes code `285A` and Yahoo `285A.T`.
   - A code whose fifth character is not `0` is dropped.
   - A company Yahoo has no quote for stays in the universe with blank price and cap, and never breaks a batch.

   Pinned in Tasks 5 and 6.
5. **Bulk calendar rows that are stale, duplicated or ambiguous:**
   - A past date never creates a row.
   - Two different dates for one company that map to the same fiscal period are both ignored.
   - A Yahoo date never moves a confirmed date.
   - A sweep that fails on page 7 of 40 keeps pages 1–6 and deletes nothing.

   Pinned in Tasks 5 and 10.

---

## Parallel execution map

| Group | Tasks | Starts when | Notes |
|---|---|---|---|
| A | 1, 2, 3, 4, 5, 6, 7 | now | Disjoint files. Only Task 6 edits `server/package.json`. |
| B | 8 | all of A merged | Defines every `jp_*` repo function and `JpJobContext`, so C tasks never edit the repo. |
| C | 9, 10, 11, 12 | 8 merged (12 also needs 2 and 3, which are already in A) | Disjoint files. Only Task 12 edits `config.ts` and `package.json`. |
| D | 13, 14 | all of C merged | 13 = server live + wiring (only task to edit `server/src/index.ts`); 14 = web only. |
| E | 15 | all merged | Live spot-check against a DB copy. |

Dependencies per task are repeated in each task's **Depends on** line.

## Rulings (where the spec is silent or ambiguous)

1. **Ids:** Japan report ids start at `3_000_000_001`.
2. **Codes:**
   - The universe code is the EDINET `証券コード` without its trailing `0`, matching `^[0-9][0-9A-Z]{3}$` (`72030` → `7203`, `285A0` → `285A`).
   - A 5-character code not ending in `0` is skipped.
   - The Yahoo symbol is `${code}.T`.
3. **Universe:**
   - Rows with `上場区分 === '上場'` and a non-empty `証券コード`.
   - Name: `提出者名（英字）` when non-empty, else `提出者名`.
   - `fyEndMonth` from `決算日` (`"3月31日"` → 3). Unparseable gives null: the stock is kept, but no calendar row is created for it (no period can be named).
   - Japanese industry: `提出者業種`, stored as `industryJa` and shown as is.
   - The 8 full-level entries are hand-kept in `JP_FULL` and override level/ADR/CIK. A full-level code missing from the code list is still kept (and logged).
4. **Periods:**
   - Quarter ends are `fyEndMonth`, +3, +6 and +9 months (month ends).
   - The report's period is the latest quarter end strictly before the report date.
   - `fiscalQuarter` runs 1–4 from the fiscal-year start.
   - The fiscal year is named by the calendar year it ends in.
   - Labels: `"1Q FY27"`, `"2Q FY27"`, `"3Q FY27"`; the 4th quarter is the full-year release, labelled `"FY27"`. Example: Toyota, quarter ending 2026-09-30 → `"2Q FY27"`.
5. **Spans:**
   - Every actual carries `span: 'quarter' | 'ytd'` and `ytdMonths: 6 | 9 | 12 | null` (null for quarter).
   - Q1 values are span `quarter`.
   - EDINET 半期報告書 is `ytd` 6; 有価証券報告書 is `ytd` 12.
   - Yahoo actuals are `quarter`.
   - Estimates carry `estimateSpan: 'quarter' | 'year'`. A FY (4th-quarter) row prefers the Yahoo year item (`0y` / `+1y` whose end date equals the period end), else the quarter item. Q1–Q3 rows take quarter items only.
   - Colour only for quarter↔quarter or (`ytd` 12)↔year (Global Constraints).
6. **EPS:**
   - The EPS actual is **basic** EPS per share in yen: the Japanese headline figure, and what the Yahoo JP consensus tracks.
   - Diluted EPS is stored alongside (`epsDiluted`) and shown in details, never coloured.
   - EPS and diluted EPS share one source/span. Revenue has its own source/span.
7. **Timing:**
   - SEC acceptance never proves timing for Japan, because EDGAR opens 19:00/20:00 JST, after the Tokyo close. `jpTimingFromAcceptance` does not exist; the watcher passes `null`.
   - Timing comes from a 6-K date notice when stated, else from Yahoo `TAS` (time as supplied) calendar rows, else `UNKNOWN`.
   - Date-notice phrases follow HK Ruling 4:
     - "before the U.S. market opens on D" ⇒ JST date D, `AMC`.
     - "after the U.S. market closes on D" ⇒ D+1, `BMO`.
     - Explicit Tokyo/Japan clock time ⇒ by the JST thresholds.
     - "after the close of the Tokyo Stock Exchange" ⇒ `AMC`.
     - "before the opening of trading on the Tokyo Stock Exchange" ⇒ `BMO`.
8. **Full-level date** (HK Ruling 5):
   - The ADR's US `reports` row maps to a JST date: US `AMC` → the next day; otherwise the same day.
   - Used when Yahoo's `.T` date agrees or Yahoo has none. When they disagree, nothing is written.
   - Status is `estimated` until a 6-K date notice makes it `confirmed`.
9. **First US session after a Tokyo release, and final expected move:** exactly HK Ruling 6, with the JST date in place of the HK date. All Tokyo releases (≤ 24:00 JST) precede the same-date 09:30 ET open.
10. **Yahoo tiers (≤ 1 req/s overall):**
    - Bulk calendar sweep `[today, today+120]`: every 2 h.
    - Bulk past-dates sweep `[today−400, today−1]`: weekly, and at warm-up when `jp_past_dates` is empty.
    - Batch quotes, 50 symbols per request: weekly for every active code (cap and name), and for prices.
    - `quoteSummary`, per symbol:
      - Tier A (visible ∪ watched): max age 25 min.
      - Tier B (report date in `[today−3, today+14]`): max age 12 h.
      - At most 900 summary requests per run, nearest report date first.
    - Daily closes for previous moves: only rows in `[today−1, today+14]` ∪ tier A, at most 800 per nightly run.
11. **Bulk calendar dates:**
    - A `TAS` row: JST date and JST timing.
    - Any other type: the UTC calendar date of `startdatetime` and `UNKNOWN`. Task 5 confirms this on the saved fixture and pins it.
    - Rows for one symbol whose dates map to the same fiscal period but differ are ambiguous and ignored.
    - Dates before today are ignored.
12. **Yahoo actuals (basic level):**
    - The results job runs its own bulk sweep over `[today−20, today]`. A summary is fetched only for rows in that window that lack the field and whose symbol shows a non-null `epsactual` in that sweep. This is the "results out" signal; it only picks which summaries to fetch.
    - EPS from `earningsHistory` in the period-end month (with currency).
    - Revenue from `financialsChart.quarterly`, only with the label rule Task 5 pins on real fixtures. Otherwise revenue stays blank.
    - Span `quarter`, source `yahoo`.
13. **EDINET:**
    - Only `docTypeCode` `'120'` (有価証券報告書) and `'160'` (半期報告書), with `ordinanceCode === '010'`, `withdrawalStatus === '0'`, `xbrlFlag === '1'`, and a `secCode` in the active universe. Amendments (`130`, `170`) and older quarterly reports (`140`) are ignored.
    - A document updates only the row whose `periodEnd` equals the document's `periodEnd`. It never creates rows and never sets `releasedAt`.
    - Each `docID` is handled once (`jp_edinet_seen`).
    - Polling:
      - Today's list every 30 min 09:00–19:59 JST on weekdays.
      - The last 7 days nightly.
      - The last 7 days at warm-up.
14. **XBRL facts:**
    - Facts are chosen by **context period**, not by context id. Take the duration context starting on `jpdei_cor:CurrentFiscalYearStartDateDEI` and ending on the document's `periodEnd`, with no dimension members. Use the `NonConsolidatedMember` variant only when `jpdei_cor:WhetherConsolidatedFinancialStatementsArePreparedDEI` is `false`.
    - Units must be `JPY` (amounts) and `JPYPerShares` (EPS); anything else gives blank.
    - Every element that is present for one field must agree; otherwise that field is blank.
    - `ytdMonths` must be 6 for `160` and 12 for `120`; otherwise everything is blank.
15. **6-K handling (Japan):** the same as `handleHkFiling` (period-end match, ±3-day move, a confirmed date only moves earlier, the `filedOn` rule, earliest filing wins), with three differences:
    - Timing from acceptance is always `null`.
    - Actuals come from `readJpRelease` behind `jpEps` / `jpRevenue`.
    - With no row, one is created only when the release's period is the stock's latest period at the JST acceptance date.
16. **Shared 6-K feed:** one `SixKWatch` serves HK and Japan with one feed request per tick. It ticks every 2 s when either market has a full-level report due (local today−1..+3, unreleased), else every 30 s. Only HK has 8-K filers.
17. **Prices:**
    - Japan uses the shared `DelayedPrices` poller with batch quotes (50 per request) for visible ∪ watched ∪ reporting today/tomorrow (JST).
    - Every 60 s during 08:45–15:45 JST on TSE trading days, otherwise every 15 min.
    - Unpriced codes are fetched at the next 15 s tick (HK lesson).
    - Labelled "Delayed ~20 min".
    - Market cap is the stored Yahoo cap with its as-of date.
18. **Strip:** `Nikkei 225` (`^N225`) and `TOPIX (ETF 1306)` (`1306.T`). The second name says it is the ETF.
19. **Not modelled:** TSE half-days, system outages. For dates ≥ `2028-01-01`, the holiday list counts weekends and the year-end closure only, plus a `jp-holidays` status warning.
20. **Coverage minimums (status page):**
    - `epsEstimate` 30, within 14 days
    - `marketCap` 90
    - `previousMove` 30, within a week
    - `expectedMove` 60, within a week, full level only

## Source facts (verify live in the task that needs them; save real samples as fixtures, never invent them)

- **EDINET code list** (checked 2026-10-27, no key needed):
  - URL: `https://disclosure2dl.edinet-fsa.go.jp/searchdocument/codelist/Edinetcode.zip` → `EdinetcodeDlInfo.csv`, Shift_JIS.
  - Line 1 is metadata (`ダウンロード実行日,2026年10月27日現在,件数,11433件`).
  - Line 2 is the header: `ＥＤＩＮＥＴコード,提出者種別,上場区分,連結の有無,資本金,決算日,提出者名,提出者名（英字）,提出者名（ヨミ）,所在地,提出者業種,証券コード,提出者法人番号`.
  - Fields are quoted. There are 3,810 rows with `上場` and a securities code.
  - Sample row: `"E02144","内国法人・組合","上場","有","635401","3月31日","トヨタ自動車株式会社","TOYOTA MOTOR CORPORATION",…,"72030",…`.
- **EDINET API v2** (key required; without one the API answers `{"StatusCode": 401,"message": "Access denied due to invalid subscription key…"}`):
  - Document list: `https://api.edinet-fsa.go.jp/api/v2/documents.json?date=YYYY-MM-DD&type=2&Subscription-Key=KEY`
    - `metadata.status` is `"200"` on success.
    - `results[]` has `docID, edinetCode, secCode, filerName, docTypeCode, ordinanceCode, formCode, periodStart, periodEnd, submitDateTime ("YYYY-MM-DD hh:mm" JST), withdrawalStatus, xbrlFlag, docDescription, parentDocID`.
  - Document: `https://api.edinet-fsa.go.jp/api/v2/documents/{docID}?type=1&Subscription-Key=KEY` → ZIP. The main instance is `XBRL/PublicDoc/*.xbrl`; audit files are under `XBRL/AuditDoc/` and are ignored.
  - Verify both endpoints, the field names and the error shape with the real key in Task 4 (or Task 15 when no key is available earlier).
- **XBRL element starting list.** Confirm every name against real instances and the EDINET taxonomy element list; record the confirmed list in `edinetXbrl.ts`. Unknown names give blank.
  - DEI: `jpdei_cor:AccountingStandardsDEI` (`Japan GAAP` / `IFRS` / `US GAAP`), `CurrentFiscalYearStartDateDEI`, `CurrentPeriodEndDateDEI`, `TypeOfCurrentPeriodDEI`, `SecurityCodeDEI`, `WhetherConsolidatedFinancialStatementsArePreparedDEI`.
  - Revenue:
    - J-GAAP: `jpcrp_cor:NetSalesSummaryOfBusinessResults`, `jpcrp_cor:OperatingRevenue1SummaryOfBusinessResults`, `jpcrp_cor:OperatingRevenue2SummaryOfBusinessResults`, `jppfs_cor:NetSales`, `jppfs_cor:OperatingRevenue1`.
    - IFRS: `jpcrp_cor:RevenueIFRSSummaryOfBusinessResults`, `jpigp_cor:RevenueIFRS`, `jpigp_cor:NetSalesIFRS`, `ifrs-full:Revenue`.
    - US GAAP: `jpcrp_cor:RevenuesUSGAAPSummaryOfBusinessResults`.
    - **Never revenue:** `jpcrp_cor:OrdinaryIncomeSummaryOfBusinessResults` / `jppfs_cor:OrdinaryIncome` (経常収益, banks and insurers), and any `OrdinaryIncomeLoss…` / `OperatingIncome…` / `GrossProfit…`.
  - EPS, basic / diluted:
    - J-GAAP: `jpcrp_cor:BasicEarningsLossPerShareSummaryOfBusinessResults` / `jpcrp_cor:DilutedEarningsPerShareSummaryOfBusinessResults`, `jppfs_cor:BasicEarningsLossPerShare` / `jppfs_cor:DilutedEarningsPerShare`.
    - IFRS: `jpcrp_cor:BasicEarningsLossPerShareIFRSSummaryOfBusinessResults` / `…DilutedEarningsLossPerShareIFRSSummaryOfBusinessResults`, `jpigp_cor:BasicEarningsLossPerShareIFRS` / `jpigp_cor:DilutedEarningsLossPerShareIFRS`.
    - US GAAP: `jpcrp_cor:BasicEarningsLossPerShareUSGAAPSummaryOfBusinessResults` / `…DilutedEarningsLossPerShareUSGAAPSummaryOfBusinessResults`.
- **Yahoo:**
  - Visualization (already used for past dates): `POST https://query1.finance.yahoo.com/v1/finance/visualization?crumb=…`, body `{ size: 100, offset, sortField: 'startdatetime', sortType: 'ASC', entityIdType: 'earnings', includeFields: ['ticker','companyshortname','startdatetime','startdatetimetype','epsestimate','epsactual'], query: { operator: 'and', operands: [ { operator: 'gte', operands: ['startdatetime', FROM] }, { operator: 'lt', operands: ['startdatetime', TO_PLUS_1] }, { operator: 'eq', operands: ['region', 'jp'] } ] } }`.
    - Verify the `region` operand live. If Yahoo rejects it, use `{ operator: 'or', operands: [eq ticker …] }` batches of 100 `.T` tickers and record that in `yahooJp.ts`.
    - Read `total` from `finance.result[0].total`, if present, for paging.
  - Batch quote: `https://query1.finance.yahoo.com/v7/finance/quote?symbols=A.T,B.T,…&crumb=…` (≤ 50 symbols) → `quoteResponse.result[]` with `symbol, currency, regularMarketPrice, regularMarketPreviousClose, regularMarketTime, marketCap, longName, shortName`.
    - Verify live. If refused even with a crumb, prices fall back to per-symbol `fetchStockQuote`, caps to tier-A/B summaries, and the fallback is recorded in `yahooJp.ts`.
  - Indices: `^N225`, `1306.T` (verify `currency === 'JPY'`). Alphanumeric code check: save `285A.T` or any current alphanumeric listing.
- **SEC / Cboe, full level** (verify every value with `npm run verify-jp-universe`; the CIKs below are starting points, not facts):

  | ADR | Code | Company | ADR ratio (spec) | CIK (to verify) |
  |---|---|---|---|---|
  | TM | 7203 | Toyota | 10 | 1094517 |
  | SONY | 6758 | Sony | 1 | 313838 |
  | MUFG | 8306 | MUFG | 1 | 67088 |
  | SMFG | 8316 | SMFG | **verify** | 1022837 |
  | MFG | 8411 | Mizuho | 0.2 | 1335730 |
  | HMC | 7267 | Honda | 3 | 715153 |
  | NMR | 8604 | Nomura | 1 | 1163653 |
  | TAK | 4502 | Takeda | 0.5 | 1395064 |

  - ORIX (IX) is basic: it has no Cboe chain.
  - The ratio is **Tokyo shares per ADS** and can be fractional. The 20-F wording includes "one-fifth of one share" and "one-half of one share".
  - Cboe chain URL `https://cdn.cboe.com/api/global/delayed_quotes/options/<ADR>.json` answers `307 → cdn-api.cboe.com` (checked 2026-10-27).
- **Japanese market closures**, typed by hand. Re-check against the Cabinet Office page before committing Task 1; if a date differs, use the Cabinet Office date and fix the test.
  - **2026 holidays:** 01-01, 01-12, 02-11, 02-23, 03-20, 04-29, 05-04, 05-05, 05-06, 07-20, 08-11, 09-21, 09-22, 09-23, 10-12, 11-03, 11-23 (05-03 falls on a Sunday).
  - **2027 holidays:** 01-01, 01-11, 02-11, 02-23, 03-22 (substitute for Sunday 03-21), 04-29, 05-03, 05-04, 05-05, 07-19, 08-11, 09-20, 09-23, 10-11, 11-03, 11-23.
  - **TSE year-end closure** every year: 12-31, 01-01, 01-02, 01-03. This is a rule, not a list.

## File map

**Server, create:**
- Shared modules:
  - `src/domain/exchangeCalendar.ts`, `src/domain/adrSessions.ts`
  - `src/sources/sixKClassify.ts`, `src/sources/sixKWatch.ts`, `src/sources/sixKSweep.ts`
  - `src/sources/yahooClient.ts`, `src/sources/yahooForeignSummary.ts`, `src/sources/zip.ts`
  - `src/db/adrRows.ts`, `src/jobs/adrMoves.ts`, `src/live/delayedPrices.ts`
- `src/jp/universe.ts`
- `src/jp/domain/jpCalendar.ts`, `src/jp/domain/period.ts`
- `src/jp/sources/edinet.ts`, `src/jp/sources/edinetXbrl.ts`, `src/jp/sources/yahooJp.ts`, `src/jp/sources/releaseJp.ts`
- `src/jp/db/schema.ts`, `src/jp/db/jpRepo.ts`
- `src/jp/api/types.ts`, `src/jp/api/dto.ts`, `src/jp/api/routes.ts`
- `src/jp/jobs/context.ts`, `stocks.ts`, `pastDates.ts`, `calendar.ts`, `estimates.ts`, `results.ts`, `edinetResults.ts`, `prevMoves.ts`, `moves.ts`, `secSweep.ts`, `scheduler.ts`
- `src/jp/live/jpSixK.ts`, `src/jp/live/jpPrices.ts`
- `src/cli/verifyJpUniverse.ts`, `src/cli/collectJpCorpus.ts`, `src/cli/jpSpotCheck.ts`

**Server, modify (generalised, HK names kept as wrappers):**
- `src/hk/domain/hkCalendar.ts`, `src/hk/domain/hkMoves.ts`
- `src/hk/sources/sixK.ts`, `src/hk/live/hkSecWatch.ts`, `src/hk/jobs/secSweep.ts`
- `src/hk/sources/yahooHk.ts`, `src/hk/jobs/moves.ts`, `src/hk/live/hkPrices.ts`
- `src/hk/db/hkRepo.ts` (re-export `usAdrRows`)
- `src/sources/releaseReader.ts`

**Server, modify (market plumbing):**
- `src/config.ts`, `src/db/repo.ts`
- `src/india/api/types.ts`, `src/india/db/inRepo.ts`, `src/india/api/routes.ts`
- `src/watchlist/{store,routes,search}.ts`, `src/notes/{store,routes}.ts`
- `src/jobs/coverage.ts`, `src/cli/coverageCheck.ts`, `src/cli/readerCorpus.ts`
- `src/api/{types,server}.ts`, `src/index.ts`, `package.json`

**Web, create:** `src/components/foreignParts.tsx`, `src/components/JpStockList.tsx`

**Web, modify:**
- `src/components/HkStockList.tsx`, `listParts.tsx`, `MarketBar.tsx`, `Calendar.tsx`, `Header.tsx`, `WatchlistView.tsx`, `StatusPage.tsx`, `AdminPage.tsx`
- `src/lib/{market,format,liveCap}.ts`
- `src/hooks/{useMarket,useLiveResults,useVisibleSymbols}.ts`
- `src/api.ts`, `src/adminApi.ts`, `src/styles.css`

**Fixtures:** `server/test/fixtures/jp/`. Yahoo and Cboe samples (Task 5); 6-K exhibits (Task 2); EDINET (Task 4); code-list sample (Task 6); release corpus (Task 12).

---

### Task 1: Japan domain on a shared exchange calendar and ADR-session module  [Group A]

**Depends on:** nothing.

**Files:**
- Create: `server/src/domain/exchangeCalendar.ts`, `server/src/domain/adrSessions.ts`, `server/src/jp/domain/jpCalendar.ts`, `server/src/jp/domain/period.ts`
- Modify:
  - `server/src/hk/domain/hkCalendar.ts`: the functions delegate to `makeExchangeCalendar` (same exports, same results).
  - `server/src/hk/domain/hkMoves.ts`: the functions delegate to `adrSessions.ts`.
- Test: `server/test/domain/exchangeCalendar.test.ts`, `server/test/jp/jpCalendar.test.ts`, `server/test/jp/period.test.ts`, `server/test/jp/adrSessions.test.ts`. All of `server/test/hk/*` stays untouched and green.

**Interfaces:**
- Produces from `exchangeCalendar.ts`:
  - `type LocalTiming = 'BMO' | 'DMH' | 'AMC' | 'UNKNOWN'`
  - `interface ExchangeCalendar { zone: string; today(): string; addDays(d: string, n: number): string; isTradingDay(d: string): boolean; prevTradingDay(d: string): string; tradingDayOnOrAfter(d: string): string; timingFromClock(hhmm: string | null | undefined): LocalTiming; holidaysUnknown(d: string): boolean }`
  - `makeExchangeCalendar(o: { zone: string; holidays: Record<number, ReadonlySet<string>>; closed?: (d: string) => boolean; openMin: number; closeMin: number; unknownFrom: string }): ExchangeCalendar`
    - BMO is `< openMin`; DMH is `openMin..closeMin` inclusive; AMC is `> closeMin`.
- Produces from `adrSessions.ts`:
  - `firstUsSessionAfterRelease(reportDate: string, timing: LocalTiming, releasedAt: string | null): string`
  - `lastUsCloseBefore(reportDate: string): string`
  - `reactionWindow(cal: ExchangeCalendar, reportDate: string, timing: Exclude<LocalTiming, 'UNKNOWN'>): { before: string; after: string }`
  - `localDateFromUs(cal: ExchangeCalendar, usDate: string, usTiming: LocalTiming): string`
  - These are moved verbatim from `hkMoves.ts`; HK exports become one-line wrappers.
- Produces from `jpCalendar.ts`:
  - `JST = 'Asia/Tokyo'`, `type JpTiming = LocalTiming`
  - `JP_HOLIDAYS` (Source facts), `JP_CAL: ExchangeCalendar`. `closed` is the 12-31..01-03 rule; `openMin` 540 and `closeMin` 930; `unknownFrom: '2028-01-01'`.
  - `todayJST()`, `addDaysJST()`, `isJpTradingDay()`, `prevJpTradingDay()`, `jpTradingDayOnOrAfter()`, `jpTimingFromJst()`, `holidaysUnknownJp()`
  - `jpReactionWindow(reportDate, timing)`, `jpDateFromUs(usDate, usTiming)`
- Produces from `period.ts`:
  - `interface JpPeriod { periodEnd: string; fiscalQuarter: 1 | 2 | 3 | 4; fyEnd: string }`
  - `jpPeriodFor(reportDate: string, fyEndMonth: number): JpPeriod` (Ruling 4)
  - `jpPeriodLabel(p: JpPeriod): string`
  - `ytdMonthsOf(q: 1 | 2 | 3 | 4): 3 | 6 | 9 | 12`

- [ ] **Step 1: Write failing tests.**
  - `jpCalendar.test.ts`:
    - `'holidays, substitute days and the year-end closure are closed'`: `isJpTradingDay` is `false` for `'2026-09-22'`, `'2026-11-23'`, `'2026-12-31'`, `'2027-01-01'`, `'2027-03-22'` and `'2026-10-24'`, and `true` for `'2026-11-24'` and `'2027-01-04'`.
    - `'year-end closure applies in unlisted years'`: `isJpTradingDay('2028-01-03') === false`; `holidaysUnknownJp('2028-01-03') === true`.
    - `'previous trading day skips the year end'`: `prevJpTradingDay('2027-01-04') === '2026-12-30'`.
    - `'timing: lunch counts as during'`: `'08:59'` → `BMO`; `'09:00'` → `DMH`; `'11:45'` → `DMH`; `'15:30'` → `DMH`; `'15:31'` → `AMC`; `null` → `UNKNOWN`.
    - `'US date to JST date'`: `jpDateFromUs('2026-11-04','AMC') === '2026-11-05'`; `jpDateFromUs('2026-11-05','BMO') === '2026-11-05'`.
    - `'reaction window across the year end'`: `jpReactionWindow('2026-12-30','AMC')` → `{ before: '2026-12-30', after: '2027-01-04' }`.
  - `period.test.ts`, `'period, quarter and label'`:
    - `('2026-11-05', 3)` → `2026-09-30`, Q2, fyEnd `2027-03-31`, `'2Q FY27'`
    - `('2026-05-08', 3)` → `2026-03-31`, Q4, `'FY26'`
    - `('2027-02-12', 12)` → `2026-12-31`, Q4, `'FY26'`
    - `('2026-10-09', 2)` → `2026-08-31`, Q2, fyEnd `2027-02-28`, `'2Q FY27'`
    - `('2026-10-08', 8)` → `2026-08-31`, Q4, `'FY26'`
    - `ytdMonthsOf(3) === 9`
  - `adrSessions.test.ts`: the four HK `hkMoves` expectations re-asserted through `firstUsSessionAfterRelease` / `lastUsCloseBefore`, plus `firstUsSessionAfterRelease('2026-11-26','AMC',null) === '2026-11-27'` (Thanksgiving).
  - `exchangeCalendar.test.ts`, `'a calendar with a closed rule and a holiday list'`: a toy calendar.
- [ ] **Step 2: Run** `npx vitest run test/jp test/domain/exchangeCalendar.test.ts` in `server/`. Expected: FAIL (modules missing).
- [ ] **Step 3: Implement.** Check the Cabinet Office page by hand before typing the holidays. Rewrite `hkCalendar.ts` / `hkMoves.ts` as wrappers over the shared modules without changing any HK export name or signature.
- [ ] **Step 4: Run** `npx vitest run test/hk test/jp test/domain`, then the full suite and `npx tsc --noEmit`. Expected: PASS, and `git diff --stat server/test/hk` is empty.
- [ ] **Step 5: Commit** `feat(jp): JST calendar, fiscal periods; shared exchange calendar and ADR sessions`.

### Task 2: Shared 6-K classifier, watcher and sweep (profiles `'hk'` / `'jp'`)  [Group A]

**Depends on:** nothing. Needs `SEC_USER_AGENT` for the fixtures; if it is unset, stop and ask.

**Files:**
- Create:
  - `server/src/sources/sixKClassify.ts`: the body of `hk/sources/sixK.ts`, moved and parameterised.
  - `server/src/sources/sixKWatch.ts`: the body of `HkSecWatch`, made market-agnostic.
  - `server/src/sources/sixKSweep.ts`: the body of `sweepHkSec`.
- Modify:
  - `server/src/hk/sources/sixK.ts`: re-exports wrappers with profile `'hk'`.
  - `server/src/hk/live/hkSecWatch.ts`: `handleHkFiling` stays here. `HkSecWatch` becomes `class HkSecWatch extends SixKWatch` with the same constructor `(ctx, http, onReleased)` and the same `tick` / `intervalMs` / `onUsFeed` / `start` / `stop`. Also exports `hkSixKMarket(ctx, onReleased): SixKMarket`.
  - `server/src/hk/jobs/secSweep.ts`: `sweepHkSec(ctx)` calls `sweepSixK`.
- Fixtures `server/test/fixtures/jp/`. Save live from EDGAR:
  - one Toyota results 6-K index and its release document
  - one MUFG or Mizuho results 6-K release (bank)
  - one Sony or Honda results release
  - one non-results Japanese 6-K (e.g. a share buyback report)
  - a Japanese date notice, if any of the 8 filed one in the last 24 months
- Test: `server/test/sources/sixKClassify.test.ts`, `server/test/sources/sixKWatch.test.ts`. `server/test/hk/sixK.test.ts`, `hkSecWatch.test.ts` and `secSweep` tests stay untouched and green.

**Interfaces:**
- `sixKClassify.ts`:
  - `type SixKProfile = 'hk' | 'jp'`
  - `type SixKSpan = 'quarter' | 'half' | 'nine' | 'year'`. `'nine'` only for `'jp'`; the HK output never contains it.
  - `type SixKExhibit = { kind: 'results'; periodEnd: string; span: SixKSpan } | { kind: 'date-notice'; date: string; timing: LocalTiming } | { kind: 'other' }`
  - `classifySixK(html: string, opts: { filedOn?: string; profile: SixKProfile }): SixKExhibit`
  - `parseDateNoticeFor(text: string, profile: SixKProfile): { date: string; timing: LocalTiming } | null`
  - `pickReleaseDoc(docs: FilingDoc[]): string | null` (moved unchanged)
  - **Profile `'jp'` adds:**
    - Results phrases:
      - `consolidated financial results for the (three|six|nine) months ended`
      - `(first|second|third) quarter (of )?(the )?(fiscal year|FY) ?\d{2,4}`
      - `FY\s?\d{4} (first|second|third|fourth) quarter`
      - `FY\d{4} Q[1-4]`
      - `consolidated summary report`
      - `financial summary`
      - `(annual|full[- ]year) (consolidated )?financial results`
    - Period mentions: `nine months ended` → `'nine'`; Japanese month-range headers `Apr\.?\s*[-–~]\s*Sep\.?\s*2026` and `July[-–]September 2026` → that range's end month (span by range length: 3 → quarter, 6 → half, 9 → nine, 12 → year).
    - Date notices: the clock phrase `(?:Japan|Tokyo)(?: standard)? time|JST` with JST thresholds; exchange phrases with `(?:the )?Tokyo Stock Exchange|TSE`.
    - "Annual Securities Report" / "Semi-Annual Securities Report" (EDINET translations) are `other`.
  - With profile `'hk'` every regex and branch is the current HK code, byte for byte.
- `sixKWatch.ts`:
  - `interface ForeignFiling { cik: number; accession: string; indexUrl: string; acceptedAt: string; form: string }`
  - `interface SixKMarket { name: 'hk' | 'jp'; ciks(): Set<number>; eightKCiks(): Set<number>; due(): boolean; seen(accession: string): boolean; handle(f: ForeignFiling): Promise<number[]>; onChanged(ids: number[]): void }`
  - `class SixKWatch { constructor(markets: SixKMarket[], http: Http, base: { db: DatabaseSync; now(): string }); start(): void; stop(): void; intervalMs(): number; tick(): Promise<number[]>; onUsFeed(items: SecFeedItem[]): void }`
    - One feed request per tick (failover name `sec-6k-feed`).
    - Each fresh item goes to the market whose `ciks()` holds its index-URL CIK.
    - One queue across markets, with `MAX_TRIES` 10 and give-up-to-sweep as today.
    - Interval: 2 s if any `market.due()`, else 30 s.
- `sixKSweep.ts`: `sweepSixK(base: { db; now(): string }, http: Http, market: SixKMarket, since: string): Promise<number[]>`. It contains the HK sweep logic: `fetchEarningsFilings`, then `fetchAcceptance` (ET → UTC ISO), then `market.handle`.

- [ ] **Step 1: Write failing tests.**
  - `sixKClassify.test.ts`:
    - `'Toyota release is results for its quarter end'`: the exact `periodEnd` of the saved fixture.
    - `'bank summary report is results'` (MUFG/Mizuho fixture)
    - `'buyback 6-K is other'`
    - `'a period ending after filing is never this release's'` (`filedOn` one day before the fixture's period end → not results)
    - `'Tokyo clock: "at 3:00 p.m. Japan time on November 5, 2026" → 2026-11-05 DMH'`
    - `'"after the close of the Tokyo Stock Exchange on November 5, 2026" → AMC'`
    - `'"before the U.S. market opens on November 5, 2026" → 2026-11-05 AMC'`
    - `'notice date and timing come from the verb's own sentence'`: an AGM date in the next sentence is not used.
    - `'Annual Securities Report 6-K is other'`
    - `'hk profile never returns span nine'`: the HK BABA fixture is still `'quarter'`.
  - `sixKWatch.test.ts`:
    - `'one feed request serves both markets and routes by CIK'`: a stub `Http` serving `fixtures/hk/sec_getcurrent_6k.xml` and two stub markets; each `handle` receives only its own CIKs, and exactly one feed URL is requested per tick.
    - `'2 s when any market is due, else 30 s'`
    - `'a failing filing is retried and left to the sweep after 10 tries'`
- [ ] **Step 2: Run** `npx vitest run test/sources/sixKClassify.test.ts test/sources/sixKWatch.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Move the code first and run `test/hk`, which must pass untouched. Then add the `'jp'` branches, guarded by `profile === 'jp'`.
- [ ] **Step 4: Run** the full server suite and `npx tsc --noEmit`. Expected: PASS; `git diff --stat server/test/hk` is empty.
- [ ] **Step 5: Commit** `refactor(sec): shared 6-K classifier, watcher and sweep with hk/jp profiles`.

### Task 3: Release reader profile `'jp'`  [Group A]

**Depends on:** nothing.

**Files:**
- Modify: `server/src/sources/releaseReader.ts`
- Create: `server/src/jp/sources/releaseJp.ts`
- Test: `server/test/jp/releaseJp.test.ts`. `server/test/sources/releaseReader.test.ts` and `server/test/hk/releaseHk.test.ts` stay untouched.

**Interfaces:**
- Changes to `releaseReader.ts`:
  - `ReaderOptions.profile: 'us' | 'hk' | 'jp'`
  - `ReaderOptions.span` gains `'nine'`
  - `Currency` gains `'JPY'`
  - `ReaderResult` gains `epsBasic: number | null`
  - Yen detection (`¥`, `\byen\b`, `\bjpy\b`) exists **only** under `'jp'`. The `'hk'` and `'us'` currency sets are unchanged.
- **Profile `'jp'` rules:**
  1. **Currency.** JPY only. A column whose header, label or caption names US$ / U.S. dollars (a convenience translation) is skipped.
  2. **Units (allowlist, as the HK caption rule).** A caption counts only when it is wholly a unit statement or an income-statement title with a parenthesised unit statement:
     - `Millions of yen`, `(Millions of yen)`, `Yen in millions`, `(¥ in millions)`, `¥ million(s)`
     - `in millions of yen`, `Amounts in millions of yen`
     - `Billions of yen`, `Yen in billions`
     - each with an optional `, except per share amounts`

     EPS rows are in yen, `(Yen)`, `(yen)`, and are not scaled.
  3. **Column span.**
     - A **quarter** column names three months ending `periodEnd`: `Three months ended <date>`, a 3-month range header such as `Jul.-Sep. 2026` / `July–September 2026`, or a quarter header such as `2Q FY2027` / `Q2` within a block dated `periodEnd`.
     - A **YTD** column names `six` / `nine` / `twelve` months ended `periodEnd`, a 6/9/12-month range header (`Apr.-Sep. 2026`), `fiscal year ended <date>`, or `FY2027` with year-end `periodEnd`.
     - A dated column must be within 15 days of `periodEnd`.
  4. **EPS labels.**
     - Basic: `basic` under an EPS block, `net income per share`, `basic earnings per share`, `earnings per share attributable to … — basic`, `profit attributable to owners of parent per share`.
     - Diluted: `diluted`.
     - Per ADS / adjusted / forecast rows are never read.
     - A sub-row labelled only `Basic` / `Diluted` takes its parent row's label.
  5. **Revenue labels.** `(total )?(net )?(sales|revenues?)`, `sales revenues?`, `operating revenues?`, `net revenue`, `sales and financial services revenue(s)`. When both `net revenue` and `total revenue(s)` exist, `net revenue` is read.
     - **Never** read: `ordinary income`, `ordinary profit`, `operating income`, `gross profit`, `interest income`, `fees and commissions`. A bank with only those gives null.
- `releaseJp.ts`:
  - `interface JpReleaseValues { revenue: number | null; eps: number | null; epsDiluted: number | null; currency: 'JPY' | null; span: 'quarter' | 'ytd' | null; ytdMonths: 6 | 9 | 12 | null; notes: string[] }`
  - `readJpRelease(html: string, period: { periodEnd: string; fiscalQuarter: 1 | 2 | 3 | 4 }): JpReleaseValues`
  - **Algorithm** (spec: standalone quarter if present, else YTD, never subtraction):
    1. Read with `span: 'quarter'`.
    2. If revenue or basic EPS was found, the document's span is `quarter`, and fields not found stay null.
    3. Otherwise, if `fiscalQuarter > 1`, read with the YTD span (`half` / `nine` / `year` for Q2 / Q3 / Q4) and set `span: 'ytd'`, `ytdMonths` = 6 / 9 / 12.
    4. A Q1 document is quarter-only.
    5. One span per release; nothing is ever computed.

- [ ] **Step 1: Snapshot before refactoring.** Run `npm run reader-corpus -w server > %TEMP%\jp-before-us.txt` and `npm run reader-corpus -w server -- --hk > %TEMP%\jp-before-hk.txt`.
- [ ] **Step 2: Write failing tests** (`releaseJp.test.ts`, small inline tables like the HK reader tests):
  - `'quarter column preferred'`:
    - header `Three months ended September 30, 2025 | 2026 | Six months ended September 30, 2025 | 2026`
    - caption `(Millions of yen, except per share amounts)`
    - row `Sales revenues 11,444,573 | 12,377,550 | 22,868,108 | 24,560,124`
    - row `Basic 248.25 | 239.10 | 461.70 | 450.12`
    - Result: `{ revenue: 12_377_550_000_000, eps: 239.10, span: 'quarter', ytdMonths: null, currency: 'JPY' }`.
  - `'only YTD columns → ytd 6, never subtracted'` (Review Focus 2): only six-month columns → `{ span: 'ytd', ytdMonths: 6 }` with the six-month figures.
  - `'Japanese month-range headers'`: `Apr.-Sep. 2025 | Apr.-Sep. 2026` with `fiscalQuarter: 2` → ytd 6; `Jul.-Sep. 2026` → quarter.
  - `'ordinary income is never revenue'` (Review Focus 3): a bank table with `Ordinary income` and `Net income attributable to owners of the parent per share` → `{ revenue: null, eps: <value> }`.
  - `'Nomura: net revenue over total revenue'`
  - `'US$ convenience column ignored'`: header `Millions of yen | Millions of yen | Millions of U.S. dollars` → the yen value is read.
  - `'no unit stated → revenue null'`
  - `'forecast column never read'`: a column headed `Forecast for the fiscal year ending March 31, 2027` is ignored.
  - `'basic and diluted under a parent EPS row'`
- [ ] **Step 3: Run** `npx vitest run test/jp/releaseJp.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement** the `'jp'` branches (guarded by `profile === 'jp'`) and `releaseJp.ts`.
- [ ] **Step 5: Run** both corpus commands again and `fc` them against the Step 1 files. Expected: identical. Then run the full server suite and `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(jp): release reader profile jp (yen units, quarter column else YTD, banks)`.

### Task 4: EDINET client, zip reader and XBRL parser  [Group A]

**Depends on:** nothing. Uses `EDINET_API_KEY` if set; it is never printed.

**Files:**
- Create: `server/src/sources/zip.ts`, `server/src/jp/sources/edinet.ts`, `server/src/jp/sources/edinetXbrl.ts`
- Fixtures `server/test/fixtures/jp/edinet/`:
  - `codelist_sjis.zip`: the first 22 raw lines of the real code-list CSV, Shift_JIS, zipped.
  - `small.zip`: two text files, made with PowerShell `Compress-Archive` (deflate).
  - `doclist_sample.json`: a real document-list answer, or a hand-built one matching the documented fields when there is no key; mark it `"source": "hand-built"`.
  - `*.xbrl.gz`: gzipped `PublicDoc` instances, at least 6. See **Corpus** below.
  - `expected.json`
- Test: `server/test/sources/zip.test.ts`, `server/test/jp/edinet.test.ts`, `server/test/jp/edinetXbrl.test.ts`

**Interfaces:**
- `zip.ts`: `unzipEntries(buf: Uint8Array, want: (name: string) => boolean): Map<string, Uint8Array>`.
  - Central directory; methods 0 and 8 (`zlib.inflateRawSync`).
  - Zip64, encryption or another method throws `SourceFormatError`.
- `edinet.ts`:
  - `interface EdinetDoc { docID: string; edinetCode: string; secCode: string | null; filerName: string; docTypeCode: string; ordinanceCode: string | null; periodStart: string | null; periodEnd: string | null; submitDateTime: string; withdrawalStatus: string; xbrlFlag: string }`
  - `interface EdinetClient { docList(date: string): Promise<EdinetDoc[]>; xbrlInstance(docID: string): Promise<string> }`
  - `makeEdinetClient(o: { key: string; fetchImpl?: typeof fetch; minIntervalMs?: number /* 1000 */ }): EdinetClient`
    - `docList` uses `type=2` and checks `metadata.status === '200'`.
    - `xbrlInstance` uses `type=1`, then unzips, then decodes the single `XBRL/PublicDoc/*.xbrl` as UTF-8. Zero or more than one such file throws.
    - Errors: `HttpError` / `SourceFormatError` whose message has `Subscription-Key=***`. The real key never appears in any thrown message.
  - `isResultsFiling(d: EdinetDoc): boolean` (Ruling 13)
  - `codeFromSec(secCode: string | null): string | null` (Ruling 2)
  - `fetchEdinetCodeList(fetchImpl?: typeof fetch): Promise<string>`: the Source-facts URL, unzipped, decoded with `TextDecoder('shift_jis')`
- `edinetXbrl.ts`:
  - `interface EdinetFigures { revenue: number | null; epsBasic: number | null; epsDiluted: number | null; currency: 'JPY' | null; ytdMonths: 6 | 12 | null; standard: 'jgaap' | 'ifrs' | 'usgaap' | null; consolidated: boolean; notes: string[] }`
  - `parseEdinetXbrl(xml: string, doc: { docTypeCode: '120' | '160'; periodEnd: string }): EdinetFigures` (Ruling 14)
    - Contexts are parsed into `{ id, start, end, instant, members[] }`.
    - Facts are read with a namespace-prefix-agnostic regex (as in `india/sources/xbrl.ts`).
    - A fact with `xsi:nil="true"` is blank. Values are full yen (the `decimals` attribute is ignored).
    - Element tables come from Source facts, chosen by `AccountingStandardsDEI`. Revenue never uses an ordinary-income element.

**Corpus (exact-value test).**
- At least 6 real instances:
  - J-GAAP 有報
  - J-GAAP 半期報告書
  - IFRS 有報 (Toyota or Takeda)
  - IFRS 半期報告書
  - US-GAAP filer (Nomura or the nearest available)
  - a bank (MUFG/SMFG/Mizuho, revenue `null`)
  - optionally a non-consolidated-only filer
- With `EDINET_API_KEY`: download through `makeEdinetClient`.
- Without it: download each ZIP by hand from the EDINET viewer (`disclosure2.edinet-fsa.go.jp`, "XBRL" download). Failing that, use the FSA's EDINET taxonomy sample instances. Record `"source": "api" | "viewer" | "fsa-sample"` per entry and write `LIVE API CHECK PENDING: no EDINET_API_KEY` in the commit body. Task 15 repeats the live check.
- `expected.json` per file: `{ docTypeCode, periodEnd, revenue, epsBasic, epsDiluted, ytdMonths, note }`. Values are typed by hand from the same document's PDF/HTML (主要な経営指標等の推移 / statements), **never** copied from the parser.

- [ ] **Step 1: Write failing tests.**
  - `zip.test.ts`:
    - `'reads deflated entries'` (`small.zip`)
    - `'unsupported method throws'` (flip the method bytes in a copy)
  - `edinet.test.ts`:
    - `'doc list parsed and filtered to 120/160 listed, unwithdrawn, with XBRL'`
    - `'secCode 72030 → 7203, 285A0 → 285A, 72031 → null'`
    - `'401 error never contains the key'` (Review Focus 1). A stub fetch returns 401 for key `"sekrit-123"`; the thrown message contains `Subscription-Key=***` and not `sekrit-123`.
    - `'zip without a PublicDoc instance throws'`
    - `'code list is decoded from Shift_JIS'`:
      - The fixture is `codelist_sjis.zip`: the first 22 lines of the real `EdinetcodeDlInfo.csv`, cut as raw Shift_JIS bytes (never re-encoded) and zipped with `Compress-Archive`.
      - A stub fetch serves it.
      - The decoded second line starts `ＥＤＩＮＥＴコード`.
  - `edinetXbrl.test.ts`:
    - `'every corpus document matches its hand-read values exactly'`: loops over `expected.json`, comparing each field with `===`.
    - `'bank: ordinary income never revenue'`
    - `'context chosen by period, not id'`: an inline mini-instance whose consolidated context id is `Foo` with the right dates is read; a context with a segment member is not.
    - `'non-JPY unit → blank'`
    - `'half-year document whose context spans 3 months → all blank'`
    - `'nil fact → blank'`
- [ ] **Step 2: Run** `npx vitest run test/sources/zip.test.ts test/jp/edinet.test.ts test/jp/edinetXbrl.test.ts`. Expected: FAIL.
- [ ] **Step 3: Collect the corpus** and type the expected values by hand.
- [ ] **Step 4: Implement** the three modules. Confirm every element name used against the corpus and the taxonomy list; keep the confirmed list in the `edinetXbrl.ts` header comment.
- [ ] **Step 5: Run** the full server suite and `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(jp): EDINET API client, zip reader and XBRL revenue/EPS parser`. The body states the corpus source and the key status.

### Task 5: Yahoo Japan sources (one client, bulk calendar, batch quotes, summary, indices)  [Group A]

**Depends on:** nothing.

**Files:**
- Create: `server/src/sources/yahooClient.ts`, `server/src/sources/yahooForeignSummary.ts`, `server/src/jp/sources/yahooJp.ts`
- Modify: `server/src/hk/sources/yahooHk.ts`
  - `YahooHkSummary` becomes an alias of `YahooForeignSummary`.
  - `parseYahooHkSummary(json)` = `parseYahooSummaryFor(json, { zone: HKT, capCurrency: 'HKD' })`.
  - The fetcher is unchanged.
- Fixtures `server/test/fixtures/jp/`. Fetch live and save as-is:
  - `y_cal_page1.json`, `y_cal_page2.json` (the bulk calendar for a window with > 100 rows)
  - `y_quote_batch.json` (50 symbols, including one alphanumeric code and one symbol Yahoo does not know)
  - `y_7203.T.json`, `y_3382.T.json` (Feb FY), `y_9983.T.json` (Aug FY): quoteSummary with HK's modules plus `assetProfile`
  - `y_^N225.json`, `y_1306.T.json`
  - `y_chart_7203.T.json`
- Test: `server/test/sources/yahooClient.test.ts`, `server/test/jp/yahooJp.test.ts`. `server/test/hk/yahooHk.test.ts` stays untouched.

**Interfaces:**
- `yahooClient.ts`:
  - `interface YahooClient extends Http { postJson(url: string, body: unknown): Promise<unknown> }`
  - `createYahooClient(o?: { minIntervalMs?: number /* 1000 */; session?: () => Promise<{ crumb: string; headers: Record<string, string> }>; fetchImpl?: typeof fetch; now?: () => number }): YahooClient`
  - One `openYahooSession()` (reused; renewed once on 401/403). It appends `crumb` to every URL, and one limiter covers GET and POST.
  - Error messages carry the URL without the crumb.
- `yahooForeignSummary.ts`:
  - `type YahooForeignSummary` (the current `YahooHkSummary` shape)
  - `parseYahooSummaryFor(json: unknown, o: { zone: string; capCurrency: string }): YahooForeignSummary`: the current HK parser, with `HKT` / `'HKD'` as parameters.
- `yahooJp.ts`:
  - `interface YahooCalRow { symbol: string; code: string; date: string; timing: JpTiming; timeType: string; epsActual: number | null }`
  - `parseYahooCalendarPage(json: unknown): { rows: YahooCalRow[]; total: number | null }`. Ruling 11; rows not ending `.T` are dropped.
  - `fetchJpEarningsCalendar(y: YahooClient, from: string, to: string): Promise<{ rows: YahooCalRow[]; complete: boolean }>`
    - Pages of 100 until `total` or an empty page, at most 80 pages.
    - A failure mid-sweep returns the rows so far with `complete: false`.
  - `interface YahooQuote { symbol: string; price: number | null; prevClose: number | null; time: number | null; currency: string | null; marketCap: number | null /* only when currency === 'JPY' */; name: string | null }`
  - `fetchYahooQuotes(y: YahooClient, symbols: string[]): Promise<Map<string, YahooQuote>>`. Batches of 50; unknown symbols are absent.
  - `createYahooJpSummary(y: YahooClient): (symbol: string, maxAgeMs: number) => Promise<YahooForeignSummary | null>`. Per-symbol cache by fetch time; failures are not cached; zone `JST`, cap currency `'JPY'`.
  - `yahooJpSymbol` is re-exported from `jp/universe.ts` (Task 6). To keep the groups disjoint, this task uses an inline `` `${code}.T` ``.
  - `jpRevenueQuarterLabel(periodEnd: string): string`: the `financialsChart` label convention, pinned by the three summary fixtures. If the fixtures show no consistent rule, it returns `''` (revenue from Yahoo stays blank; Ruling 12).

- [ ] **Step 1: Write failing tests.**
  - `yahooClient.test.ts`:
    - `'GET and POST share one 1 s limiter'`: a fake clock and stub fetch; three calls start at t = 0, 1000 and 2000.
    - `'401 renews the session once'`
    - `'crumb never in the error message'`
  - `yahooJp.test.ts`:
    - `'calendar page: TAS row gets JST date and timing; other rows the UTC date and UNKNOWN'`: from `y_cal_page1.json`, plus one inline TAS row `['7203.T', '2026-11-05T04:25:00.000Z', 'TAS']` → `{ date: '2026-11-05', timing: 'DMH' }` (13:25 JST).
    - `'sweep pages until total; a failing page keeps earlier rows, complete false'` (Review Focus 5)
    - `'batch quotes: alphanumeric code present, unknown symbol absent, cap only in JPY'` (Review Focus 4)
    - `'summary: JPY cap, trend periods with end dates, single next date'` (7203)
    - `'Feb and Aug fiscal years: trend end dates are month ends'` (3382, 9983)
    - `'revenue quarter label rule'`: the expectations taken from the three fixtures.
    - `'indices are JPY'`: `parseIndexQuote` of `y_^N225.json` and `y_1306.T.json`.
    - `'HK summary unchanged'`: the existing `yahooHk.test.ts` passes untouched.
- [ ] **Step 2: Run** `npx vitest run test/sources/yahooClient.test.ts test/jp/yahooJp.test.ts test/hk/yahooHk.test.ts`. Expected: FAIL (new modules missing).
- [ ] **Step 3: Verify the Source-facts endpoints live** (the region operand, batch quote). Record any fallback in the module header. Save the fixtures.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run** the full server suite and `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(jp): Yahoo client (one session, 1 req/s), bulk JP calendar, batch quotes, shared summary parser`.

### Task 6: Universe: EDINET code-list parser, hand-kept full level, live verification  [Group A]

**Depends on:** nothing. The verify CLI needs `SEC_USER_AGENT`.

**Files:**
- Create: `server/src/jp/universe.ts`, `server/src/cli/verifyJpUniverse.ts`
- Modify: `server/package.json` (`"verify-jp-universe": "tsx src/cli/verifyJpUniverse.ts"`)
- Fixture: `server/test/fixtures/jp/codelist_rows.csv` (UTF-8: the two header lines plus 30 real rows from the live file, including 7203, 8306, 8604, an alphanumeric code, a 5-char code not ending in 0 if one exists, a `非上場` row, a row with an empty English name and a row with a comma inside a quoted name)
- Test: `server/test/jp/universe.test.ts`

**Interfaces:**
- `interface JpUniverseEntry { code: string; edinetCode: string; name: string; nameJa: string; fyEndMonth: number | null; industryJa: string | null; adr: string | null; adrRatio: number | null; cik: number | null }`
- `interface JpFullEntry { code: string; adr: string; adrRatio: number; cik: number }`
- `JP_FULL: readonly JpFullEntry[]`: the 8 Source-facts rows, with ratios and CIKs as verified in Step 4.
- `parseEdinetCodeList(csv: string): JpUniverseEntry[]`
  - Quoted-CSV parser.
  - The header line must equal the Source-facts header exactly, else `SourceFormatError`.
  - Applies Rulings 2 and 3.
- `buildJpUniverse(listed: JpUniverseEntry[], full: readonly JpFullEntry[] = JP_FULL): JpUniverseEntry[]`: full entries override; a missing full code is appended with `name: adr`.
- `jpLevel(e): 'full' | 'basic'`: `'full'` iff `cik != null && adr != null`
- `yahooJpSymbol(code: string): string` → `'7203.T'`
- `JP_INDICES = [{ name: 'Nikkei 225', yahoo: '^N225' }, { name: 'TOPIX (ETF 1306)', yahoo: '1306.T' }] as const`
- CLI `verifyJpUniverse.ts`: the HK script, adapted.
  - It uses its own 120 ms SEC client and a 120 ms Cboe client. Per `JP_FULL` entry it prints:
    - the CIK from `company_tickers.json` vs `cik`
    - the Cboe result, through `fetchCboeChain`, which follows the `cdn-api.cboe.com` redirect
    - the ADR-ratio sentence from the latest 20-F
  - Ratio regexes accept integers, words, decimals (`0.2`) and fractions:
    - `one-fifth of one (share|share of common stock)` → 0.2
    - `one-half of one` → 0.5
    - `two-tenths` → 0.2
  - It exits 1 on any mismatch and never touches the database.

- [ ] **Step 1: Write failing tests** (`universe.test.ts`):
  - `'listed rows with codes only; codes 4 chars; alphanumeric kept; non-0 fifth char dropped'` (Review Focus 4)
  - `'English name preferred, Japanese when empty; quoted comma survives'`
  - `'fyEndMonth from 決算日; unparseable → null'`
  - `'header mismatch throws'`
  - `'full level overrides: 7203 is full with TM, ratio 10'`
  - `'exactly 8 full-level entries, codes unique'`
  - `'yahooJpSymbol(285A) === 285A.T'`
- [ ] **Step 2: Run** `npx vitest run test/jp/universe.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `universe.ts` and the CLI.
- [ ] **Step 4: Verify the full level live.**
  - Run `npm run verify-jp-universe -w server` with `SEC_USER_AGENT` set.
  - Fix each CIK and ratio from SEC.
  - Drop a name whose Cboe chain is not listed (it becomes basic). If SMFG's ratio cannot be machine-read, type it from the 20-F sentence and print a visible warning, as HK does for 10-K filers.
  - Re-run until it exits 0, and paste the output into the commit body.
- [ ] **Step 5: Run** the full server suite and `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(jp): EDINET code-list universe and live-verified full level`.

### Task 7: Web shared list parts and yen formatters  [Group A]

**Depends on:** nothing.

**Files:**
- Create: `web/src/components/foreignParts.tsx`
- Modify:
  - `web/src/components/HkStockList.tsx`: uses the parts; no visual change.
  - `web/src/components/listParts.tsx`: `Result` gains `spanLabel?: string | null` and `source?: 'Yahoo' | 'EDINET' | null`.
  - `web/src/lib/format.ts`
- Test: `web/test/foreignParts.test.tsx`, `web/test/format.test.ts` (add cases). `web/test/HkStockList.test.tsx` and `web/test/InStockList.test.tsx` stay unchanged and green.

**Interfaces:**
- `foreignParts.tsx`, each moved out of `HkStockList.tsx` with the same markup:
  - `TIMING_SHORT`
  - `clock(iso: string, zone: string): string`
  - `pct1(n: number): string`
  - `ExpectedMoveLine({ em, level }: { em: ForeignExpectedMove | null; level: 'full' | 'basic' })`, where `ForeignExpectedMove` is a structural type equal to `HkReportDto['expectedMove']` non-null
  - `LiveMoveLine({ live })`
  - `PreviousMoveLine({ pm })`
  - `CurrencyFigure({ f, fmt, source, spanLabel, extra })`: the HK `Figure`, with the formatter and the suffixes passed in
- `Result`:
  - `spanLabel` renders `<span className="muted"> · {spanLabel}</span>` right after the actual.
  - `source` renders `· from Yahoo` / `· from EDINET`.
- `format.ts`:
  - `formatJpPrice(n: number | null): string` → `'¥2,845.5'` (up to 2 decimals, trailing zeros trimmed); `'—'` for null
  - `formatJpMoney(n: number | null, currency: string | null | undefined): string`: compact like `formatHkMoney` with prefix `¥` for `JPY`, `''` when null, `` `${c} ` `` otherwise → `'¥48.04T'`, `'¥12.4B'`
  - `formatJpEps(n: number | null, currency: string | null | undefined): string` → `'¥239.10'`, `'−¥5.00'`
  - `ytdLabel(months: number | null): string | null` → `'YTD (9 months)'`; null for null

- [ ] **Step 1: Write failing tests.**
  - `format.test.ts`:
    - `formatJpPrice(2845.5) === '¥2,845.5'`
    - `formatJpPrice(3120) === '¥3,120'`
    - `formatJpMoney(48_036_704_000_000, 'JPY') === '¥48.04T'`
    - `formatJpEps(-5, 'JPY') === '−¥5.00'`
    - `formatJpEps(1, null) === '1.00'`
    - `ytdLabel(9) === 'YTD (9 months)'`
  - `foreignParts.test.tsx`:
    - `'CurrencyFigure shows span label and EDINET source'`
    - `'basic level without expected move shows — (no options data)'`
- [ ] **Step 2: Run** `npx vitest run test/format.test.ts test/foreignParts.test.tsx` in `web/`. Expected: FAIL.
- [ ] **Step 3: Implement.** Move the parts and re-import them in `HkStockList.tsx`.
- [ ] **Step 4: Run** `npm test` and `npx tsc --noEmit` in `web/`. Expected: PASS, with `git diff --stat web/test/HkStockList.test.tsx` empty.
- [ ] **Step 5: Commit** `refactor(web): shared foreign-list parts; yen formatters`.

### Task 8: `jp_*` tables, repository, job context, DTO, read routes, config  [Group B]

**Depends on:** Tasks 1, 4, 5 and 6 (types). Starts when Group A is merged.

**Files:**
- Create:
  - `server/src/jp/db/schema.ts`, `server/src/jp/db/jpRepo.ts`
  - `server/src/db/adrRows.ts` (`usAdrRows` moved from `hkRepo.ts`; `hkRepo.ts` re-exports it)
  - `server/src/jp/jobs/context.ts`
  - `server/src/jp/api/types.ts`, `server/src/jp/api/dto.ts`, `server/src/jp/api/routes.ts`
- Modify:
  - `server/src/db/repo.ts`: `openDb` calls `ensureJpSchema` after `ensureHkSchema`.
  - `server/src/api/server.ts`: `ServerOptions.jp?: JpServerOptions`; calls `registerJpRoutes`.
  - `server/src/config.ts`:
    - `edinetApiKey: process.env.EDINET_API_KEY ?? ''`
    - `fastFields.jpEps?: boolean`, `jpRevenue?: boolean`, both `false`
    - a comment "JP reader gate: not yet run".
- Test: `server/test/jp/jpRepo.test.ts`, `server/test/jp/api.test.ts`

**Interfaces:**
- **Schema** (same `ADDED_COLUMNS` mechanism as HK):
  - `jp_stocks`: `code PK, edinet_code, name, name_ja, profile_name, yahoo_symbol, level, adr, adr_ratio, cik, fy_end_month NULL, industry_ja, sector, industry, market_cap /*JPY*/, market_cap_as_of, active, updated_at`
  - `jp_reports`:
    - Identity and date: `id INTEGER PK, code, name, period_end, fiscal_quarter, fy_end, period_label, report_date, date_status, timing, timing_source ('sec-6k'|'sec-notice'|'yahoo'|NULL), released_at, rescheduled_from`
    - Revenue actual: `revenue_actual, revenue_currency, revenue_source ('sec'|'edinet'|'yahoo'), revenue_span ('quarter'|'ytd'), revenue_ytd_months`
    - EPS actual: `eps_actual /*basic*/, eps_diluted_actual, eps_currency, eps_source, eps_span, eps_ytd_months`
    - Documents: `sec_doc_url, edinet_doc_id`
    - Estimates: `eps_estimate, eps_analysts, revenue_estimate, revenue_analysts, estimate_currency, estimate_span ('quarter'|'year'), estimates_fetched_at`
    - Previous move: `prev_move_pct, prev_move_date, prev_move_basis, prev_move_checked_at, calendar_fetched_at`
    - `UNIQUE(code, period_end)`
  - `jp_expected_moves`, `jp_live_moves`, `jp_sec_seen`: as HK.
  - `jp_edinet_seen (doc_id PK, code, doc_type, period_end, outcome TEXT /* 'merged'|'no-row'|'blank'|'error' */, seen_at)`
  - `jp_past_dates (code, date, timing NULL, PRIMARY KEY(code, date))`
- **Repo**, mirroring every HK repo function with the `Jp` name and JST semantics:
  - Setup and stocks:
    - `JP_ID_BASE = 3_000_000_001`
    - `ensureJpSchema(db)`
    - `syncJpUniverse(db, entries: readonly JpUniverseEntry[], now): void`: upsert; missing codes become `active = 0`; full-level fields from the entry.
    - `setJpProfile(db, code, p: { name: string | null; sector: string | null; industry: string | null; marketCap: number | null; asOf: string | null }, now): void`: COALESCE.
    - `jpStocks(db): JpStock[]`
  - Calendar and release:
    - `upsertJpCalendarRow(db, row: { code; name; period: JpPeriod; periodLabel: string; reportDate; dateStatus; timing?: JpTiming; timingSource?: string }, now): number`
    - `recordJpRelease(db, id, releasedAt, timing: JpTiming | null): boolean`: source `'sec-6k'`.
    - `nearestUnreleasedJp(db, code, day, windowDays = 3)`
    - `findJpReportId(db, code, periodEnd)`
    - `moveJpReportDate(db, id, newDate, opts?: { keepTiming?: boolean })`
    - `setJpTiming(db, id, timing, source: 'yahoo'): boolean`
  - Actuals and estimates:
    - `mergeJpActuals(db, id, a: { revenue?: { value: number; currency: string; span: 'quarter' | 'ytd'; ytdMonths: 6 | 9 | 12 | null } | null; eps?: { basic: number | null; diluted: number | null; currency: string; span: 'quarter' | 'ytd'; ytdMonths: 6 | 9 | 12 | null } | null; source: 'sec' | 'edinet' | 'yahoo'; docUrl?: string | null; edinetDocId?: string | null }, now): boolean`
      - Per field group, rank `sec 3 > edinet 2 > yahoo 1`.
      - Write when nothing is stored or the incoming rank is higher. Equal or lower rank is never written.
      - A null value never blanks.
      - An EPS group with `basic` null and `diluted` non-null is stored only when nothing is stored.
    - `setJpEstimates(db, id, e: { eps; epsAnalysts; revenue; revenueAnalysts; currency; span: 'quarter' | 'year' }, now): void`: COALESCE; a different `span` replaces all four estimate values.
  - Lists:
    - `listJpRange(db, f: { from; to; q })`: `q` matches the code, the English name or the Japanese name.
    - `listJpForSymbols(db, codes, from, to)`
    - `getJpReport(db, id): JpReport | undefined`
  - Moves:
    - `saveJpExpectedMove(db, id, em, final, now): boolean`
    - `saveJpLiveMove(db, id, m, now): boolean`
    - `storedJpExpectedMove(db, id): { quoteDate: string; final: boolean } | null`
    - `setJpPrevMove(db, id, move | null, now): void`
  - Job queries:
    - `jpReportsBetween(db, from, to): JpPending[]`, where `JpPending = { id; code; reportDate; timing; periodEnd; fiscalQuarter; releasedAt; level; adr; cik; hasEps; hasRevenue; expectedFinal }`
    - `jpReportsNeedingPrevMove(db, from, to, recheckBefore)`
    - `priorJpReleased(db, code, before)`
    - `upsertJpPastDates(db, rows: { code: string; date: string; timing: JpTiming | null }[]): number`
    - `jpPastDates(db, code): { date: string; timing: JpTiming | null }[]`
    - `jpPastDatesCount(db): number`
  - SEC and EDINET bookkeeping:
    - `jpSecSeen`, `markJpSecSeen`, `lastJpSecSeenAt`
    - `edinetSeen(db, docId): boolean`, `markEdinetSeen(db, docId, code, docType, periodEnd, outcome, now)`, `lastEdinetSeenAt(db): string | null`
- **`JpJobContext`** (`jp/jobs/context.ts`; re-exports `guardedIn` / `trackIn` like HK):
  ```ts
  interface JpJobContext {
    db: DatabaseSync; now(): string; todayJST(): string;
    yahooCalendar(from: string, to: string): Promise<{ rows: YahooCalRow[]; complete: boolean }>;
    yahooSummary(symbol: string, maxAgeMs: number): Promise<YahooForeignSummary | null>;
    yahooQuotes(symbols: string[]): Promise<Map<string, YahooQuote>>;
    yahooCloses(symbol: string, from: string, to: string): Promise<Map<string, number>>;
    edinetCodeList(): Promise<string>;
    edinet: EdinetClient | null;            // null without EDINET_API_KEY
    optionChain(adr: string): Promise<OptionChain | null>;
    secHttp: Http | null;
    tierA(): string[];                      // visible ∪ watched JP codes
  }
  ```
- **Types** (`jp/api/types.ts`, type-only):
  - `JpFigureDto { estimate; analysts; estimateCurrency; estimateSpan: 'quarter' | 'year' | null; actual; actualCurrency; actualSource: 'sec' | 'edinet' | 'yahoo' | null; actualSpan: 'quarter' | 'ytd' | null; ytdMonths: 6 | 9 | 12 | null; surprisePct; result: BeatMiss | null }`
  - `JpReportDto`:
    - Identity: `{ id; market: 'JP'; symbol; name; nameJa; level; adrTicker; adrRatio }`
    - Date and timing: `reportDate; dateStatus; period; periodEnd; fiscalQuarter; fyEnd; timing: JpTiming; timingSource; releasedAt; rescheduledFrom`
    - Company: `sector; industry; industryJa; marketCap; marketCapAsOf`
    - Documents: `secDocUrl; edinetDocId`
    - Figures: `eps: JpFigureDto; epsDiluted: number | null; revenue: JpFigureDto`
    - Moves: `expectedMove` (as HK), `liveMove`, `previousMove`
  - `JpEarningsResponse`, `JpLivePriceDto`, `JpMarketDto` (as HK)
  - `JpAdminDto { full; basic; secConfigured; edinetConfigured; readerOn; lastSixKAt; lastEdinetAt }`
- **DTO:** `toJpDto(r: JpReport): JpReportDto`. A figure is compared only when all of these hold:
  - the currencies are equal and non-null
  - the spans match (quarter actual and quarter estimate, or `ytd` 12 actual and year estimate)
  - for EPS, `actualSource !== 'sec'`
- **Routes:** `registerJpRoutes(app, db, currentUser, nowFn, opts: JpServerOptions)` with `GET /api/jp/earnings`, `/api/jp/earnings/:id`, `/api/jp/prices` and `/api/jp/markets`. They are the HK routes with `JP_INDICES` (`/api/admin/jp` is Task 9).

- [ ] **Step 1: Write failing tests.**
  - `jpRepo.test.ts`:
    - `'ids start at 3_000_000_001'`
    - `'estimated date never replaces confirmed; confirmed new date is a reschedule'`
    - `'precedence: edinet replaces yahoo, never sec; yahoo never replaces edinet; sec replaces both; equal source first wins; null never blanks'`
    - `'revenue and EPS groups keep their own source and span'`: EDINET revenue with SEC EPS on one row.
    - `'final expected move never replaced'`
    - `'past dates upsert is idempotent'`
    - `'usAdrRows still importable from hkRepo'`
  - `api.test.ts`:
    - `'colour only for same currency and same span'` (Review Focus 2). Four rows:
      - quarter vs quarter: `beat`
      - ytd 6 vs quarter: `null`, both numbers shown
      - ytd 12 vs year: coloured
      - SEC EPS vs estimate: EPS `null`, revenue coloured
    - `'actualSource edinet, span and ytdMonths in the row'`
    - `'GET /api/jp/earnings/:id 404'`
    - `'rejects bad ranges'`
    - `'markets falls back to index quotes for Nikkei 225 and TOPIX (ETF 1306)'`
- [ ] **Step 2: Run** `npx vitest run test/jp/jpRepo.test.ts test/jp/api.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** as above.
- [ ] **Step 4: Run** the full server suite and `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(jp): jp_* tables, repository, job context, DTO and /api/jp read routes`.

### Task 9: Market `'JP'` across shared server plumbing, status and admin  [Group C]

**Depends on:** Task 8.

**Files:**
- Modify:
  - `server/src/india/api/types.ts`: `Market = 'US' | 'IN' | 'HK' | 'JP'`
  - `server/src/india/db/inRepo.ts`: prefs round-trip `'JP'`
  - `server/src/india/api/routes.ts`: error text `market must be "US", "IN", "HK" or "JP"`
  - `server/src/watchlist/store.ts`: the CHECK lists all four. The rebuild runs when the stored SQL lacks `'JP'` (generalise `rebuildWithHk` → `rebuildWatchlists`; the HK test still passes).
  - `server/src/watchlist/routes.ts`: `asMarket` accepts `'JP'`; normalise JP = `trim().toUpperCase()` and require `^[0-9][0-9A-Z]{3}$`; `/rows` JP via `listJpForSymbols` + `toJpDto` with JST "today".
  - `server/src/watchlist/search.ts`: `jpEntries(db?: Db): IndexEntry[]` from active `jp_stocks` (English + Japanese name, `exchange: 'TSE'`), and the `JP` key.
  - `server/src/notes/store.ts`: `jpNoteDeadline(r)` (`releasedAt` + 24 h; else BMO 09:00 JST, UNKNOWN 23:59:59 JST, otherwise 15:30 JST; all + 24 h), the LEFT JOIN on `jp_reports`, and the fall-through.
  - `server/src/notes/routes.ts`: the report lookup also tries `getJpReport`.
  - `server/src/jobs/coverage.ts`: JP fields per Ruling 20; source `jp_reports r JOIN jp_stocks s ON s.code = r.code AND s.active = 1`; `runCoverageCheck(db, todayUs, todayIn, todayHk, todayJp, log)`.
  - `server/src/cli/coverageCheck.ts`: passes `todayJST()`.
  - `server/src/api/types.ts`: `StatusResponse.coverage.JP`; `WatchRow` unions include `JpReportDto`.
  - `server/src/api/server.ts`:
    - `/api/status` adds JP.
    - `PUT /api/live/visible` accepts `market: 'JP'` with codes matching `^[0-9][0-9A-Z]{3}$`, routed to `opts.jp?.setVisible`.
    - `JpServerOptions` gains `setVisible?`.
  - `server/src/jp/api/routes.ts`: `GET /api/admin/jp`, admins only, returns `JpAdminDto`:
    - `edinetConfigured = !!config.edinetApiKey`
    - `readerOn = !!(config.fastFields.jpEps || config.fastFields.jpRevenue)`
    - The key value itself is never in the body.
- Test: `server/test/jp/plumbing.test.ts`, plus signature updates in existing coverage tests only.

**Interfaces:**
- Produces:
  - `Market` (4 values)
  - `jpNoteDeadline`, `jpEntries`
  - `runCoverageCheck(db, todayUs, todayIn, todayHk, todayJp, log): number`
  - `JpAdminDto` route

- [ ] **Step 1: Write failing tests** (`plumbing.test.ts`):
  - `'prefs round-trip JP'`
  - `'old watchlists table without JP is rebuilt and keeps US and HK rows'`
  - `'JP watch accepts 7203 and 285a (stored 285A), rejects 72030'`
  - `'JP note deadline: 15:30 JST + 24 h for AMC without release time'`: `jpNoteDeadline({ reportDate: '2026-11-05', timing: 'AMC', releasedAt: null }) === '2026-11-06T06:30:00.000Z'`
  - `'status coverage has JP rows; expectedMove counts full level only'`
  - `'admin jp: admins only; edinetConfigured true/false; body never contains the key'`: set `config.edinetApiKey = 'sekrit-123'` in the test and assert the JSON text lacks it.
  - `'visible accepts JP codes'`
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement** the modifications listed under Files.
- [ ] **Step 4: Run** the full server suite and `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(jp): market JP in prefs, watchlists, notes, search, coverage, status and admin`.

### Task 10: Japan Yahoo jobs (universe, bulk calendar, past dates, tiered estimates, Yahoo results, previous moves)  [Group C]

**Depends on:** Tasks 1, 4 (`fetchEdinetCodeList`), 5, 6 and 8.

**Files:**
- Create: `server/src/jp/jobs/stocks.ts`, `pastDates.ts`, `calendar.ts`, `estimates.ts`, `results.ts`, `prevMoves.ts`
- Test: `server/test/jp/jobs.test.ts` (stub `JpJobContext`, fixtures from Tasks 5 and 6)

**Interfaces:**
- Consumes: `JpJobContext`, the repo, `jpPeriodFor` / `jpPeriodLabel`, `jpDateFromUs`, `jpReactionWindow`, `reactionMovePct` (`india/domain/inMoves.ts`), `usAdrRows`, `parseEdinetCodeList`, `buildJpUniverse`.
  - Yahoo actuals are written as `mergeJpActuals(db, id, { eps: { basic, diluted: null, currency, span: 'quarter', ytdMonths: null }, revenue: { value, currency, span: 'quarter', ytdMonths: null }, source: 'yahoo' }, now)`. That is the Task 8 signature; a group without a value is `null`.
- Produces:
  - `refreshJpStocks(ctx): Promise<void>`
    1. `edinetCodeList()`, then `parseEdinetCodeList`, then `buildJpUniverse`, then `syncJpUniverse`.
    2. `yahooQuotes` for all active symbols (batches of 50) → `setJpProfile` (served name: English code-list name, else Yahoo name, else Japanese; cap only in JPY).
    3. `checkJpHolidayCoverage(ctx)`: a `jp-holidays` warning when `holidaysUnknownJp(addDaysJST(today, 60))`.
    - A failed code-list fetch keeps the stored universe (nothing is deactivated).
  - `refreshJpPastDates(ctx): Promise<number>`: bulk sweep `[today−400, today−1]` → `upsertJpPastDates` (TAS timing, else null). Returns the rows written.
  - `refreshJpCalendar(ctx): Promise<void>`
    1. Bulk sweep `[today, today+120]`.
    2. Drop past dates and the Ruling 11 ambiguous groups.
    3. Full level: ADR US rows merged per Ruling 8.
    4. `upsertJpCalendarRow` (`estimated`) for stocks with a `fyEndMonth`.
    5. A `TAS` row sets the timing through `setJpTiming(…, 'yahoo')`.
    - An incomplete sweep writes what it got and records a source error `yahoo-jp-calendar`.
  - `refreshJpEstimates(ctx): Promise<void>`: Ruling 10 tiers and budget; trend matching per Ruling 5 → `setJpEstimates`. `assetProfile` sector/industry → `setJpProfile`.
  - `refreshJpYahooResults(ctx): Promise<number[]>`: Ruling 12. It runs `ctx.yahooCalendar(today−20, today)`, then fetches summaries (tier B max age) for the qualifying symbols, then calls `mergeJpActuals` as above. Returns the changed ids.
  - `computeJpPrevMoves(ctx): Promise<void>`
    - Rows in Ruling 10's set without a previous move, not checked in 20 h.
    - Prior date: `priorJpReleased`; else the ADR US row (mapped by `jpDateFromUs`; US AMC → `BMO`, US BMO/DMH → `AMC`, as the HK fix); else `jpPastDates`. Within 45–140 days.
    - Unknown timing → `AMC`, basis `assumed`.
    - Closes via `ctx.yahooCloses`; a failed fetch is skipped (retried).

- [ ] **Step 1: Write failing tests** (`jobs.test.ts`):
  - `'universe sync: 7203 full, 285A basic, a dropped code inactive; failed code-list fetch deactivates nothing'`
  - `'stale bulk date creates no row; confirmed date never moved'` (Review Focus 5)
  - `'two different dates in one fiscal period → no row; dates in different periods → two rows'` (Review Focus 5)
  - `'sweep incomplete: rows so far written, nothing deleted, source error recorded'`
  - `'full level: US BMO 2026-11-05 + Yahoo 2026-11-05 → row 2026-11-05 estimated 2Q FY27; disagreement → nothing'`
  - `'TAS 13:25 JST sets DMH; other types leave Time not announced'`
  - `'no fyEndMonth → no row'`
  - `'estimates: Q4 row takes the year item (span year); Q2 row the quarter item; budget and nearest-first respected'` (stub counts `yahooSummary` calls with the budget set to 2)
  - `'Yahoo results only for symbols with a bulk epsActual; never over an EDINET value'`
  - `'previous move from the ADR US row with US BMO → JST AMC window'`
  - `'previous move from jp_past_dates with unknown timing → assumed'`
- [ ] **Step 2: Run** `npx vitest run test/jp/jobs.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the six modules.
- [ ] **Step 4: Run** the full server suite and `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(jp): universe, bulk calendar, past dates, tiered estimates, Yahoo results and previous-move jobs`.

### Task 11: EDINET results job and ADR expected moves on a shared moves module  [Group C]

**Depends on:** Tasks 1, 4 and 8.

**Files:**
- Create: `server/src/jobs/adrMoves.ts`, `server/src/jp/jobs/moves.ts`, `server/src/jp/jobs/edinetResults.ts`
- Modify: `server/src/hk/jobs/moves.ts`: `snapshotHkMoves` / `refreshHkLiveMoves` call `adrMoves.ts` with the HK repo functions. `server/test/hk/moves.test.ts` stays untouched.
- Fixture: `server/test/fixtures/jp/cboe_TM.json` (live chain, saved as-is)
- Test: `server/test/jobs/adrMoves.test.ts`, `server/test/jp/moves.test.ts`, `server/test/jp/edinetResults.test.ts`

**Interfaces:**
- `adrMoves.ts`:
  - `interface AdrMoveRow { id: number; reportDate: string; timing: LocalTiming; releasedAt: string | null; adr: string }`
  - `interface AdrMovesDeps { db; now(): string; todayLocal(): string; addDays(d, n): string; optionChain(adr): Promise<OptionChain | null>; candidates(from: string, to: string): AdrMoveRow[]; stored(id): { quoteDate: string; final: boolean } | null; saveExpected(id, em: ExpectedMove & { adr: string; quoteDate: string }, final: boolean, now): boolean; saveLive(id, m, now): boolean }`
  - `snapshotAdrMoves(d: AdrMovesDeps): Promise<number[]>` and `refreshAdrLiveMoves(d: AdrMovesDeps): Promise<number[]>`: the current HK bodies, including the after-US-close final rule.
- `jp/jobs/moves.ts`: `snapshotJpMoves(ctx)`, `refreshJpLiveMoves(ctx)`.
- `edinetResults.ts`: `refreshJpEdinet(ctx: JpJobContext, dates: string[]): Promise<number[]>`
  - Without `ctx.edinet` it is a no-op; it records `edinet` as "not configured" once per run via `recordSourceError(db, 'edinet', 'EDINET_API_KEY not set', now)`.
  - Per date: `docList` (guarded, failover name `edinet`), then `isResultsFiling`, then filter to active codes and unseen ids.
  - Per document: `xbrlInstance`, then `parseEdinetXbrl`, then `findJpReportId(code, doc.periodEnd)`.
    - A matching row: `mergeJpActuals(db, id, { revenue: revenue != null ? { value: revenue, currency: 'JPY', span: 'ytd', ytdMonths } : null, eps: epsBasic != null || epsDiluted != null ? { basic: epsBasic, diluted: epsDiluted, currency: 'JPY', span: 'ytd', ytdMonths } : null, source: 'edinet', edinetDocId: docID }, now)` (Task 8 signature).
    - Outcomes: `merged` / `no-row` / `blank` (parser returned all blank). A thrown error is not marked seen, so it is retried next run.
  - Returns the changed ids.
  - `jpEdinetDates(today: string, mode: 'today' | 'backfill'): string[]`: `[today]`, or the 7 days ending today.

- [ ] **Step 1: Write failing tests.**
  - `adrMoves.test.ts`: the HK `moves.test.ts` cases re-run through `snapshotAdrMoves` with stub deps (final at the last US close, earlier is provisional, post-release quotes never used, blocked Cboe keeps the stored value).
  - `jp/moves.test.ts`:
    - `'TM chain: report 2026-11-05, asOf 2026-11-04 after 16:00 ET → final'`
    - `'basic rows skipped'`
  - `edinetResults.test.ts` (stub `EdinetClient` serving the Task 4 corpus):
    - `'半期報告書 merges ytd 6 into the 2Q row with source edinet and docId'`
    - `'有報 merges ytd 12 into the FY row'`
    - `'no row with that period end → marked no-row, nothing created'`
    - `'never replaces SEC; replaces Yahoo'`
    - `'each docID handled once'`
    - `'download error: not marked seen, source error has no key'` (Review Focus 1: the stub throws an error whose message contains the redacted URL; assert `source_errors` text has no `sekrit-123`)
    - `'no client → no-op with "not configured" status'`
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.** Move the HK bodies first and run `test/hk/moves.test.ts`, which stays untouched. Then the JP wrappers and the EDINET job.
- [ ] **Step 4: Run** the full server suite and `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(jp): EDINET results job; ADR expected moves on a shared module`.

### Task 12: 6-K corpus, reader gate and held-out set (profile `'jp'`)  [Group C]

**Depends on:** Tasks 2, 3 and 8 (config flags). Needs `SEC_USER_AGENT`.

**Files:**
- Create:
  - `server/src/cli/collectJpCorpus.ts`
  - `server/test/fixtures/jp/releases/*.htm`, `server/test/fixtures/jp/releases/expected.json`
  - `server/test/fixtures/jp/releases/heldout/*.htm`, `heldout/expected.json`
  - `server/test/jp/readerGate.test.ts`
- Modify:
  - `server/src/cli/readerCorpus.ts`: `--jp` and `--jp-heldout` (the `--hk` path is untouched)
  - `server/src/config.ts`: flips `jpEps` / `jpRevenue` and the comment, only if both gates pass
  - `server/package.json`: `"collect-jp-corpus": "tsx src/cli/collectJpCorpus.ts"`

**Interfaces:**
- `collectJpCorpus.ts [--heldout]`:
  - Own 120 ms SEC client.
  - For each `JP_FULL` CIK: 6-K filings of the last 24 months, then `pickReleaseDoc`, then `classifySixK(…, { profile: 'jp', filedOn })`.
  - `results` exhibits ≤ 3 MB are saved as `<ADR>_<periodEnd>.htm`.
  - Entries: `{ adr, cik, accession, periodEnd, fiscalQuarter, revenue: null, eps: null, epsDiluted: null, currency: null, span: null, ytdMonths: null, checked: false, note: '' }`. Existing entries are never changed.
  - Required coverage of the main set (≥ 20):
    - all 8 issuers
    - ≥ 3 bank releases
    - ≥ 4 releases with a standalone-quarter column
    - ≥ 4 YTD-only releases, if that many exist
  - `--heldout` saves 6 releases not in the main set (the newest release of 6 different issuers) into `heldout/`.
- Exact rule: a release is exact when all six fields (`revenue, eps, epsDiluted, currency, span, ytdMonths`) `===` the hand-read values (`null === null` counts).
- `gatePasses(set) = checked >= 20 && exact === checked && wrong === 0` for the main set; the held-out set needs `checked >= 6 && exact === checked && wrong === 0`.

- [ ] **Step 1: Write the failing gate test** (`readerGate.test.ts`):
  - `'never wrong'`: every checked entry of both sets: each field `readJpRelease` returns is null or equal to expected.
  - `'flags follow both gates'`: `config.fastFields.jpEps === (main && heldout)` and the same for `jpRevenue`.
  - `'corpus big enough'`: main `checked >= 20` with all 8 ADRs; held-out `checked >= 6`.
- [ ] **Step 2: Run** `npx vitest run test/jp/readerGate.test.ts`. Expected: FAIL (no corpus).
- [ ] **Step 3: Collect both sets** before touching the reader: `npm run collect-jp-corpus -w server`, then `npm run collect-jp-corpus -w server -- --heldout`.
- [ ] **Step 4: Hand-check every file in both sets.**
  - Read basic EPS, diluted EPS, yen revenue (null for ordinary-income-only banks), the span and the YTD months, from the release.
  - `note` quotes the row label and column header.
  - Never copy reader output.
- [ ] **Step 5: Run** `npm run reader-corpus -w server -- --jp`.
  - Fix each `wrong` in the `'jp'` profile / `releaseJp.ts`; Task 3 tests stay green.
  - **Do not open or tune on the held-out files.**
- [ ] **Step 6: Run** `npm run reader-corpus -w server -- --jp-heldout` once.
  - If any held-out release is wrong, fix the reader generically, collect **6 new** held-out releases (moving the failed ones into the main set), and repeat.
  - Set `jpEps` / `jpRevenue` to `true` only when both gates pass; otherwise leave them `false` and record the score in the comment.
  - Confirm `--hk` output is unchanged from Task 3's snapshot.
- [ ] **Step 7: Run** the full server suite and `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 8: Commit** `test(jp): 6-K release corpus, held-out set and reader gate`. The body gives both scores, e.g. `JP reader 22/22 exact, held-out 6/6, 0 wrong: gate on`.

### Task 13: Live: Japan on the shared 6-K watcher, SEC sweep, delayed prices, scheduler, wiring  [Group D]

**Depends on:** Tasks 2, 5, 8, 9, 10 and 11.

**Files:**
- Create:
  - `server/src/live/delayedPrices.ts`
  - `server/src/jp/live/jpSixK.ts`, `server/src/jp/live/jpPrices.ts`
  - `server/src/jp/jobs/secSweep.ts`, `server/src/jp/jobs/scheduler.ts`
- Modify:
  - `server/src/hk/live/hkPrices.ts`: `HkPrices extends DelayedPrices` with the same constructor and behaviour; `server/test/hk/hkPrices.test.ts` stays untouched.
  - `server/src/index.ts`
- Test: `server/test/live/delayedPrices.test.ts`, `server/test/jp/jpSixK.test.ts`, `server/test/jp/jpPrices.test.ts`, `server/test/jp/scheduler.test.ts`

**Interfaces:**
- `delayedPrices.ts`:
  - `class DelayedPrices` with the body of `HkPrices`, parameterised by:
    ```ts
    { market: 'HK' | 'JP'; zone: string; isTradingDay(d: string): boolean; sessionFromMin: number; sessionToMin: number;
      symbolOf(code: string): string; indices: readonly { name: string; yahoo: string }[];
      failoverNames: { prices: string; indices: string }; reportingCodes(db, from: string, to: string): string[] }
    ```
  - Its deps add an optional `quotes?(symbols: string[]): Promise<Map<string, { price: number; prevClose: number; time: number }>>`. When present, stock rounds use it in chunks of 50.
  - Exposes `visibleCodes(): string[]`.
- `JpPrices`: `market 'JP'`, `JST`, `isJpTradingDay`, 08:45–15:45, `yahooJpSymbol`, `JP_INDICES`, names `yahoo-jp-prices` / `yahoo-jp-indices`, `quotes` via `fetchYahooQuotes`.
- `jpSixK.ts`:
  - `handleJpFiling(ctx: JpJobContext, f: ForeignFiling, gates = config.fastFields): Promise<{ released: number[]; dated: number[] }>`: Ruling 15, using `classifySixK(…, { profile: 'jp', filedOn: JST date of acceptance })` and `readJpRelease(html, { periodEnd, fiscalQuarter })`.
    - `jpEps` open and `eps != null`: the EPS group is `{ basic: eps, diluted: epsDiluted, currency, span, ytdMonths }`.
    - `jpRevenue` open and `revenue != null`: the revenue group is `{ value: revenue, currency, span, ytdMonths }`.
    - Both go to `mergeJpActuals(db, id, { eps, revenue, source: 'sec', docUrl }, now)`.
    - Only the earliest filing of a period is read (HK rule).
  - `jpSixKMarket(ctx, onChanged): SixKMarket`: `ciks()` from active full-level `jp_stocks`; `eightKCiks()` is empty; `due()` = a full-level report in JST today−1..+3, unreleased.
- `secSweep.ts`: `sweepJpSec(ctx): Promise<number[]>` = `sweepSixK(…, jpSixKMarket(ctx, () => {}), since = today−45)`.
- `JP_CRONS`, timezone `Asia/Tokyo` unless marked ET:
  - `stocks: '0 6 * * 1'`
  - `pastDates: '0 3 * * 0'`
  - `calendar: '5 */2 * * *'`
  - `estimates: '20 * * * *'`
  - `results: '25,55 * * * *'`
  - `edinetToday: '*/30 9-19 * * 1-5'`
  - `edinetBackfill: '0 2 * * *'`
  - `secSweep: '20,50 * * * *'` (only with `secHttp`)
  - `prevMoves: '30 1 * * *'`
  - `movesSnapshot: '20 16 * * 1-5'` (ET)
  - `liveMoves: '* 9-15 * * 1-5'` (ET)
- `startJpScheduler(ctx, job, hooks: { onResults?; onMoves? })`
- `warmUpJp(ctx, job)`, in order, job names prefixed `jp-`:
  1. stocks
  2. pastDates, only when `jpPastDatesCount === 0`
  3. calendar
  4. results
  5. secSweep
  6. EDINET backfill
  7. estimates
  8. prevMoves
  9. moves snapshot (HK lesson: provisional moves at start)
- **`index.ts` wiring.** Do not run the server; tests and typecheck only.
  - `const jpYahoo = createYahooClient()`: the only Japan Yahoo client.
  - `jpCtx`:
    - `yahooCalendar: (f, t) => fetchJpEarningsCalendar(jpYahoo, f, t)`
    - `yahooSummary: createYahooJpSummary(jpYahoo)`
    - `yahooQuotes: (s) => fetchYahooQuotes(jpYahoo, s)`
    - `yahooCloses: (s, f, t) => fetchYahooDailyCloses(jpYahoo, s, f, t, JST)`
    - `edinetCodeList: () => fetchEdinetCodeList()`
    - `edinet: config.edinetApiKey ? makeEdinetClient({ key: config.edinetApiKey }) : null`
    - `optionChain: (adr) => sources.optionChain(adr)`
    - `secHttp: sources.secHttp ?? null`
    - `tierA: () => [...new Set([...jpPrices.visibleCodes(), ...allWatched(db, 'JP')])]`
  - `jpPrices = new JpPrices(db, { quote: (s) => fetchStockQuote(jpYahoo, s), quotes: …, index: (s) => fetchIndexQuote(jpYahoo, s) }, publish 'jp-prices', publish 'jp-indices')`
  - `buildServer(…, { jp: { prices, indices, indexQuote, setVisible } })`
  - `startSymbolRefresh` gets `JP: async () => jpEntries(db)`.
  - `onWatchAdded` `'JP'` → `jpPrices.refresh()`.
  - With `secHttp`:
    - Replace `new HkSecWatch(...)` with `const sixK = new SixKWatch([hkSixKMarket(hkCtx, publishHk), jpSixKMarket(jpCtx, publishJp)], secHttp, { db, now })`.
    - Pass `(items) => sixK.onUsFeed(items)` to `SecWatch`.
    - Call `sixK.start()`.
  - `startJpScheduler(jpCtx, job, { onResults: publish 'jp-results', onMoves: publish 'jp-moves' })`, then `void warmUpJp(jpCtx, job)`, then `jpPrices.start()`.

- [ ] **Step 1: Write failing tests.**
  - `delayedPrices.test.ts`:
    - `'batch quotes used in chunks of 50'`
    - `'unpriced code fetched on the next tick'`
  - `jpPrices.test.ts`:
    - `'polls visible ∪ watched ∪ reporting codes, publishes only changes'`
    - `'outside 08:45–15:45 JST stocks poll every 15 min'`
    - `'year-end closure is off-session'` (fake clock 2026-12-31 10:00 JST)
  - `jpSixK.test.ts` (stub `Http` serving the Task 2 fixtures):
    - `'Toyota results 6-K flips the matching period row; timing stays UNKNOWN; releasedAt = acceptance'`
    - `'release for another period never flips today's row'`
    - `'gate closed: flipped, no actuals; gate open: SEC actuals with span from the reader'`
    - `'SEC replaces an EDINET value'`
    - `'shared watcher: an HK CIK and a JP CIK in one feed each reach their market'`
  - `scheduler.test.ts`: `'warm-up runs in order, skips pastDates when populated, survives a failing source'`
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.** Do `DelayedPrices` first and run `test/hk/hkPrices.test.ts`, which stays untouched. Then the Japan modules and the wiring.
- [ ] **Step 4: Run** the full server suite and `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(jp): shared 6-K watcher for HK+JP, JP sweep, delayed prices, scheduler and wiring`.

### Task 14: Web: Japan market, list, strip, status and admin  [Group D]

**Depends on:** Tasks 7, 8 and 9.

**Files:**
- Create: `web/src/components/JpStockList.tsx`
- Modify:
  - `web/src/lib/market.ts`: `Market` adds `'JP'`
  - `web/src/hooks/useMarket.ts`: accepts `'JP'`
  - `web/src/components/Header.tsx`: button `id="market-jp"` labelled `Japan`; search placeholder `Find a code or company`
  - `web/src/api.ts`:
    - `fetchReport` handles JP.
    - `fetchJpEarnings`, `fetchJpPrices`.
    - Re-exports the JP types.
  - `web/src/adminApi.ts`: `fetchJpAdmin()`
  - `web/src/hooks/useLiveResults.ts`: 7th parameter `jp?: JapanLive` (same shape as `HongKongLive` with JP types); `jp-results`, `jp-moves`, `jp-prices`, `jp-indices` in the event list
  - `web/src/hooks/useVisibleSymbols.ts`: `market: 'US' | 'HK' | 'JP'`
  - `web/src/lib/liveCap.ts`: `todayJst()`
  - `web/src/components/WatchlistView.tsx`: JP branch (`todayJst`, `formatJpPrice`, `formatJpEps` / `formatJpMoney` with each side's currency)
  - `web/src/components/Calendar.tsx`:
    - JP state, effect, live group and render branches (week view default, like HK)
    - `useVisibleSymbols(market !== 'IN', market)` (US/HK/JP)
    - Footer: `Data from SEC EDGAR, Cboe (delayed), Yahoo Finance (delayed ~20 min) and EDINET (Financial Services Agency), edited. Times in JST. Prototype, not trading advice.`
  - `web/src/components/MarketBar.tsx`: `JapanMarketBar({ live }: { live?: JpMarketDto[] })`, which polls `/api/jp/markets` every 15 s, merges pushes, uses exchange label `TSE` and adds `· delayed` after each name
  - `web/src/components/StatusPage.tsx`: `<CoverageTable market="Japan" rows={data.coverage.JP} />`
  - `web/src/components/AdminPage.tsx`: read-only `JapanPanel` with these lines:
    - "Full level N · Basic level M"
    - "SEC access: configured / not configured (set SEC_USER_AGENT)"
    - "EDINET key: configured / not configured (set EDINET_API_KEY)"
    - "6-K reader: on / off until 20 releases and the held-out set are read exactly right"
    - "Last 6-K seen: …"
    - "Last EDINET document: …"
  - `web/src/styles.css`: nothing new unless needed (`.basic-tag`, `.delayed` already exist)
- Test: `web/test/JpPlumbing.test.tsx`, `web/test/JpStockList.test.tsx`, `web/test/MarketBar.test.tsx`, `web/test/StatusPage.test.tsx`, `web/test/AdminPage.test.tsx`, `web/test/useLiveResults.test.tsx` (add cases)

**Interfaces:**
- `jpKey(code) => \`JP:${code}\``
- `JpStockList(props)`: same props as `HkStockList`, with `rows: JpReportDto[]` and `prices?: Record<string, JpLivePriceDto>`.
- **Row head:**
  - dot, code, name
  - `Basic data` tag (title: "Only Yahoo and EDINET data is available for this stock: no SEC results or option data")
  - `formatJpPrice` + change + `<span className="delayed">Delayed ~20 min</span>`
  - timing
- **Details** (built from `foreignParts`):
  - Stock: `code name · TSE`, the Japanese name muted, and for the full level `· ADR TM (1 ADS = 10 shares)`. Fractional ratios print as is: `(1 ADS = 0.2 shares)`.
  - Result date: "confirmed by SEC 6-K notice" / "estimated".
  - Period.
  - Release:
    - Released, full level: `Filed with SEC by {time} JST · the 6-K arrives 3.5–6 h after the Tokyo release` and an `SEC 6-K` link.
    - Unreleased, full level: muted `SEC 6-K usually arrives 3.5–6 h after the Tokyo release`.
  - Sector: Yahoo sector, else `industryJa`.
  - Market cap: `formatJpMoney(cap, 'JPY')` as of date.
  - EPS estimate / actual: `CurrencyFigure`, with:
    - `spanLabel = actualSpan === 'ytd' ? ytdLabel(ytdMonths) : null`
    - source `Yahoo` / `EDINET`
    - `* different currency, basis or span from the estimate: not compared` when both numbers exist and `result == null`
    - `· diluted ¥x` when `epsDiluted != null`
  - Revenue: the same rules.
  - When either figure is from EDINET: muted `Source: EDINET (Financial Services Agency), edited`.
  - Expected move, live move, previous move: from the parts.
  - Price: `¥x · delayed ~20 min (Yahoo), {time}`.
  - NoteEditor.

- [ ] **Step 1: Write failing tests.**
  - `JpPlumbing.test.tsx`:
    - `'Japan button switches market, PUTs prefs and requests /api/jp/earnings'`
    - `'stored JP market is restored'`
  - `useLiveResults.test.tsx`: `'jp-results and jp-prices reach the jp group'`
  - `JpStockList.test.tsx`:
    - `'basic rows show Basic data; price shows Delayed ~20 min'`
    - `'YTD (9 months) label and no colour for a YTD actual vs a quarter estimate'` (Review Focus 2)
    - `'EDINET actual shows from EDINET and the credit line'`
    - `'ADR ratio 0.2 prints as 1 ADS = 0.2 shares'`
    - `'unreleased full-level row shows the 3.5–6 h note'`
    - `'expanded key is JP:<code>'`
  - `MarketBar.test.tsx`: `'JP strip shows Nikkei 225 and TOPIX (ETF 1306) with delayed label'`
  - `StatusPage.test.tsx`: `'Japan coverage table renders'`
  - `AdminPage.test.tsx`: `'Japan panel shows EDINET key not configured and reader off'`
- [ ] **Step 2: Run** them in `web/`. Expected: FAIL.
- [ ] **Step 3: Implement** the modifications listed under Files.
- [ ] **Step 4: Run** `npm test` and `npx tsc --noEmit` in `web/`. Expected: PASS, with the HK and India web tests unchanged.
- [ ] **Step 5: Commit** `feat(web): Japan market, list with YTD labels and EDINET source, Nikkei/TOPIX strip, status and admin`.

### Task 15: Live spot-check and full verification  [Group E]

**Depends on:** all tasks.

**Files:**
- Create: `server/src/cli/jpSpotCheck.ts`
- Modify: `server/package.json` (`"jp-spot-check": "tsx src/cli/jpSpotCheck.ts"`)

**Interfaces:**
- `jpSpotCheck.ts --db <copy.db> [--codes 7203,6758,8306,4502,7267,9984,6861,9983,8035,3382]`
  - It requires `--db` and refuses `config.dbPath`.
  - It runs `warmUpJp` once against the copy with a real `JpJobContext`: one `createYahooClient()`, a 120 ms SEC client, Cboe at 2500 ms, and EDINET only when the key is set. Nothing else runs: no prices, no watchers, no Kite.
  - Then, per code, it prints:
    - level, ADR, period label, report date + status, timing + source
    - estimates + span, actuals + source/span/ytdMonths, diluted EPS
    - market cap ¥
    - expected move
    - previous move
    - the latest SEC 6-K index URL (full level) and EDINET docID
    - EDINET key configured yes/no (never the value)

- [ ] **Step 1: Copy the database** to the scratchpad: `copy data\earnings.db %TEMP%\jp-check.db`. The production server keeps running untouched.
- [ ] **Step 2: Run** `npm run jp-spot-check -w server -- --db %TEMP%\jp-check.db` with `SEC_USER_AGENT` (and `EDINET_API_KEY` if available) set.
- [ ] **Step 3: Compare by hand.** Check 5 full-level codes (7203, 6758, 8306, 4502, 7267) and 5 basic codes (9984, 6861, 9983 Aug FY, 8035, 3382 Feb FY) against:
  - EDGAR filings (full level)
  - Yahoo Finance quote pages for `.T`
  - the Cboe delayed-quotes page for the ADR
  - the EDINET viewer for half-year / annual figures

  Never open jpx.co.jp or TDnet. Record each field as match / blank / wrong in the commit body. Any **wrong** value is a bug: fix it test-first in the owning task's module. A blank is acceptable only where the spec or a Ruling says blank.
- [ ] **Step 4: EDINET live check.**
  - If Task 4 shipped with `LIVE API CHECK PENDING` and a key is now available: run `docList` for a recent 有報/半期 filing date through the spot-check, and confirm the field names, the ZIP layout and that the parsed values equal the corpus values for the same document.
  - Without a key, leave the line `EDINET live check: pending key` in the commit body.
- [ ] **Step 5: Run the full verification.**
  - In `server/`: `npm test` and `npx tsc --noEmit`.
  - In `web/`: `npm test` and `npx tsc --noEmit`.
  - Then `npm run coverage-check -w server -- --db %TEMP%\jp-check.db`.
  - Then `npm run reader-corpus -w server -- --hk`; its output must still equal the Task 3 snapshot.

  Expected: all tests pass (805+ server, 139+ web), no type errors, and JP coverage rows printed.
- [ ] **Step 6: Commit** `chore(jp): live spot-check script and results`. The body has the spot-check table and the EDINET status.
