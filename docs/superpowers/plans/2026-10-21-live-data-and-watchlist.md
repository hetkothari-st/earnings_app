# Live Data and Watchlist Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Results flip to "Results out" within seconds (with preliminary numbers) for US and India. Every data type gets the fastest free source plus an automatic backup. Each user gets a watchlist per market. Prices are live for everything on screen.

**Architecture:**
- A shared failover helper (`sources/failover.ts`) wraps every fast source. It detects blocks, backs off, records state, and hands over to the backup.
- **Fast results:**
  - US: an SEC 8-K feed poller (`live/secWatch.ts`).
  - India: an NSE announcements poller (`india/live/nseWatch.ts`).
  - Both write a release time plus **preliminary** values. The existing official merges later confirm or correct them.
- **Watchlists:** a new `watchlists` table and `/api/watchlist` routes. Symbol search is backed by the SEC ticker list (US) and the Kite NSE instrument list (India).
- **Live prices:** US price slots are driven by what each browser reports as visible. India streams the whole F&O + watched universe, including option ticks for the live expected move.

**Tech Stack:** Node 24, TypeScript (NodeNext, strict), Fastify 5, node:sqlite, zod 4, luxon, node-cron, Vitest. React 19 + Vite + Testing Library. New dependency: `pdfjs-dist` (PDF text for India results), server only.

**Spec:** `docs/superpowers/specs/2026-10-21-live-data-and-watchlist-design.md` (read it first; it builds on `2026-10-15-earnings-calendar-design.md` and `2026-10-15-india-earnings-design.md`).

## Global Constraints

- **Free sources only.** Never use nseindia.com pages or its `/api/`, anything from bseindia.com, or MarketChameleon. The Investing.com scraper stays opt-in (`INVESTING_SCRAPER=1`).
- **SEC:** at most 10 requests/s in total across the app. User-Agent from `SEC_USER_AGENT` (never hard-code a personal email).
- **Finnhub free:** stream ≤ 50 symbols per connection; REST ≤ 60 calls/min. **Kite ticker:** ≤ 3,000 instruments per connection.
- **Fast values are labelled.** Fast numbers are stored and shown as **preliminary** until an official figure confirms them.
  - Matching rule: EPS within 0.01; revenue or profit within 0.5%. Inside that → confirmed (tag cleared). Outside → official replaces it and the field shows **corrected**.
- **Colours.** Preliminary values drive beat/miss colour and surprise % straight away. Exception: US EPS found only as GAAP is labelled "GAAP" and gets **no** colour.
- **US EPS for the fast reader** = adjusted (non-GAAP) EPS when clearly labelled. India EPS = basic EPS, consolidated preferred.
- **Uncertain means blank.** A value the reader is not sure of is not stored: the field stays "—". Never store year-to-date or annual columns. Never overwrite a stored value with a blank.
- **Reader gate.** A fast-reader field is live only if its corpus match rate is ≥ 95% of accepted values. Gate flags live in `server/src/config.ts` (`fastFields`). The "Results out" flip ships regardless.
- **Live market cap** only for rows with `reportDate >= today`. Past US rows keep market cap frozen after the report date.
- **Share counts:** US from SEC company facts `dei:EntityCommonStockSharesOutstanding`; India from Yahoo `defaultKeyStatistics.sharesOutstanding`. Refreshed daily.
- **Style:** dark theme, Archivo, dots not stripes, no all-caps labels.
- **TDD:** red → green. Before every commit run `npm test`, `npx tsc --noEmit -p server` and `npm run build -w web`. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Imports:** server imports use `.js` extensions. Web imports server types from `../../server/src/...` (type-only modules).

## Review Focus

1. **The same release seen twice** (feed re-lists it, an 8-K/A amendment, a PDF re-upload): one flip; the earliest time wins; preliminary values are not replaced by a later fast read. Owned by Tasks 3 and 6.
2. **A release on a day the calendar did not expect** (filed one day before or after the calendar date):
   - The nearest unreleased report within ±3 calendar days flips.
   - Its date moves to the filing date, with `rescheduled_from` set.
   - Outside ±3 days: nothing flips; the item is logged.
   - Owned by Tasks 3 and 6.
3. **Tables with several columns** (quarter, prior-year quarter, nine months / year to date): only the current-quarter column is read. Owned by Tasks 4 and 7.
4. **Units stated once in the table header** ("in thousands", "in millions", "₹ in crore", "₹ in lakhs"): values are scaled. If no unit is found, revenue/profit stay blank. Owned by Tasks 4 and 7.
5. **A block disguised as success** (HTTP 200 with an HTML "Request Rate Threshold Exceeded" or challenge page): treated as blocked, failover engaged, nothing parsed or stored. Owned by Task 1.

---

## File map

**Server: create**
- `src/sources/failover.ts`
- `src/sources/secFeed.ts` (8-K atom feed + filing index)
- `src/sources/releaseReader.ts` (US press-release HTML → values)
- `src/live/secWatch.ts`
- `src/db/prelim.ts` (preliminary columns + confirm/correct, US)
- `src/watchlist/store.ts`, `src/watchlist/routes.ts`, `src/watchlist/search.ts`
- `src/jobs/shares.ts`
- `src/jobs/coverage.ts`
- `src/cli/coverageCheck.ts`, `src/cli/readerCorpus.ts`
- `src/india/sources/resultsPdf.ts` (PDF text → values)
- `src/india/live/nseWatch.ts`
- `src/india/sources/yahooPastDates.ts`

**Server: modify**
- `src/db/repo.ts`, `src/api/types.ts`, `src/api/dto.ts`, `src/api/server.ts`, `src/jobs/scheduler.ts`, `src/live/livePrices.ts`, `src/config.ts`, `src/index.ts`
- `src/india/db/inRepo.ts`, `src/india/db/schema.ts`, `src/india/api/types.ts`, `src/india/api/dto.ts`, `src/india/jobs/scheduler.ts`, `src/india/jobs/stocks.ts`, `src/india/jobs/prevMoves.ts`, `src/india/live/inPrices.ts`, `src/india/sources/kiteStream.ts`, `src/india/sources/yahooIn.ts`

**Web: create**
- `src/hooks/useWatchlist.ts`, `src/hooks/useVisibleSymbols.ts`
- `src/components/WatchlistView.tsx`, `src/components/SymbolSearch.tsx`, `src/components/Tags.tsx`

**Web: modify**
- `src/api.ts`, `src/components/Calendar.tsx`, `StockList.tsx`, `InStockList.tsx`, `Header.tsx`, `StatusPage.tsx`, `src/styles.css`

**Fixtures** (save real samples; never invent them)
- `server/test/fixtures/us/` (SEC atom feed, filing indexes, ≥ 30 press releases)
- `server/test/fixtures/india/pdf/` (≥ 30 results PDFs)

A verified live sample of the SEC feed is at `C:\Users\ST269\AppData\Local\Temp\claude\C--Users-ST269-Desktop-earnings-app\da9b8b78-232f-4c85-b041-7b012837dc84\scratchpad\sec_getcurrent_8k.xml`. Copy it to `server/test/fixtures/us/sec_getcurrent_8k.xml`.

**Source facts (verified 2026-10-21)**
- SEC current 8-K feed: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=8-K&company=&dateb=&owner=include&start=0&count=100&output=atom`.
- Each `<entry>` has:
  - `<title>8-K - UDR, Inc. (0000074208) (Filer)</title>` (CIK in parentheses)
  - `<link href=".../Archives/edgar/data/74208/000007420826000081/0000074208-26-000081-index.htm"/>`
  - `<summary>` HTML-escaped, with `Filed:`, `AccNo:` and lines `Item 2.02: Results of Operations and Financial Condition`
  - `<updated>2026-10-21T08:05:10-04:00</updated>` (acceptance time, ET offset)
- Earnings releases are entries whose summary lists **Item 2.02**. The press release is the filing's EX-99.1 document, linked from the `-index.htm` page.

---

## Stage A — Results within seconds

### Task 1: Failover helper and source state

**Files:**
- Create: `server/src/sources/failover.ts`
- Modify: `server/src/db/repo.ts` (`source_status` gains `state TEXT`, `blocked_until TEXT`; `listSourceStatus` returns them)
- Modify: `server/src/api/types.ts` (`SourceStatusDto` adds `state: 'ok' | 'failing' | 'blocked' | 'backup' | null`, `blockedUntil: string | null`)
- Test: `server/test/sources/failover.test.ts`

**Interfaces:**
- Produces:
  - `class BlockedError extends Error { constructor(source: string, reason: string) }`
  - `looksBlocked(status: number, body: string): boolean`: true for 403/429, or for a 200 body containing `Request Rate Threshold Exceeded`, `Access Denied`, `cf-challenge`, `Just a moment...`, or `<html` when JSON/XML was expected (callers pass `expectHtml`).
  - `createFailover(db: Db, now: () => number): <T>(fast: { name: string; run: () => Promise<T> }, backup: { name: string; run: () => Promise<T> } | null) => Promise<{ value: T; via: 'fast' | 'backup' } | null>`.
    - Fast is skipped while `blocked_until > now`.
    - A `BlockedError` sets `blocked_until` with backoff 1, 2, 5, 15, 30 min (capped at 30).
    - Any other error counts as failing; three in a row also back off at 1 min.
    - On fast success: state `ok`, and the backoff resets. When the backup is used: state `backup` on the fast source's row.
    - Never throws; both failing → `null`.

- [ ] **Step 1: Write failing tests** `failover.test.ts`:
  - `'fast success returns via fast and records ok'`
  - `'a BlockedError skips fast for 1 minute, then 2, then 5'` (fake clock)
  - `'backup is used while fast is blocked and state is backup'`
  - `'a 200 HTML "Request Rate Threshold Exceeded" body counts as blocked'`: `looksBlocked(200, '<html>Request Rate Threshold Exceeded</html>')` is `true`
  - `'both failing returns null and never throws'`
- [ ] **Step 2: Run** `npx vitest run test/sources/failover.test.ts -w server`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** the interfaces above. Add the two columns with the existing `addMissingColumns` mechanism.
- [ ] **Step 4: Run** the test, then the full suite. Expected: PASS.
- [ ] **Step 5: Commit** `feat: failover helper with block detection and backoff`.

### Task 2: SEC 8-K feed and filing index parsers

**Files:**
- Create: `server/src/sources/secFeed.ts`
- Test: `server/test/sources/secFeed.test.ts`
- Fixtures:
  - `server/test/fixtures/us/sec_getcurrent_8k.xml` (copy the scratchpad sample)
  - Two real `-index.htm` pages from that feed, one with EX-99.1: fetch them with the app's `SEC_USER_AGENT`.

**Interfaces:**
- Produces:
  - `interface SecFeedItem { cik: number; accession: string; acceptedAt: string /* ISO UTC */; items: string[] /* e.g. ['2.02','7.01','9.01'] */; indexUrl: string; form: string /* '8-K' | '8-K/A' */ }`
  - `parseSecFeed(xml: string): SecFeedItem[]`. Throws `SourceFormatError` if there is no `<feed`.
  - `parseFilingIndex(html: string, indexUrl: string): { exhibit991Url: string | null }`. Takes the row whose Type is `EX-99.1` (else the first `EX-99*`), as an absolute URL.
  - `fetchSecFeed(http: Http): Promise<SecFeedItem[]>`, using `count=100`.

- [ ] **Step 1: Write failing tests:**
  - `'UDR entry: cik 74208, accession 0000074208-26-000081, items include 2.02, acceptedAt 2026-10-21T12:05:10.000Z'`
  - `'entries without 2.02 still parse (Zedge has 7.01, 9.01 only)'`
  - `'an HTML page instead of atom throws SourceFormatError'`
  - `'index page yields the EX-99.1 absolute URL'`
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** with regex/string parsing, in the style of `india/sources/nseRss.ts`. Decode HTML entities in `<summary>` before reading the `Item x.xx` lines.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: SEC current 8-K feed and filing index parsers`.

### Task 3: US release flip (`secWatch`)

**Files:**
- Create: `server/src/live/secWatch.ts`
- Modify: `server/src/db/repo.ts`:
  - `reports` gains `released_at TEXT` and `release_source TEXT`.
  - Add `reportForRelease(db, symbolKey: string, date: string): { id: number; reportDate: string; releasedAt: string | null } | null`. It returns the nearest report within ±3 calendar days of `date` that is not yet released, preferring the same day.
  - Add `markReleased(db, id: number, releasedAt: string, source: 'sec-8k'): boolean`. Earliest time wins. If the report date differs from the ET date of `releasedAt`, set `report_date` to that date and `rescheduled_from` to the old one. Derive timing from ET time using the existing `sessionClose`: before 09:30 → BMO, after close → AMC, else DMH; then `timing_source='sec'`. Returns true if anything changed.
- Modify: `server/src/api/types.ts` + `server/src/api/dto.ts` (`ReportDto` adds `releasedAt: string | null`)
- Test: `server/test/live/secWatch.test.ts`

**Interfaces:**
- Consumes:
  - `fetchSecFeed`, `parseFilingIndex` (Task 2)
  - `createFailover` (Task 1)
  - the CIK → ticker map from `ctx.sources.secTickers()` (existing), cached for the day
- Produces:
  - `class SecWatch { constructor(ctx: JobContext, http: Http, onReleased: (ids: number[]) => void, reader?: (exhibitUrl: string, reportId: number) => Promise<void>) ; start(intervalMs = 5000): void ; stop(): void ; tick(): Promise<number[]> }`
  - Each tick:
    - Fetch the feed.
    - Skip accessions already seen (in-memory set of ≤ 5,000).
    - For each `2.02` item whose CIK maps to a ticker with a report, call `markReleased`.
    - Then, if a reader is given, fetch the index and call the reader with the EX-99.1 URL, without blocking the next tick.
    - Publish the changed ids at once.

- [ ] **Step 1: Write failing tests** (fake Http serving the fixture; DB with a UDR report on 2026-10-21):
  - `'a 2.02 filing flips the report: releasedAt set, timing BMO (08:05 ET), ids returned'`
  - `'the same accession on the next tick changes nothing'`
  - `'an 8-K/A for an already released report keeps the earlier time'`
  - `'filed one day after the calendar date: report_date moves, rescheduled_from set'`
  - `'no report within ±3 days: nothing changes'`
  - `'feed blocked (429): tick returns [] and the source state is blocked'`
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Drive the poll with `setInterval` (not node-cron: sub-minute).
  - Respect the global SEC limit: share one `makeHttp({ minIntervalMs: 120 })` for all SEC calls.
  - In `index.ts`: start it with `intervalMs = 5000`, and publish `results` events.
- [ ] **Step 4: Run.** Expected: PASS. Then run the full suite.
- [ ] **Step 5: Commit** `feat: flip US reports to released within seconds from SEC 8-K feed`.

### Task 4: US press-release reader and corpus harness

**Files:**
- Create: `server/src/sources/releaseReader.ts`
- Create: `server/src/cli/readerCorpus.ts` (script: `npm run reader-corpus -w server`)
- Fixtures: `server/test/fixtures/us/releases/*.htm`
  - At least 30 real EX-99.1 releases from varied sectors, including banks, REITs (FFO), and companies with only GAAP.
  - Plus `expected.json` mapping each file to `{ symbol, quarterEnd, epsAdjusted, epsGaap, revenue }`. Take the expected values from Nasdaq/Finnhub, or by hand from the release; note the source per row.
- Test: `server/test/sources/releaseReader.test.ts`

**Interfaces:**
- Produces:
  - `interface ReleaseValues { epsAdjusted: number | null; epsGaap: number | null; revenue: number | null; unit: number | null /* multiplier applied */; notes: string[] }`
  - `readUsRelease(html: string, quarterEnd: string): ReleaseValues`

**Rules** (a value is set only when all of its rules hold):
- **Adjusted EPS:**
  - The row label matches `/(adjusted|non-gaap|core)\b.*\b(diluted )?(eps|earnings per (diluted )?share)/i`.
  - The column header names the quarter ending `quarterEnd` (e.g. "Three Months Ended September 30, 2026", "Q3 2026"). Never "Nine/Six/Twelve Months" or "Year".
- **GAAP EPS:** row `/diluted (net )?(income|earnings) per share|diluted eps/i` without the adjusted words, same column rule.
- **Revenue:** the row label is one of "Total revenues", "Revenues", "Net revenues", "Total net revenue", "Net sales", "Total net sales". Scaled by the table's unit ("in thousands" ×1e3, "in millions" ×1e6, "in billions" ×1e9). With no unit stated → `null`.
- **Negatives:** "(0.15)" → −0.15.
- **Disagreement:** if two candidates disagree → `null`, with a note.

**Corpus harness:**
- `readerCorpus.ts` prints, per field: accepted count, match count against `expected.json` (EPS ±0.01; revenue ±0.5%), match rate.
- It writes `server/test/fixtures/us/releases/report.json`.

- [ ] **Step 1: Write failing tests** on 4 hand-picked corpus files:
  - `'adjusted EPS from the reconciliation, not GAAP'`
  - `'quarter column only when a nine-months column exists'`
  - `'revenue in millions is scaled'`
  - `'GAAP-only release: epsAdjusted null, epsGaap set'`
  - Plus one corpus test: `'every accepted value in the corpus matches expected.json'` (iterate all files). This pins "uncertain means blank".
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Convert HTML tables to rows of cell text (strip tags, decode entities, collapse whitespace). Find header rows with period labels; pick the column whose header matches the quarter.
- [ ] **Step 4: Run** the tests and `npm run reader-corpus -w server`.
  - Expected: tests PASS. The report shows each field's match rate.
  - Set `config.fastFields.usEps` / `usRevenue` to `true` only for fields ≥ 95%. Record the rates in the commit message.
- [ ] **Step 5: Commit** `feat: US press-release reader with corpus (eps adj X%, revenue Y%)`.

### Task 5: US preliminary values, confirm/correct, DTO and tags

**Files:**
- Create: `server/src/db/prelim.ts`
- Modify:
  - `server/src/db/repo.ts`: `reports` gains `eps_prelim REAL, eps_prelim_basis TEXT ('adjusted'|'gaap'), revenue_prelim REAL, prelim_at TEXT, eps_corrected INTEGER, revenue_corrected INTEGER`.
  - `mergeFinnhubRow`, `upsertCalendarRow` (Nasdaq actual), `mergeInvestingRow`, `mergeYahooFill`: call `confirmPrelim` after writing an official actual.
- Modify: `server/src/live/secWatch.ts`: the reader callback stores prelim values.
- Modify: `server/src/api/types.ts`, `server/src/api/dto.ts`
- Modify: `web/src/components/StockList.tsx`; create `web/src/components/Tags.tsx`
- Test: `server/test/db/prelim.test.ts`, `web/test/StockList.test.tsx` (add cases)

**Interfaces:**
- Produces (`prelim.ts`):
  - `savePrelim(db, id, v: { epsAdjusted: number | null; epsGaap: number | null; revenue: number | null }, at: string): boolean`
    - Writes only fields allowed by `config.fastFields`.
    - Never overwrites an existing prelim or official actual.
    - Basis is `adjusted` if `epsAdjusted` is set, else `gaap`.
  - `confirmPrelim(db, id): void`
    - Compares the official vs prelim: EPS ±0.01; revenue ±0.5%.
    - Equal → clear prelim. Different → set `*_corrected = 1`, then clear prelim.
- `ReportDto` changes:
  - `eps` adds `preliminary: boolean`, `corrected: boolean`, `basis: 'adjusted' | 'gaap' | null`.
  - `revenue` adds `preliminary: boolean`, `corrected: boolean`.
- DTO rule:
  - With no official actual and a prelim present: `actual = prelim`, `preliminary = true`.
  - EPS with basis `gaap`: `result = null`, `surprisePct = null`.
  - Otherwise beat/miss is computed as usual.
- Web: `<Tags preliminary corrected basis />` renders the small text tags "preliminary", "corrected", "GAAP" (muted, no colour fill) after the value.

- [ ] **Step 1: Write failing tests:**
  - `'prelim adjusted EPS shows as actual with preliminary true and beat colour'`
  - `'GAAP-only prelim: result null'`
  - `'official equal within 0.01 clears the tag, corrected false'`
  - `'official differs: official shown, corrected true'`
  - `'a second fast read never replaces the first prelim'`
  - `'official already present: prelim is not stored'`
  - Web: `'preliminary and corrected tags render next to EPS'`
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the full suite, typecheck and build. Expected: PASS.
- [ ] **Step 5: Commit** `feat: preliminary US results with confirm/correct`.

### Task 6: India release flip within seconds (`nseWatch`)

**Files:**
- Create: `server/src/india/live/nseWatch.ts`
- Modify: `server/src/india/jobs/results.ts`: move the announcement handling into a function `handleAnnouncements(ctx, items): number[]` that both use.
- Test: `server/test/india/nseWatch.test.ts`

**Interfaces:**
- Consumes:
  - `fetchNseRss(http, 'Online_announcements')`
  - `recordRelease`, `reportOnDate` (inRepo)
  - `createFailover` (Task 1)
  - `getFoCache()`: it must include watched symbols after Task 9; until then F&O only
- Produces: `class NseWatch { constructor(ctx: InJobContext, onReleased: (ids: number[]) => void, reader?: (pdfUrl: string, reportId: number) => Promise<void>); start(intervalMs = 5000): void; stop(): void; tick(): Promise<number[]> }`.
  - Unknown report (an F&O stock whose notice we never saw): create one with `upsertInCalendarRow` (quarter = `latestQuarterEndBefore(day)`), then `recordRelease`.
  - `item.link` ending `.pdf` is the reader input.
- Note: keep the existing 1-minute `india-results` job as the backup path (XBRL).

- [ ] **Step 1: Write failing tests** (fixture `rss_Online_announcements.xml` plus an inline item):
  - `'a results announcement flips within one tick, ids returned'`
  - `'same item next tick: no change'`
  - `'an F&O stock with no calendar row gets a row and flips'`
  - `'HTML instead of RSS: [] and state recorded'`
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Use a dedicated `makeHttp({ minIntervalMs: 1000 })` for nsearchives polling. Wire it in `index.ts` to publish `in-results`.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: flip India reports within seconds from NSE announcements`.

### Task 7: India results-PDF reader, preliminary values, corpus

**Files:**
- Create: `server/src/india/sources/resultsPdf.ts`
- Modify:
  - `server/src/india/db/schema.ts`, `IN_ADDED_COLUMNS`: add `eps_prelim REAL, revenue_prelim REAL, pnl_prelim REAL, prelim_basis TEXT, prelim_at TEXT, eps_corrected INTEGER, revenue_corrected INTEGER, pnl_corrected INTEGER`.
  - `inRepo.ts`: `saveInPrelim`, `confirmInPrelim`. `mergeInFiling` calls `confirmInPrelim`.
  - `server/src/india/api/types.ts` + `dto.ts`: `eps`/`revenue`/`profit` add `preliminary`, `corrected`.
  - `web/src/components/InStockList.tsx`: tags.
- Add `pdfjs-dist` to `server/package.json`, pinned to an exact version at least two weeks old.
- Fixtures: `server/test/fixtures/india/pdf/*.pdf`
  - At least 30 real results PDFs linked from NSE announcements, including 3 banks and 2 NBFCs. The existing `CMTR*.pdf`/`FAOP*.pdf` fixtures are not results PDFs; check before using.
  - Plus `expected.json` from the matching XBRL (`parseIntegratedFiling`).
- Create: `server/src/cli/readerCorpus.ts` gains `--india`.
- Test: `server/test/india/resultsPdf.test.ts`

**Interfaces:**
- Produces:
  - `readInResultsPdf(bytes: Uint8Array, quarterEnd: string): Promise<{ basis: 'Consolidated' | 'Standalone' | null; eps: number | null; revenue: number | null; revenueKind: 'revenue-from-ops' | 'total-income' | null; profit: number | null; notes: string[] }>`
- **Rules:**
  - Use the "Consolidated" statement if present, else "Standalone".
  - Use the column "Quarter ended <quarterEnd as 30.09.2026 / 30-Sep-2026 / September 30, 2026>". Never "Half year" / "Year ended" / "Nine months".
  - Rows:
    - "Revenue from operations" (banks: "Total income")
    - "Net profit / (loss) for the period" (also "Profit for the period")
    - "Basic" EPS
  - Units from "(₹ in crore)", "(Rs. in lakhs)", "(₹ in million)", "(₹ in thousands)": crore 1e7, lakh 1e5, million 1e6, thousand 1e3. Store full rupees. With no unit → revenue and profit `null` (EPS needs no unit).
  - A PDF with no text layer → all `null`, with note `'no text layer'`.
- `saveInPrelim(db, id, v, at): boolean` and `confirmInPrelim(db, id): void`: same semantics as Task 5. The gates are `config.fastFields.inEps` / `inRevenue` / `inProfit`.

- [ ] **Step 1: Write failing tests:**
  - `'consolidated quarter column, ₹ crore scaled to rupees'`
  - `'bank PDF: total income'`
  - `'half-year column never read'`
  - `'scanned PDF: all null'`
  - `'every accepted corpus value matches expected.json'`
  - `'XBRL equal clears prelim; differs sets corrected'`
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Extract text with pdfjs `getTextContent`, grouping items into lines by y-coordinate, then into columns by x-coordinate. Hook the reader into `NseWatch`.
- [ ] **Step 4: Run** the tests and `npm run reader-corpus -w server -- --india`. Set the gates to `true` only for fields ≥ 95%. Run the full suite and build.
- [ ] **Step 5: Commit** `feat: India results-PDF reader with preliminary values (eps X%, revenue Y%, profit Z%)`.

## Stage B — Watchlist

### Task 8: Watchlist store, routes and symbol search

**Files:**
- Create: `server/src/watchlist/store.ts`, `server/src/watchlist/search.ts`, `server/src/watchlist/routes.ts`
- Modify: `server/src/api/server.ts` (register), `server/src/api/types.ts` (DTOs)
- Test: `server/test/watchlist/watchlist.test.ts`

**Interfaces:**
- Table: `watchlists (user_id TEXT, market TEXT CHECK (market IN ('US','IN')), symbol TEXT, added_at TEXT, PRIMARY KEY (user_id, market, symbol))`. Limit 200 symbols per user per market.
- Store: `listWatch(db, user, market): string[]`, `addWatch(db, user, market, symbol, now): void`, `removeWatch(db, user, market, symbol): void`, `allWatched(db, market): string[]` (union across users).
- Search:
  - `searchSymbols(market: 'US' | 'IN', q: string, limit = 20): { symbol: string; name: string; exchange: string }[]`. Ranking: exact symbol, then symbol prefix, then name word prefix.
  - US index from `ctx.sources.secTickers()` (refreshed daily). IN index from Kite NSE EQ instruments (`fetchKiteInstruments(http, 'NSE')`, EQ segment `NSE`), refreshed daily. Both held in memory.
- Routes (signed in):
  - `GET /api/symbols?market=US|IN&q=` → `{ results }`
  - `GET /api/watchlist?market=` → `{ symbols: string[] }`
  - `PUT /api/watchlist/:market/:symbol` → 204. 400 if the symbol is not in that market's index. 409 when over 200.
  - `DELETE /api/watchlist/:market/:symbol` → 204.

- [ ] **Step 1: Write failing tests:**
  - `'add, list, remove per user and per market'`
  - `'unknown symbol 400; 201st symbol 409; no session 401'`
  - `'search: "REL" ranks RELIANCE first; "infosys" finds INFY by name'`
  - `'US and IN lists are separate'`
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: per-user watchlists and symbol search`.

### Task 9: Watched stocks flow through the data jobs

**Files:**
- Modify:
  - `server/src/india/jobs/stocks.ts`: `loadFoCache` symbols = F&O ∪ `allWatched(db,'IN')`; names from Kite instruments for non-F&O.
  - `server/src/india/db/inRepo.ts`: add `in_stocks.watched INTEGER DEFAULT 0` and `syncWatched(db, symbols)`. Calendar listing keeps `active = 1`. Add `listInForSymbols(db, symbols, from, to)` with no active filter.
  - `server/src/db/repo.ts`: add `listForSymbols(db, symbolKeys, from, to)`.
  - `server/src/watchlist/routes.ts`: `GET /api/watchlist/rows?market=` returns, per watched symbol, `{ symbol, name, next: ReportDto | InReportDto | null, latest: ReportDto | InReportDto | null }`.
- Create: `server/src/jobs/watchBackfill.ts` (US only). On add, fetch past results once.
  - Source: Nasdaq `https://api.nasdaq.com/api/company/{SYMBOL}/earnings-surprise`. **Verify the response shape live first and save a fixture.** If it differs or fails, use the existing Yahoo summary (`epsHistory`) as backup via `createFailover`.
  - Store as `reports` rows with `eps_actual_source` `'nasdaq'` / `'yahoo'`.
- Test: `server/test/watchlist/watchRows.test.ts`

**Interfaces:**
- Consumes: `allWatched` (Task 8).
- Produces:
  - `GET /api/watchlist/rows` response type `WatchRowsResponse` in `server/src/api/types.ts`.
  - `onWatchAdded(market, symbol)` hook called from `PUT /api/watchlist`. It triggers the US backfill and India `loadFoCache`.

- [ ] **Step 1: Write failing tests:**
  - `'a watched non-F&O NSE stock is matched by the results job but not listed in the calendar'`
  - `'rows: next and latest reports per watched symbol; none → nulls'`
  - `'US add triggers one backfill; failure falls back to Yahoo'`
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: watched stocks get results, dates and history`.

### Task 10: Watchlist UI

**Files:**
- Create: `web/src/hooks/useWatchlist.ts`, `web/src/components/SymbolSearch.tsx`, `web/src/components/WatchlistView.tsx`
- Modify:
  - `web/src/components/Header.tsx`: a "Watchlist" toggle next to the view tabs.
  - `web/src/components/Calendar.tsx`: render `WatchlistView` when the toggle is on.
  - `web/src/components/StockList.tsx`, `InStockList.tsx`: a star button on each row to add or remove (aria-label "Add RELIANCE to watchlist" / "Remove …"), and a filled star marker when watched.
  - `web/src/api.ts`, `web/src/styles.css`.
- Test: `web/test/Watchlist.test.tsx`

**Interfaces:**
- Consumes: the routes from Tasks 8–9.
- Produces:
  - `useWatchlist(market): { symbols: Set<string>; add(s): Promise<void>; remove(s): Promise<void> }` (optimistic, rolled back on error)
  - `<SymbolSearch market onPick />`: debounced 200 ms, keyboard navigable listbox
  - `<WatchlistView market zone prices />`: one row per watched stock showing live price, next result date (or "—"), expected move, and latest results with the preliminary/corrected tags. Reloads on `results`/`in-results` events.

- [ ] **Step 1: Write failing tests:**
  - `'search then pick adds to the list'`
  - `'star toggles and survives reload (server list)'`
  - `'watchlist view shows next date and live price; missing next date shows —'`
  - `'India and US lists are separate'`
- [ ] **Step 2: Run** `npm test -w web`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests and the build. Expected: PASS.
- [ ] **Step 5: Commit** `feat: watchlist UI with search and star`.

## Stage C — Everything else as fast as possible

### Task 11: US price slots follow what users see

**Files:**
- Create: `web/src/hooks/useVisibleSymbols.ts`. An IntersectionObserver over `[data-symbol]` rows sends `PUT /api/live/visible { market:'US', symbols }`, debounced 500 ms, at most 100 symbols.
- Modify:
  - `server/src/live/livePrices.ts`: symbols = watchlist ∪ visible (from all sessions active in the last 2 min) ∪ today's reporters, in that priority.
    - The first 50 go on the stream.
    - The rest are polled through Finnhub `/quote`, sharing the 60/min budget, round-robin.
    - Yahoo chart quote is the backup (via `createFailover`).
    - Re-pick symbols every 5 s, not every 5 min.
  - `server/src/api/server.ts`: `PUT /api/live/visible`, an in-memory map per session id.
  - `StockList.tsx`: rows get `data-symbol`.
  - `LivePrice` gains `source: 'stream' | 'poll' | 'backup'`.
- Test: `server/test/live/livePrices.test.ts` (new), `web/test/useVisibleSymbols.test.tsx`

**Interfaces:**
- Produces:
  - `pickSlots(watch: string[], visible: string[], reporters: string[], max = 50): { stream: string[]; poll: string[] }` (pure, exported)
  - `/api/prices` entries include `source`.

- [ ] **Step 1: Write failing tests:**
  - `'pickSlots: watch first, then visible, then reporters; dedup; 50 cap; rest polled'`
  - `'stream failure: polled and Yahoo backup fill, source backup'`
  - `'visible symbols expire after 2 min'`
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: US live prices follow the screen and watchlists`.

### Task 12: India: stream every needed stock and live option prices

**Files:**
- Modify:
  - `server/src/india/sources/kiteStream.ts`: support `full` mode for option tokens. Parse depth: in a 184-byte packet, best bid price at offset 68 and best ask at offset 128 (paise).
    - Field layout per the Kite docs in `server/test/fixtures/india/kite_websocket.txt`: depth starts at 64. Each of 10 entries is 12 bytes (int32 quantity, int32 price, int16 orders, 2 bytes padding): buy ×5, then sell ×5.
    - **Verify the offsets against that document before coding.**
  - `server/src/india/live/inPrices.ts`:
    - Equities: all active F&O ∪ watched. Indices as today.
    - Options: CE/PE at the 6 nearest strikes for unreleased reports today and next session.
    - On option ticks, recompute the straddle with `computeInExpectedMove`. Save the live move at most every 5 s per report, and publish `in-moves`.
    - Yahoo backup for equities with no tick for 2 min during the session.
  - `server/src/india/jobs/moves.ts`: the 1-minute `refreshInLiveMoves` stays as backup; it skips reports whose live move was saved within the last 60 s.
- Test: `server/test/india/sources.test.ts` (full packet with depth), `server/test/india/inPrices.test.ts`

**Interfaces:**
- `KiteTick` gains `bid: number | null; ask: number | null` (full mode only).
- Produces: `optionTokensFor(instruments: KiteInstrument[], reports: PendingReport[], spots: Map<string, number>): Map<number, { reportId: number; strike: number; type: 'CE' | 'PE' }>`

- [ ] **Step 1: Write failing tests:**
  - `'full packet: bid 29.50 ask 31.00 parsed from depth'`
  - `'option ticks update the live move within one throttle window'`
  - `'no ticks for 2 min in session: Yahoo price, source backup'`
  - `'universe = F&O ∪ watched'`
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: India live prices for all stocks and live expected move from option ticks`.

### Task 13: Live market cap from share counts

**Files:**
- Create: `server/src/jobs/shares.ts`. Runs daily at 06:00 ET for US and 07:00 IST for India.
  - US: `https://data.sec.gov/api/xbrl/companyconcept/CIK##########/dei/EntityCommonStockSharesOutstanding.json`, latest `val` by `end`.
  - India: Yahoo quoteSummary module `defaultKeyStatistics.sharesOutstanding` (add to `yahooIn.ts` modules).
- Modify:
  - `reports` gains `shares_outstanding REAL, shares_as_of TEXT`; `in_stocks` gains `shares_outstanding REAL, shares_as_of TEXT`.
  - `ReportDto` / `InReportDto` add `sharesOutstanding: number | null`.
  - Web `StockList` / `InStockList` / `WatchlistView`: when `reportDate >= today` and a live price and share count exist, show market cap = price × shares, marked "live". Otherwise show the stored value.
- Test: `server/test/jobs/shares.test.ts`, web StockList case.

- [ ] **Step 1: Write failing tests:**
  - `'SEC companyconcept: latest end wins'`
  - `'missing shares keeps the stored cap'`
  - Web: `'upcoming row shows live cap = price × shares; past row shows stored cap'`
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: live market cap for upcoming reports`.

### Task 14: Faster schedules with failover; India previous-move backup

**Files:**
- Modify `server/src/jobs/scheduler.ts`:
  - US calendar every 5 min (it covers only the next 14 days; the 90-day refresh stays every 2 h).
  - Results every minute 06:00–20:59 ET on weekdays (remove the 30-min midday gap).
  - Yahoo estimates hourly for reports in the next 7 days, every 6 h otherwise.
  - Live expected move every minute 09:30–16:15 ET.
- Modify `server/src/india/jobs/scheduler.ts`:
  - Calendar every minute.
  - Estimates hourly (next 7 days) / every 6 h.
- Wrap Nasdaq, Yahoo, Cboe and NSE calls in `createFailover`, with the backups from the spec table:
  - Result dates: Yahoo `calendarEvents`, stored as estimated.
  - Estimates: keep the stored values.
- Create: `server/src/india/sources/yahooPastDates.ts`: `fetchYahooPastDates(nseSymbol): Promise<{ date: string; timing: 'BMO' | 'AMC' | 'DMH' | null }[]>`.
  - It POSTs `https://query1.finance.yahoo.com/v1/finance/visualization?crumb=` with the body from the India plan's source facts.
  - TAS rows only. Time is converted to IST and then to timing with `timingFromIst`.
  - Uses `openYahooSession` cookies with a raw `fetch` POST.
- Modify `server/src/india/jobs/prevMoves.ts`: when `priorReleasedReport` is null, use the latest Yahoo past date before this report. Basis `known` if it has a time, else `assumed`.
- Test:
  - `server/test/india/yahooPastDates.test.ts` (live-verified fixture: save one real response)
  - `server/test/india/prevMoves.test.ts`
  - scheduler cron-string test

- [ ] **Step 1: Write failing tests:**
  - `'Yahoo past dates: TAS rows only, IST timing'`
  - `'no captured prior report: Yahoo date used, basis known'`
  - `'Nasdaq blocked: calendar falls back to Yahoo estimated dates'`
  - `'cron strings match the spec'`
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: faster schedules with failover; India previous move from Yahoo dates`.

### Task 15: Coverage report, backup markers and pre-demo check

**Files:**
- Create: `server/src/jobs/coverage.ts`
  - `computeCoverage(db, market, today): { field: string; filled: number; total: number; pct: number; min: number; ok: boolean }[]`, over reports dated today…today+14.
  - **US fields and minimums:** epsEstimate 85, marketCap 95, timing (not UNKNOWN) 70, previousMove 70, expectedMove 60 (reports within 7 days).
  - **India fields and minimums:** epsEstimate 60, marketCap 95, previousMove 60, expectedMove 60 (within 7 days, F&O only).
- Create: `server/src/cli/coverageCheck.ts` (`npm run coverage-check -w server`): prints the table; exits 1 if any field is below its minimum.
- Modify:
  - `GET /api/status`: adds `coverage: { US: [...], IN: [...] }`.
  - `web/src/components/StatusPage.tsx`: coverage table and source states (ok / failing / blocked / backup, blocked until).
  - `web/src/components/MarketBar.tsx` and rows: a small "backup" marker when a value came from a backup source (`source: 'backup'` on prices; `via` stored as `*_source` for other fields).
- Test: `server/test/jobs/coverage.test.ts`, `web/test/StatusPage.test.tsx`

- [ ] **Step 1: Write failing tests:**
  - `'coverage counts filled fields over the next 14 days'`
  - `'below minimum: ok false and the CLI exits 1'`
  - `'status page shows a blocked source with its retry time'`
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the full suite, typecheck and build. Then run `npm run coverage-check -w server` against a copy of the live DB and attach its output to the commit message.
- [ ] **Step 5: Commit** `feat: coverage report, backup markers and pre-demo check`.

### Task 16: Live verification

- [ ] **Step 1:** On a US results morning (06:00–09:30 ET), run the server.
  - Confirm at least 5 reporters flip to "Results out" within 10 s of their SEC acceptance time (log timestamps).
  - Compare preliminary vs official values. Record matches and corrections in `docs/superpowers/plans/2026-10-21-live-data-and-watchlist.md` under "Live check".
- [ ] **Step 2:** The same in India (16:00–20:00 IST) for 5 F&O stocks, with Kite credentials set. Also confirm live expected move ticks.
- [ ] **Step 3:** `npm run coverage-check -w server` passes.
- [ ] **Step 4: Commit** `docs: live check results`.
