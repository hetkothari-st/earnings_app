# Hong Kong Earnings Calendar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a third market, Hong Kong, behind the US / India / Hong Kong switch. It has two data levels. **Full level**: names with an SEC filer and Cboe-listed ADR options get SEC 6-K results and an ADR expected move. **Basic level**: every other name gets Yahoo only and shows a "Basic data" tag.

**Architecture:**
- All HK code lives in `server/src/hk/` and mirrors `server/src/india/` (`universe.ts`, `domain/`, `sources/`, `db/`, `jobs/`, `live/`, `api/`). Tables are `hk_*` in the same SQLite file.
- HK reuses the shared plumbing: Http, Broadcaster, failover, `trackIn`/`guardedIn`, notes, watchlists, prefs and the job runner.
- HK reuses these existing parts:
  - US: the SEC client and parsers, the Cboe chain and `computeExpectedMove`, the US market calendar.
  - India: the Yahoo session code and the past-dates parser.
- The web app gets `market: 'HK'`. It adds an `HkStockList` built from parts split out of `InStockList`, and an HK markets strip.

**Tech Stack:** Node 24, TypeScript (NodeNext, strict), Fastify 5, node:sqlite, zod 4, luxon, node-cron, Vitest. React 19 + Vite + Testing Library. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-27-hong-kong-earnings-design.md` (binding). It builds on the US and India specs; anything not stated there behaves as the India tab.

## Global Constraints

- **Free sources only.** Allowed hosts:
  - `www.sec.gov`, `data.sec.gov`
  - `cdn.cboe.com`
  - Yahoo: `fc.yahoo.com`, `query1/query2.finance.yahoo.com`
- **Never fetch** any `hkex.com.hk` or `hkexnews.hk` URL (HKEX Terms of Use s.5), not even in scripts or by hand.
- **No personal-use or unlicensed sources:** Finnhub HK, Twelve Data, iTick, AllTick, FMP, EODHD, `qt.gtimg.cn`, `hq.sinajs.cn`, Futu/moomoo. No issuer websites, Tencent included.
- `www.gov.hk` may be read **by hand** to type in holidays. App code never fetches it.
- **Uncertain means blank.** Never overwrite a stored value with a blank. A Yahoo value never replaces an SEC value.
- **SEC:**
  - User-Agent comes only from env `SEC_USER_AGENT`.
  - Every SEC request goes through the one shared client `sources.secHttp` (`minIntervalMs: 120`, so ≤ 10 req/s for the whole app). Scripts use their own client with the same 120 ms spacing and are never run at the same time as each other.
  - Without `SEC_USER_AGENT`, full-level SEC features are off and the rest still works.
- **No Zerodha/Kite logins.** Do not run any Kite login, do not set `KITE_AUTO_LOGIN`, and do not call `/api/admin/kite/*`.
- **Do not restart the running production server.** Do not run `npm start` / `npm run dev` against `data/earnings.db`. Live checks run as CLI scripts against a **copy** of the database.
- **Times:**
  - HK: `Asia/Hong_Kong`. HK session 09:30–12:00 and 13:00–16:00 HKT.
  - Timing: `BMO` < 09:30, `DMH` 09:30–16:00 inclusive (lunch counts as during), `AMC` > 16:00.
  - US option logic: ET, using `server/src/domain/marketCalendar.ts`.
- **Money:**
  - Currency is stored as an ISO code (`CNY`, `USD`, `HKD`) exactly as the release or Yahoo states it. It is never converted and never mixed in one comparison.
  - Prices and market cap are in HK$. Display prefixes: `CNY` → `RMB¥`, `USD` → `US$`, `HKD` → `HK$`.
- **Beat/miss colour** only when estimate and actual have the same currency, the same per-share basis (`share`; an ADS actual never gets colour against a per-share estimate) and the same period.
- **Reader gate:** reading values out of 6-Ks stays off (`config.fastFields.hkEps` / `hkRevenue` = `false`) until 20 hand-checked past releases are read exactly right. The "Results out" flip ships regardless.
- **US and India behaviour unchanged:** the existing 575 server and 118 web tests stay green.
- **Style:** dark theme, Archivo, dots not stripes, no all-caps labels.
- **TDD:** red → green. Before every commit run all four:
  - `npm test` in `server/`
  - `npm test` in `web/`
  - `npx tsc --noEmit` in `server/`
  - `npx tsc --noEmit` in `web/`
- **Commit messages** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Imports:** server imports use `.js` extensions. The web app imports server types type-only from `../../server/src/...`.

## Review Focus

1. **A release with RMB and US$ columns side by side** (most Chinese ADR issuers print a US$ "convenience translation" column). Only the RMB column is read, the currency is recorded as `CNY`, and the two are never mixed. Pinned in Task 7.
2. **A 6-K that is not this period's earnings release**, e.g.:
   - a date notice, AGM notice, buyback or dividend notice
   - an older period's release, or a "September quarter" release when a June half is expected

   Nothing flips. A date notice only confirms the date. A release for another period updates only the row with that period end. Pinned in Tasks 6 and 11.
3. **EDGAR accepts filings only 06:00–22:00 ET**, so a lunchtime HK release is accepted ~18:00 HKT:
   - `releasedAt` is the acceptance time, an upper bound.
   - Timing from acceptance can prove `BMO` only, never `AMC`.
   - The row still matches through the HKT date and a ±3-day window.

   Pinned in Tasks 1 and 11.
4. **Estimate and actual in different currencies or bases**: a HKD Yahoo estimate vs an RMB actual, or a per-ADS actual vs a per-share estimate. Both numbers are shown, with no colour and no surprise %. Pinned in Task 3.
5. **Stale or ranged Yahoo dates for basic names** (0285, 2382: next date already past; or a two-date range):
   - They are ignored.
   - They never create a row in the past.
   - They never move a 6-K-confirmed date.

   Pinned in Task 9.

---

## Rulings (where the spec is silent or ambiguous)

1. **Ids:** HK report ids start at `2_000_000_001`, so notes and live events never collide with US ids or India ids (`1_000_000_001`).
2. **Period:** taken from the report date and the universe entry's `cadence` (`'Q' | 'H'`) and `fyEndMonth`. It is the latest period end strictly before the report date. For half-yearly names, a period ending in the fiscal-year-end month is `FY`, otherwise `H`.
3. **Labels:**
   - `Q`: calendar quarter of the period end, `"Q3 26"`.
   - `H`: `"1H"` + the two-digit year of the fiscal year the half belongs to, e.g. `"1H26"` (Dec year end) or `"1H27"` (Mar year end, half ending Sep 2026).
   - `FY`: `"FY"` + the two-digit year of the period end, `"FY26"`.
   - Second halves are reported as annual results, so `"2H.."` is never used.
4. **Timing (full level):**
   - SEC acceptance before 09:30 HKT on the report date proves `BMO`. Nothing else is derived from acceptance (Review Focus 3).
   - A 6-K/8-K **date notice** sets timing:
     - "before the U.S. market opens on D" ⇒ HK date D, `AMC`.
     - "after the U.S. market closes on D" ⇒ HK date D+1, `BMO`.
     - An explicit Hong Kong clock time ⇒ by the clock.
     - Otherwise ⇒ `UNKNOWN`.
   - Nasdaq's timing label is never used for HK.
5. **Full-level date:**
   - The ADR's US `reports` row is converted to an HK date: US `AMC` → next calendar day; anything else → same day.
   - It is used when Yahoo's single `.HK` date agrees, or when Yahoo has none.
   - When they disagree, nothing is written (the stored date is kept).
   - Status is `estimated` until a date notice makes it `confirmed`.
6. **First US session after the HK release:**
   - Known release instant ⇒ exact.
   - `BMO` / `DMH` / `AMC` ⇒ first US trading day ≥ the HK date.
   - `UNKNOWN` ⇒ first US trading day > the HK date (conservative).
   - Expected move = `computeExpectedMove(chain, thatSession, 'BMO')`, i.e. the first expiry on or after that session. Final when the quotes are from the last US close before the HK date (`prevTradingDay(reportDate)`).
7. **Full-level actuals:**
   - Never from Yahoo.
   - From SEC only when the reader gate is open.
   - Basic-level Yahoo actuals cover quarterly periods only: EPS from `earningsHistory`, revenue from `financialsChart` calendar quarters. Half-year and FY basic actuals stay blank.
8. **EPS read from a release:**
   - Diluted GAAP only; non-GAAP never.
   - Per ordinary share when stated, else per ADS (`epsBasis: 'ads'`).
   - Never converted with the ADR ratio.
9. **Currency column choice:** if both RMB and US$ columns are present, take RMB. Else HK$. Else US$.
10. **Reader gate:**
    - A release counts as exact when all five fields equal the hand-checked values: `eps`, `epsBasis`, `epsCurrency`, `revenue`, `revenueCurrency`.
    - Flags go on only with ≥ 20 checked releases, all exact, and 0 wrong.
11. **6-K cadence:**
    - Feed `type=6-K` every 2 s while a full-level report is due between HK today−1 and today+3 and unreleased; otherwise every 30 s.
    - Plus a 30-minute per-CIK submissions sweep.
    - Domestic filers (YUMC, ONC) arrive as 8-K Item 2.02 items, forwarded by the existing `SecWatch` through a new `onFeed` hook. There is no second 8-K request.
12. **Prices:**
    - Yahoo `.HK` polling covers visible rows, watched codes and codes reporting today or tomorrow (HKT).
    - Every 60 s during 09:15–16:30 HKT on HK trading days, otherwise every 15 min.
    - `/api/live/visible` accepts `market: 'HK'`.
    - No live market cap for HK: the stored Yahoo cap is shown with its as-of date.
13. **Not modelled:** HK half-days and typhoon closures. A date in 2028 or later ⇒ weekends-only plus a `hk-holidays` status warning (as India ruling 5).
14. **HK watchlists** accept universe codes only. The `watchlists` CHECK constraint is rebuilt to allow `'HK'`.
15. **Yahoo past-date window for the previous report:** 45–140 days back (Q) or 150–220 days back (H/FY).
16. **One Yahoo summary per code per 25 min** (TTL cache), shared by the 30-min calendar job and the hourly estimates job.

## Source facts (verify live in the task that needs them; save real samples as fixtures, never invent them)

- **SEC feeds and indexes:**
  - 6-K feed: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=6-K&company=&dateb=&owner=include&start=0&count=100&output=atom`. It has the same Atom shape as the 8-K feed; 6-K entries carry no item codes.
  - Filing index `…/<accession>-index.htm`. The press release is the `EX-99.1` row. Some issuers (e.g. HSBC) put the release in the `6-K` document itself.
- **SEC tickers** for CIK lookup: `https://www.sec.gov/files/company_tickers.json` → `{ "0": { "cik_str": 1577552, "ticker": "BABA", "title": "..." }, ... }`.
- **Cboe chain:** `https://cdn.cboe.com/api/global/delayed_quotes/options/<ADR>.json` (200 = listed). Parsed by the existing `parseCboeChain`.
- **Yahoo:**
  - `.HK` symbols use 4-digit codes: `0700.HK`, `9988.HK`.
  - Index candidates: `^HSI`, `^HSCE` (HSCEI), `HSTECH.HK` (Hang Seng Tech). Verify each with `fetchIndexQuote`; keep the one returning `currency: 'HKD'`.
- **HK general holidays** (gov.hk), weekday closures only. Re-check against `https://www.gov.hk/en/about/abouthk/holiday/2026.htm` and `/2027.htm` by hand before committing Task 1.
  - **2026:** 01-01, 02-17, 02-18, 02-19, 04-03, 04-06, 04-07, 05-01, 05-25, 06-19, 07-01, 10-01, 10-19, 12-25.
  - **2027:** 01-01, 02-08, 02-09, 03-26, 03-29, 04-05, 05-13, 06-09, 07-01, 09-16, 10-01, 10-08, 12-27.

## File map

**Server, create:**
- `src/hk/universe.ts`
- `src/hk/domain/hkCalendar.ts`, `src/hk/domain/period.ts`, `src/hk/domain/hkMoves.ts`
- `src/hk/db/schema.ts`, `src/hk/db/hkRepo.ts`
- `src/hk/api/types.ts`, `src/hk/api/dto.ts`, `src/hk/api/routes.ts`
- `src/hk/sources/yahooHk.ts`, `src/hk/sources/sixK.ts`, `src/hk/sources/releaseHk.ts`
- `src/hk/jobs/context.ts`, `stocks.ts`, `calendar.ts`, `estimates.ts`, `results.ts`, `prevMoves.ts`, `moves.ts`, `secSweep.ts`, `scheduler.ts`
- `src/hk/live/hkSecWatch.ts`, `src/hk/live/hkPrices.ts`
- `src/cli/verifyHkUniverse.ts`, `src/cli/collectHkCorpus.ts`, `src/cli/hkSpotCheck.ts`

**Server, modify:**
- `src/db/repo.ts` (call `ensureHkSchema`)
- `src/config.ts` (`fastFields.hkEps`, `hkRevenue`)
- `src/sources/secFeed.ts`, `src/sources/releaseReader.ts`, `src/sources/yahoo.ts`
- `src/live/secWatch.ts`
- `src/india/sources/yahooPastDates.ts`, `src/india/jobs/context.ts`, `src/india/api/types.ts`, `src/india/db/inRepo.ts`, `src/india/api/routes.ts`
- `src/watchlist/store.ts`, `routes.ts`, `search.ts`
- `src/notes/store.ts`, `routes.ts`
- `src/jobs/coverage.ts`, `src/cli/coverageCheck.ts`, `src/cli/readerCorpus.ts`
- `src/api/types.ts`, `src/api/server.ts`
- `src/index.ts`
- `package.json` scripts

**Web, create:**
- `src/components/listParts.tsx`, `src/components/HkStockList.tsx`

**Web, modify:**
- `src/lib/market.ts`, `src/hooks/useMarket.ts`, `src/hooks/useLiveResults.ts`, `src/hooks/useVisibleSymbols.ts`
- `src/api.ts`, `src/adminApi.ts`
- `src/components/Header.tsx`, `Calendar.tsx`, `InStockList.tsx`, `MarketBar.tsx`, `WatchlistView.tsx`, `StatusPage.tsx`, `AdminPage.tsx`
- `src/lib/format.ts`, `src/styles.css`

**Fixtures:** `server/test/fixtures/hk/`:
- feeds, indexes and Yahoo/Cboe samples (Tasks 5, 6)
- `releases/*.htm` + `releases/expected.json` (Task 8)

---

### Task 1: HK domain (calendar, timing, periods, US-session mapping)

**Files:**
- Create: `server/src/hk/domain/hkCalendar.ts`, `server/src/hk/domain/period.ts`, `server/src/hk/domain/hkMoves.ts`
- Test: `server/test/hk/hkCalendar.test.ts`, `server/test/hk/period.test.ts`, `server/test/hk/hkMoves.test.ts`

**Interfaces:**
- Consumes (US): `isTradingDay`, `nextTradingDay`, `prevTradingDay`, `ET` from `server/src/domain/marketCalendar.ts`.
- Produces from `hkCalendar.ts`:
  - `HKT = 'Asia/Hong_Kong'`
  - `type HkTiming = 'BMO' | 'DMH' | 'AMC' | 'UNKNOWN'`
  - `HK_HOLIDAYS: Record<number, ReadonlySet<string>>`, with the 2026 and 2027 lists from Source facts
  - `todayHKT(): string`
  - `addDaysHKT(date: string, n: number): string`
  - `isHkTradingDay(date: string): boolean`: weekends, then holidays; unknown years count as weekends-only
  - `prevHkTradingDay(date: string): string`: strictly before `date`
  - `hkTradingDayOnOrAfter(date: string): string`
  - `hkTimingFromHkt(hhmm: string | null | undefined): HkTiming`
  - `hkTimingFromAcceptance(reportDate: string, acceptedAtIso: string): 'BMO' | null`
  - `holidaysUnknownHk(date: string): boolean`: true for dates on or after `2028-01-01`
- Produces from `period.ts`:
  - `type HkPeriodKind = 'Q' | 'H' | 'FY'`
  - `hkPeriodFor(reportDate: string, cadence: 'Q' | 'H', fyEndMonth: number): { periodEnd: string; kind: HkPeriodKind }`
  - `hkPeriodLabel(periodEnd: string, kind: HkPeriodKind, fyEndMonth: number): string`
- Produces from `hkMoves.ts`:
  - `firstUsSessionAfterHkRelease(reportDate: string, timing: HkTiming, releasedAt: string | null): string` (Ruling 6)
  - `lastUsCloseBeforeHk(reportDate: string): string`, which is `prevTradingDay(reportDate)`
  - `hkReactionWindow(reportDate: string, timing: 'BMO' | 'DMH' | 'AMC'): { before: string; after: string }`. Same rule as India `reactionWindow`, on the HK calendar.
  - `hkDateFromUs(usDate: string, usTiming: 'BMO' | 'AMC' | 'DMH' | 'UNKNOWN'): string` (Ruling 5)

- [ ] **Step 1: Write failing tests.**
  - `hkCalendar.test.ts`:
    - `'gov.hk holidays and weekends are closed'`: `isHkTradingDay('2026-02-17')`, `('2026-10-19')`, `('2027-02-09')` and `('2026-10-24')` are all `false`; `('2026-02-20')` is `true`
    - `'previous trading day skips Lunar New Year'`: `prevHkTradingDay('2026-02-20') === '2026-02-16'`
    - `'timing: lunch counts as during'`:
      - `'09:29'` → `BMO`; `'09:30'` → `DMH`; `'12:30'` → `DMH`; `'16:00'` → `DMH`; `'16:01'` → `AMC`; `null` → `UNKNOWN`
    - `'acceptance proves BMO only'`:
      - `hkTimingFromAcceptance('2026-11-20', '2026-11-20T00:59:00Z') === 'BMO'` (08:59 HKT)
      - `('2026-11-20', '2026-11-20T11:30:00Z') === null` (19:30 HKT)
      - `('2026-11-20', '2026-11-19T00:59:00Z') === null` (another day)
    - `'2028 is flagged unknown'`: `holidaysUnknownHk('2028-01-03') === true`, `('2027-12-31') === false`
  - `period.test.ts`, `'period from report date and cadence'`:
    - `hkPeriodFor('2026-11-20','Q',3)` → `{ periodEnd: '2026-09-30', kind: 'Q' }`
    - `hkPeriodFor('2026-08-19','H',12)` → `{ periodEnd: '2026-06-30', kind: 'H' }`
    - `hkPeriodFor('2027-03-18','H',12)` → `{ periodEnd: '2026-12-31', kind: 'FY' }`
    - `hkPeriodFor('2026-11-25','H',3)` → `{ periodEnd: '2026-09-30', kind: 'H' }`
    - `hkPeriodFor('2027-05-20','H',3)` → `{ periodEnd: '2027-03-31', kind: 'FY' }`
  - `period.test.ts`, `'labels'`:
    - `hkPeriodLabel('2026-09-30','Q',3) === 'Q3 26'`
    - `('2026-06-30','H',12) === '1H26'`
    - `('2026-12-31','FY',12) === 'FY26'`
    - `('2026-09-30','H',3) === '1H27'`
  - `hkMoves.test.ts`:
    - `'first US session after the HK release'`:
      - `('2026-11-20','AMC',null) === '2026-11-20'`
      - `('2026-11-20','UNKNOWN',null) === '2026-11-23'`
      - `('2026-11-26','BMO',null) === '2026-11-27'` (Thanksgiving)
      - `('2026-11-20','AMC','2026-11-20T15:00:00Z') === '2026-11-23'` (released after the US open)
    - `'last US close before'`: `lastUsCloseBeforeHk('2026-11-20') === '2026-11-19'`
    - `'reaction window'`:
      - `hkReactionWindow('2026-11-20','AMC')` → `{ before: '2026-11-20', after: '2026-11-23' }`
      - `('2026-11-20','BMO')` → `{ before: '2026-11-19', after: '2026-11-20' }`
      - `('2026-10-19','AMC')` → `{ before: '2026-10-16', after: '2026-10-20' }`
    - `'US date to HK date'`: `hkDateFromUs('2026-11-19','AMC') === '2026-11-20'`, `hkDateFromUs('2026-11-20','BMO') === '2026-11-20'`
- [ ] **Step 2: Run** `npx vitest run test/hk` in `server/`. Expected: FAIL (modules missing).
- [ ] **Step 3: Implement** the three modules.
  - Before typing the holidays, check the gov.hk pages by hand. If a date differs from Source facts, use gov.hk's date and correct the test.
  - `hkTimingFromAcceptance`: `'BMO'` only when the acceptance's HKT date equals `reportDate` and its HKT time is before 09:30.
  - `firstUsSessionAfterHkRelease`:
    - With `releasedAt`: the first US trading day whose 09:30 ET open is at or after `releasedAt`.
    - Without it: Ruling 6.
- [ ] **Step 4: Run** the tests, then the full server suite and `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(hk): HK calendar, timing, period labels and US-session mapping`.

### Task 2: Hand-maintained universe and its verification script

**Files:**
- Create: `server/src/hk/universe.ts`, `server/src/cli/verifyHkUniverse.ts`
- Modify: `server/package.json` (script `"verify-hk-universe": "tsx src/cli/verifyHkUniverse.ts"`)
- Test: `server/test/hk/universe.test.ts`

**Interfaces:**
- Produces:
  - `interface HkUniverseEntry { code: string /* 4 digits, '0700' */; name: string; cadence: 'Q' | 'H'; fyEndMonth: number; adr: string | null; adrRatio: number | null /* HK shares per ADS (1 for common stock) */; cik: number | null }`
  - `HK_UNIVERSE: readonly HkUniverseEntry[]`
  - `hkLevel(e: HkUniverseEntry): 'full' | 'basic'`: `'full'` iff `cik != null && adr != null`
  - `yahooHkSymbol(code: string): string` → `'0700.HK'`
  - `HK_INDICES: readonly { name: string; yahoo: string }[]` = Hang Seng `^HSI`, HS China Enterprises `^HSCE`, HS Tech `HSTECH.HK` (verified in Task 5)
- CLI `verifyHkUniverse.ts`. It needs `SEC_USER_AGENT` and uses its own `makeHttp({ minIntervalMs: 120, headers: { 'User-Agent': process.env.SEC_USER_AGENT } })`. For each entry with an `adr`, it prints:
  1. The CIK from `company_tickers.json` for that ticker, and whether it equals `cik`.
  2. The HTTP status of the Cboe chain URL (`fetchCboeChain` from `sources/cboe.ts` returns non-null when listed).
  3. The first sentence matching `/each (ADS|American depositary share) represents? ([\w-]+) .{0,40}shares/i` in the latest 20-F primary document. It finds that document by reading `data.sec.gov/submissions/CIK##########.json` and filtering `form === '20-F'`. 10-K filers print `"common stock (1:1)"`.

  It exits 1 on any mismatch. It never touches the database.

- [ ] **Step 1: Write failing test** `universe.test.ts`:
  - `'codes are unique 4-digit strings and full-level entries have all three of adr, ratio, cik'`
  - `'basic list size'`: the number of entries with `hkLevel(e) === 'basic'` is between 60 and 90
  - `'full-level count'`: between 12 and 20
  - `'yahooHkSymbol pads nothing and appends .HK'`: `yahooHkSymbol('0700') === '0700.HK'`
  - `'cadence and fyEndMonth valid'`: `fyEndMonth` in 1..12
- [ ] **Step 2: Run** `npx vitest run test/hk/universe.test.ts`. Expected: FAIL.
- [ ] **Step 3: Type the universe from general knowledge**, ordered roughly by market cap. Keep the list below unless verification removes a name.
  - **Full-level candidates** (ADR, HK code, ratio, filer type; CIKs from the script):
    - Quarterly unless marked: BABA 9988 (8, FY Mar), JD 9618 (2), BIDU 9888 (8), NTES 9999 (5), TCOM 9961 (1), LI 2015 (2), NIO 9866 (1), XPEV 9868 (2), BILI 9626 (1), YUMC 9987 (1, 10-K/8-K filer), ONC 6160 (13, 10-K/8-K filer), ZTO 2057 (1), BEKE 2423 (3), HSBC 0005 (5), TME 1698 (2)
    - PUK 2378 (2, half-yearly)
    - Plus any of HTHT 1179, EDU 9901 (FY May), WB 9898, MNSO 9896, BZ 2076, ATHM 2518 that pass verification
  - **Basic** (typical cadence in brackets; `fyEndMonth` 12 unless noted). Names are typed now and refreshed from Yahoo by Task 9.
    - [Q]: 0700 Tencent, 1810 Xiaomi, 3690 Meituan, 1211 BYD, 0992 Lenovo (FY Mar)
    - [H]: 1299 AIA, 0941 China Mobile, 1398 ICBC, 0939 CCB, 3988 Bank of China, 1288 ABC, 3968 China Merchants Bank, 2318 Ping An, 2628 China Life, 0388 HKEX
    - [H]: 0883 CNOOC, 0857 PetroChina, 0386 Sinopec, 0762 China Unicom, 0728 China Telecom
    - [H]: 0016 SHK Properties (FY Jun), 0001 CK Hutchison, 1113 CK Asset, 0002 CLP, 0003 HK & China Gas, 0006 Power Assets, 0011 Hang Seng Bank, 0066 MTR, 0027 Galaxy, 1928 Sands China
    - [H]: 0019 Swire Pacific, 0823 Link REIT (FY Mar), 0688 China Overseas Land, 1109 China Resources Land, 2020 Anta, 2319 Mengniu, 0291 CR Beer
    - [H]: 2269 WuXi Bio, 1177 Sino Biopharm, 1093 CSPC, 2382 Sunny Optical, 0981 SMIC [Q], 0285 BYD Electronic, 0669 Techtronic, 0175 Geely, 2331 Li Ning
    - [H]: 6618 JD Health, 0241 Ali Health (FY Mar), 1024 Kuaishou [Q], 9633 Nongfu Spring, 6862 Haidilao, 0267 CITIC, 0998 CITIC Bank, 1658 PSBC, 2388 BOC HK, 3328 BoCom
    - [H]: 6030 CITIC Securities, 2601 CPIC, 1339 PICC Group, 2328 PICC P&C, 0012 Henderson Land, 0101 Hang Lung Properties, 1038 CKI, 0868 Xinyi Glass, 0968 Xinyi Solar, 1044 Hengan
    - [H]: 0322 Tingyi, 1876 Budweiser APAC, 0384 China Gas (FY Mar), 2688 ENN Energy, 1088 China Shenhua, 2899 Zijin, 3993 CMOC, 0914 Anhui Conch, 2359 WuXi AppTec, 1801 Innovent, 9992 Pop Mart, 1929 Chow Tai Fook (FY Mar)
  - If a name no longer has a Yahoo `.HK` quote (e.g. 0011 after a privatisation), drop it.
- [ ] **Step 4: Verify every full-level entry live.**
  - Run `npm run verify-hk-universe -w server` (with `SEC_USER_AGENT` set).
  - Fix each mismatch: CIK from SEC, ratio from the 20-F/6-K sentence, and drop names whose Cboe chain is not 200.
  - Re-run until it exits 0. Paste its output into the commit body.
- [ ] **Step 5: Run** the test and the full suite. Expected: PASS.
- [ ] **Step 6: Commit** `feat(hk): hand-maintained HK universe with live-verified full level`.

### Task 3: HK tables, repository, DTO and read routes

**Files:**
- Create: `server/src/hk/db/schema.ts`, `server/src/hk/db/hkRepo.ts`, `server/src/hk/api/types.ts`, `server/src/hk/api/dto.ts`, `server/src/hk/api/routes.ts`
- Modify: `server/src/db/repo.ts` (`openDb` calls `ensureHkSchema(db)` after `ensureInSchema`), `server/src/api/server.ts` (`ServerOptions.hk?: HkServerOptions`; call `registerHkRoutes`)
- Test: `server/test/hk/hkRepo.test.ts`, `server/test/hk/api.test.ts`

**Interfaces:**
- Consumes: Task 1 types, `HkUniverseEntry` / `hkLevel` / `yahooHkSymbol`, `ExpectedMove` from `server/src/types.ts`, and `surprisePct` / `beatMiss` from `domain/surprise.ts`.
- **Schema.** Mirrors `IN_SCHEMA`, with the same `ADDED_COLUMNS` mechanism.
  - `hk_stocks`: `code PK, name, yahoo_symbol, level, adr, adr_ratio, cik, cadence, fy_end_month, sector, industry, market_cap /*HKD*/, market_cap_as_of, active, updated_at`
  - `hk_reports`:
    - `id INTEGER PK, code, name, period_end, period_kind, period_label, report_date, date_status ('confirmed'|'estimated')`
    - `timing, timing_source ('sec-6k'|'sec-8k'|'sec-notice'|'yahoo'|NULL), released_at, rescheduled_from`
    - `revenue_actual, revenue_currency, eps_actual, eps_currency, eps_basis ('share'|'ads'), actual_source ('sec'|'yahoo'), sec_doc_url`
    - `eps_estimate, eps_analysts, revenue_estimate, revenue_analysts, estimate_currency, estimates_fetched_at`
    - `prev_move_pct, prev_move_date, prev_move_basis, prev_move_checked_at, calendar_fetched_at`
    - `UNIQUE(code, period_end)`
  - `hk_expected_moves`: like `in_expected_moves` plus `adr TEXT, quote_date TEXT`
  - `hk_live_moves`: like `in_live_moves`
  - `hk_sec_seen`: `accession PK, cik, kind, seen_at`
- **Repo** (`hkRepo.ts`):
  - Setup and stocks:
    - `HK_ID_BASE = 2_000_000_001`
    - `ensureHkSchema(db)`
    - `syncHkUniverse(db, entries: readonly HkUniverseEntry[], now: string): void`: upserts; codes not in the list become `active = 0`
    - `setHkProfile(db, code, p: { name: string | null; sector: string | null; industry: string | null; marketCap: number | null; asOf: string | null }, now): void`: COALESCE, never blanks
    - `hkStocks(db): HkStock[]`, where `HkStock` = the camelCase `hk_stocks` row (`code, name, yahooSymbol, level, adr, adrRatio, cik, cadence, fyEndMonth, sector, industry, marketCap, marketCapAsOf, active`)
  - Calendar and release:
    - `upsertHkCalendarRow(db, row: { code: string; name: string; periodEnd: string; periodKind: HkPeriodKind; periodLabel: string; reportDate: string; dateStatus: 'confirmed' | 'estimated'; timing?: HkTiming; timingSource?: string }, now: string): number`. Same semantics as `upsertInCalendarRow`: an estimated date never replaces a confirmed one, a released row's date is fixed, and a new confirmed date is a reschedule.
    - `recordHkRelease(db, id: number, releasedAt: string, source: 'sec-6k' | 'sec-8k', timing: HkTiming | null): boolean`: the earliest wins; `timing` is written only when non-null
    - `nearestUnreleasedHk(db, code: string, day: string, windowDays = 3): { id: number; reportDate: string; periodEnd: string; periodKind: HkPeriodKind } | null`
    - `findHkReportId(db, code: string, periodEnd: string): number | null`
    - `moveHkReportDate(db, id, newDate): void`
    - `setHkTiming(db, id, timing: HkTiming, source: 'yahoo'): boolean`: writes only while the stored timing is `UNKNOWN` and the row is unreleased
  - Actuals and estimates:
    - `mergeHkActuals(db, id, a: { revenue: number | null; revenueCurrency: string | null; eps: number | null; epsCurrency: string | null; epsBasis: 'share' | 'ads' | null; source: 'sec' | 'yahoo'; docUrl?: string | null }, now): boolean`
      - It never blanks a stored value.
      - `'yahoo'` never replaces `'sec'`.
      - `'sec'` replaces `'yahoo'`.
      - It returns true if anything changed.
    - `setHkEstimates(db, id, e: { eps: number | null; epsAnalysts: number | null; revenue: number | null; revenueAnalysts: number | null; currency: string | null }, now): void`: COALESCE
  - Lists:
    - `listHkRange(db, f: { from: string; to: string; q: string | null }): HkReport[]`, where `HkReport` = the camelCase `hk_reports` row, plus the stock's `level, adr, adrRatio, sector, industry, marketCap, marketCapAsOf`, plus `expectedMove: (ExpectedMove & { adr; quoteDate; final: boolean; snapshotAt }) | null` and `liveMovePct, liveMoveIlliquid, liveMoveQuoteTime`
    - `listHkForSymbols(db, codes: string[], from, to): HkReport[]`
    - `getHkReport(db, id): HkReport | undefined`
  - Moves:
    - `saveHkExpectedMove(db, id, em: ExpectedMove & { adr: string; quoteDate: string }, final: boolean, now): boolean`: a final row is never replaced
    - `saveHkLiveMove(db, id, m: { movePct: number; illiquid: boolean; quoteTime: string | null }, now): boolean`
    - `setHkPrevMove(db, id, move: { pct: number; date: string; basis: 'known' | 'assumed' } | null, now): void`
  - Job queries:
    - `hkReportsBetween(db, from, to): HkPending[]`, where `HkPending = { id; code; reportDate; timing: HkTiming; periodEnd; periodKind; releasedAt: string | null; level: 'full' | 'basic'; adr: string | null; cik: number | null; hasActual: boolean; expectedFinal: boolean }`
    - `hkReportsNeedingPrevMove(db, from, to, recheckBefore): { id; code; reportDate; timing: HkTiming }[]`
    - `priorHkReleased(db, code, before): { reportDate: string; timing: HkTiming; known: boolean } | null`
    - `usAdrRows(db, adr: string, from: string, to: string): { reportDate: string; timing: 'BMO' | 'AMC' | 'DMH' | 'UNKNOWN' }[]`: reads the US `reports` table, read-only
  - SEC bookkeeping:
    - `secSeen(db, accession): boolean`
    - `markSecSeen(db, accession, cik, kind: 'results' | 'date-notice' | 'other', now): void`
    - `lastSecSeenAt(db): string | null`
- **Types** (`hk/api/types.ts`, type-only):
  - `HkReportDto`:
    - Identity: `{ id; market: 'HK'; symbol /* HK code */; name; level: 'full' | 'basic'; adrTicker: string | null; adrRatio: number | null }`
    - Date and timing: `reportDate; dateStatus; period /* label */; periodEnd; periodKind; timing: HkTiming; timingSource; releasedAt; rescheduledFrom`
    - Company: `sector; industry; marketCap /*HKD*/; marketCapAsOf`
    - Actuals meta: `currency: string | null /* actual currency, else estimate currency */; epsBasis: 'share' | 'ads' | null; actualSource: 'sec' | 'yahoo' | null; secDocUrl`
    - `eps: { estimate; analysts; estimateCurrency; actual; actualCurrency; surprisePct; result: BeatMiss | null }`
    - `revenue: { …same… }`
    - `expectedMove: { adr; expiry; strike; callMid; putMid; underlying /*US$ ADR close*/; movePct; illiquid; final; quoteDate; snapshotAt } | null`
    - `liveMove` and `previousMove`: as in `InReportDto`
  - `HkEarningsResponse { rows: HkReportDto[] }`
  - `HkLivePriceDto { price: number; prevClose: number | null; changePct: number | null; at: string }`
  - `HkMarketDto { index: string; price: number | null; changePct: number | null; asOf: string | null }`
  - `HkAdminDto { full: number; basic: number; secConfigured: boolean; readerOn: boolean; lastSixKAt: string | null }`
- **DTO:** `toHkDto(r: HkReport): HkReportDto`.
  - `surprisePct` / `result` are non-null only when the estimate and actual currencies are equal and non-null and `epsBasis === 'share'` (EPS).
  - For revenue, only the currencies need to match.
- **Routes:** `registerHkRoutes(app, db, currentUser, nowFn = Date.now, opts: HkServerOptions = {})`, where `HkServerOptions = { prices?: () => Record<string, HkLivePriceDto>; indices?: () => HkMarketDto[]; indexQuote?: (yahooSymbol: string) => Promise<IndexQuote> }`.
  - `GET /api/hk/earnings?from&to&q`: same validation and 400-day cap as India.
  - `GET /api/hk/earnings/:id`: 404 when missing.
  - `GET /api/hk/prices` → `{ prices }`.
  - `GET /api/hk/markets` → `{ indices: HkMarketDto[] }`. It uses `opts.indices()` when non-empty, else `opts.indexQuote` per `HK_INDICES`, cached 15 s. A failed index gives nulls.

- [ ] **Step 1: Write failing tests.**
  - `hkRepo.test.ts`:
    - `'ids start at 2_000_000_001'`
    - `'estimated date never replaces confirmed; confirmed new date is a reschedule'`
    - `'yahoo actuals never replace sec; sec replaces yahoo; a null never blanks'`
    - `'final expected move is never replaced'`
    - `'syncHkUniverse marks dropped codes inactive and keeps their reports'`
    - `'usAdrRows reads the US reports table'` (insert with `upsertCalendarRow` from `db/repo.ts`)
  - `api.test.ts`, `'beat/miss only with same currency and per-share basis'` (Review Focus 4). Three rows:
    - Estimate 2.10 CNY, actual 2.30 CNY, `share` → `result: 'beat'`, `surprisePct: 9.5`.
    - Estimate HKD, actual CNY → `result: null`, `surprisePct: null`, both numbers present.
    - Actual `ads` → `result: null`.
  - `api.test.ts`, other tests:
    - `'level, currency, epsBasis, actualSource and period are in the row'`
    - `'GET /api/hk/earnings/:id 404'`
    - `'rejects bad ranges'`
    - `'markets falls back to index quotes and caches 15 s'` (`indexQuote` stub counts calls)
- [ ] **Step 2: Run** `npx vitest run test/hk/hkRepo.test.ts test/hk/api.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the schema, repo, types, DTO and routes as above.
- [ ] **Step 4: Run** the tests, the full server suite and `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(hk): hk_* tables, repository, DTO and /api/hk read routes`.

### Task 4: Market `'HK'` across shared server plumbing, status and admin

**Files:**
- Modify (every place that enumerates `'US' | 'IN'` on the server):
  - `server/src/india/api/types.ts:5`: `Market = 'US' | 'IN' | 'HK'`
  - `server/src/india/db/inRepo.ts:547-556`: `getInPref` / `setInPref` use `Market`; `'HK'` is round-tripped
  - `server/src/india/api/routes.ts`: `PUT /api/prefs` accepts `'HK'`; error text `market must be "US", "IN" or "HK"`
  - `server/src/watchlist/store.ts`:
    - `WatchMarket = Market`.
    - `ensureWatchSchema` creates `CHECK (market IN ('US','IN','HK'))`.
    - It **rebuilds** an existing table whose `sqlite_master.sql` lacks `'HK'`: create `watchlists_new`, copy the rows, drop the old table, rename, all in one transaction.
  - `server/src/watchlist/routes.ts`:
    - `asMarket` accepts `'HK'`.
    - `normalize`: HK = `raw.trim()` padded to 4 digits.
    - `BAD_MARKET` text includes HK.
    - `/api/watchlist/rows` for HK uses `listHkForSymbols` + `toHkDto` with `HKT` for "today".
  - `server/src/watchlist/search.ts`:
    - `SymbolIndex` records get an `HK` key.
    - `startSymbolRefresh` runs `'HK'`.
    - New `hkEntries(db?: Db): IndexEntry[]`: from `HK_UNIVERSE` with names and caps from `hk_stocks`, `exchange: 'HKEX'`.
  - `server/src/notes/store.ts`:
    - New `hkNoteDeadline(r: { reportDate: string; timing: Timing; releasedAt: string | null }): string`: `releasedAt` + 24 h; else BMO 09:30 HKT, UNKNOWN 23:59:59 HKT, otherwise 16:00 HKT; all + 24 h.
    - `rows()` LEFT JOINs `hk_reports h`.
    - `deadlineOf` falls through to HK.
  - `server/src/notes/routes.ts`: report lookup also tries `getHkReport`.
  - `server/src/jobs/coverage.ts`:
    - `Market` includes `'HK'`.
    - `FieldDef` gains an optional `where?: string`.
    - HK fields:
      - `epsEstimate` min 40
      - `marketCap` min 95 (`s.market_cap`)
      - `previousMove` min 50
      - `expectedMove` min 60, `withinWeek`, `where: "s.level = 'full'"`
    - HK source: `hk_reports r JOIN hk_stocks s ON s.code = r.code AND s.active = 1`.
    - `runCoverageCheck(db, todayUs, todayIn, todayHk, log)`.
  - `server/src/cli/coverageCheck.ts`: passes `todayHKT()`.
  - `server/src/api/types.ts`:
    - `StatusResponse.coverage: { US; IN; HK }`.
    - `WatchRow.next` / `latest` unions include `HkReportDto`.
  - `server/src/api/server.ts`:
    - `/api/status` adds `HK: computeCoverage(db, 'HK', todayHKT())`.
    - `PUT /api/live/visible` accepts `market: 'HK'` with codes matching `/^\d{4,5}$/`, routed to `opts.hk?.setVisible`. `HkServerOptions` gains `setVisible?: (user: string, codes: string[]) => void`.
  - `server/src/hk/api/routes.ts`: `GET /api/admin/hk` (admin only, like `/api/admin/kite`) → `HkAdminDto`.
    - Counts come from `hk_stocks`.
    - `secConfigured = !!config.secUserAgent`.
    - `readerOn = config.fastFields.hkEps || config.fastFields.hkRevenue`.
    - `lastSixKAt = lastSecSeenAt(db)`.
- Test: `server/test/hk/plumbing.test.ts`, plus the existing watchlist / notes / coverage / visible tests updated for the new signatures

**Interfaces:**
- Consumes: Task 3 repo and DTO.
- Produces:
  - `Market = 'US' | 'IN' | 'HK'` (single source for the server)
  - `hkNoteDeadline`, `hkEntries`
  - `runCoverageCheck(db, todayUs: string, todayIn: string, todayHk: string, log): number`

- [ ] **Step 1: Write failing tests** (`plumbing.test.ts`):
  - `'prefs round-trip HK'`: PUT `{ market: 'HK' }` → GET → `'HK'`; `'XX'` → 400
  - `'old watchlists table without HK is rebuilt and keeps rows'`. Create the old table with the old CHECK, insert a US row, call `ensureWatchSchema`, then `addWatch(db,'u','HK','0700',…)` works and the US row is still there.
  - `'HK watch PUT accepts universe codes only'`: `0700` → 204; `1234` → 400 when the index is loaded
  - `'HK note deadline: 16:00 HKT + 24 h for AMC without release time'`: `hkNoteDeadline({ reportDate: '2026-11-20', timing: 'AMC', releasedAt: null }) === '2026-11-21T08:00:00.000Z'`
  - `'status coverage has HK rows; expectedMove counts full level only'`
  - `'admin hk panel is admins only and reports counts'`
  - `'visible accepts HK codes'`
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement** the modifications listed under Files.
- [ ] **Step 4: Run** the full server suite and `npx tsc --noEmit`. Expected: PASS, with existing US/India tests unchanged apart from signature updates.
- [ ] **Step 5: Commit** `feat(hk): market HK in prefs, watchlists, notes, coverage, status and admin`.

### Task 5: Yahoo `.HK` sources (summary, past dates, daily closes, indices)

**Files:**
- Create: `server/src/hk/sources/yahooHk.ts`
- Modify:
  - `server/src/india/sources/yahooPastDates.ts`:
    - Add `parseYahooPastDatesIn(json: unknown, zone: string, timingOf: (hhmm: string) => 'BMO' | 'DMH' | 'AMC' | 'UNKNOWN'): YahooPastDate[]`.
    - Add `fetchYahooPastDatesFor(yahooSymbol: string, zone: string, timingOf: …, deps?: YahooPastDatesDeps): Promise<YahooPastDate[]>`.
    - The existing `parseYahooPastDates` and `fetchYahooPastDates` become one-line wrappers with IST / `timingFromIst` / `${s}.NS`, so India tests are unchanged.
    - TAS rows only, for HK as for India.
  - `server/src/sources/yahoo.ts`: add `parseYahooDailyCloses(json: unknown, zone: string): Map<string, number>` and `fetchYahooDailyCloses(http: Http, symbol: string, from: string, to: string, zone: string): Promise<Map<string, number>>`. The fetch uses chart `?period1=&period2=&interval=1d`; dates are in `zone`; null closes are skipped.
  - `server/src/india/jobs/context.ts`: widen the first parameter of `trackIn` and `guardedIn` to `{ db: DatabaseSync; now(): string }`, so HK reuses them unchanged.
- Fixtures (fetch live, save as-is) in `server/test/fixtures/hk/`:
  - `y_0700.HK.json` and `y_9988.HK.json` (quoteSummary with the modules below)
  - `y_viz_0700.HK.json` (visualization)
  - `y_chart_0700.HK.json` (1-year daily chart)
  - `y_^HSI.json`, `y_^HSCE.json`, `y_HSTECH.HK.json`
- Test: `server/test/hk/yahooHk.test.ts`

**Interfaces:**
- Consumes:
  - `createQuoteSummaryFetcher(modules, parse)` from `sources/yahooEarnings.ts`
  - `openYahooSession()` (via the past-dates fetcher)
  - `fetchIndexQuote(http, symbol): Promise<IndexQuote>` and `fetchStockQuote(http, symbol): Promise<{ price; prevClose; time }>` from `sources/yahoo.ts`
- Produces from `yahooHk.ts`:
  - `interface YahooHkSummary`:
    - `name: string | null; priceCurrency: string | null`
    - `sector; industry; marketCap: number | null /* only when priceCurrency === 'HKD' */; marketCapAsOf: string | null /* HKT date */`
    - `nextDate: string | null /* single date only, HKT */`
    - `trend: { period: string; periodEnd: string; eps: number | null; epsAnalysts: number | null; epsCurrency: string | null; revenue: number | null; revenueAnalysts: number | null; revenueCurrency: string | null }[] /* periods 0q,+1q,0y,+1y */`
    - `epsHistory: { periodEnd: string; actual: number; currency: string | null }[]`
    - `revenueQuarters: { label: string; revenue: number }[]; financialCurrency: string | null`
  - `parseYahooHkSummary(json: unknown): YahooHkSummary`: zod; throws `SourceFormatError` on shape errors
  - `createYahooHkFetcher(ttlMs = 25 * 60_000): (yahooSymbol: string) => Promise<YahooHkSummary | null>`. Modules `price,assetProfile,calendarEvents,earningsTrend,earningsHistory,earnings`. Per-symbol TTL cache (Ruling 16).
  - `yahooHkPastDates(yahooSymbol: string): Promise<YahooPastDate[]>` = `fetchYahooPastDatesFor(yahooSymbol, HKT, hkTimingFromHkt)`

- [ ] **Step 1: Write failing tests** (`yahooHk.test.ts`):
  - `'summary keeps currencies as stated'`: for 0700, check `priceCurrency === 'HKD'`, `marketCap > 1e12`, and each trend item's `epsCurrency` equals the fixture's `earningsCurrency`
  - `'market cap is null when the quote is not in HKD'` (edit a clone: `price.currency = 'USD'`)
  - `'a two-date range gives nextDate null'` (clone with two `earningsDate` items)
  - `'yearly and quarterly trend periods are both kept with their end dates'`
  - `'past dates: TAS only, HKT date and timing'`: `parseYahooPastDatesIn({finance:{result:[{documents:[{rows:[['0700.HK','2026-08-13T08:30:00.000Z','TAS'],['0700.HK','2026-05-14T00:00:00.000Z','TNS']]}]}]}}, HKT, hkTimingFromHkt)` → `[{ date: '2026-08-13', timing: 'AMC' }]` (16:30 HKT)
  - `'India wrappers unchanged'`: the existing `yahooPastDates.test.ts` passes untouched
  - `'daily closes keyed by HKT date'`: from `y_chart_0700.HK.json`, the map has ≥ 200 entries and no weekend dates
  - `'index symbols verified'`: `parseIndexQuote` of each saved index fixture has `currency === 'HKD'`. If a candidate symbol fails live, try `^HSTECH` and record the working one in `HK_INDICES`.
- [ ] **Step 2: Run** `npx vitest run test/hk/yahooHk.test.ts test/india/yahooPastDates.test.ts`. Expected: FAIL (HK module missing).
- [ ] **Step 3: Implement** `yahooHk.ts`, the past-dates generalization, the daily closes and the `trackIn` / `guardedIn` widening.
- [ ] **Step 4: Run** the full server suite and `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(hk): Yahoo .HK summary, past dates, daily closes and index symbols`.

### Task 6: SEC 6-K feed, filing documents and exhibit classifier

**Files:**
- Modify `server/src/sources/secFeed.ts`:
  - `fetchSecFeed(http: Http, form: '8-K' | '6-K' = '8-K')`: the URL `type=` follows `form`.
  - Add `parseFilingDocs(html: string, indexUrl: string): { type: string; url: string; description: string }[]`, from the same table walk as `parseFilingIndex`, which stays unchanged.
- Modify `server/src/live/secWatch.ts`: constructor gains an optional 5th parameter `onFeed?: (items: SecFeedItem[]) => void`. It is called with every fresh item (all forms and items) before they are marked seen. Errors from it are caught and logged.
- Create `server/src/hk/sources/sixK.ts`
- Fixtures in `server/test/fixtures/hk/`:
  - `sec_getcurrent_6k.xml` (live, with `SEC_USER_AGENT`)
  - Exhibits, each saved from EDGAR:
    - one BABA results 6-K index page and its EX-99.1
    - one HSBC 6-K index whose release is the 6-K document itself
    - one BABA or JD date-notice exhibit ("to Announce … Results")
    - one non-results 6-K exhibit (e.g. a buyback or AGM notice)
- Test: `server/test/hk/sixK.test.ts`, `server/test/sources/secFeed.test.ts` (add cases), `server/test/live/secWatch.test.ts` (add case)

**Interfaces:**
- Consumes: `parseSecFeed`, `SecFeedItem`. For the table check, `sixK.ts` uses its own test that some `<table>` row label matches `/per (ordinary )?share|per ads|revenue/i`, so this task does not depend on Task 7.
- Produces from `sixK.ts`:
  - `type HkExhibit = { kind: 'results'; periodEnd: string; span: 'quarter' | 'half' | 'year' } | { kind: 'date-notice'; date: string /* HK date */; timing: HkTiming } | { kind: 'other' }`
  - `classifyHkExhibit(html: string): HkExhibit`
    - **Results** requires both:
      - A results phrase in the first 5,000 decoded characters (`announces?|reports?` … `results`, `interim results`, `annual results`, `<Month> Quarter <yyyy> Results`).
      - A period phrase giving the end date: `(three|six|twelve) months ended <date>`, `quarter ended <date>`, `year ended <date>`, or `<Month> quarter <yyyy>` → that month's end.
    - The most specific span wins: a "fourth quarter and full year" release is `quarter`.
    - A results document must also contain a table row for revenue or per-share earnings; otherwise it is not results.
    - **Date notice:** `(to|will) (announce|report|release) … results … on <Month D, YYYY>`, mapped by `parseDateNotice`.
    - Anything else is `other`.
  - `parseDateNotice(text: string): { date: string; timing: HkTiming } | null` (Ruling 4)
  - `pickReleaseDoc(docs: ReturnType<typeof parseFilingDocs>): string | null`: `EX-99.1`, else the first `EX-99*`, else the `6-K` / `8-K` document

- [ ] **Step 1: Write failing tests.**
  - `secFeed.test.ts`:
    - `'6-K feed parses with empty items and form 6-K'`
    - `'fetchSecFeed(http, "6-K") requests type=6-K'` (stub `Http` records the URL)
    - `'parseFilingDocs lists every document with type and absolute url'`
  - `secWatch.test.ts`: `'onFeed receives fresh items once'`. The second tick with the same feed calls `onFeed` with `[]` or not at all.
  - `sixK.test.ts`:
    - `'BABA EX-99.1 is results for the quarter ended 2026-…'` (exact `periodEnd` of the saved fixture, `span: 'quarter'`)
    - `'HSBC 6-K document is picked when there is no EX-99'`
    - `'date notice: before the U.S. market opens on D → HK date D, AMC'`: `parseDateNotice('…will announce its results … before the U.S. market opens on Thursday, November 20, 2026')` → `{ date: '2026-11-20', timing: 'AMC' }`
    - `'after the U.S. market closes on D → D+1 BMO'`
    - `'explicit Hong Kong time → by the clock'`: `'at 4:30 p.m. Hong Kong time on August 13, 2026'` → `{ date: '2026-08-13', timing: 'AMC' }`
    - `'buyback / AGM notice is other'` (Review Focus 2)
    - `'a date notice is never results even though it names a quarter'`
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement** the `secFeed` and `SecWatch` changes and `sixK.ts`.
- [ ] **Step 4: Run** the full server suite (all US `secFeed` / `secWatch` tests unchanged) and `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(hk): 6-K feed, filing documents, exhibit classifier; SecWatch onFeed hook`.

### Task 7: Release reader for foreign-issuer layouts

**Files:**
- Modify: `server/src/sources/releaseReader.ts`
- Create: `server/src/hk/sources/releaseHk.ts`
- Test: `server/test/sources/releaseReader.test.ts` (unchanged, must pass), `server/test/hk/releaseHk.test.ts`

**Interfaces:**
- Refactor `releaseReader.ts` with no change in US behaviour:
  - Export `parseTables`.
  - Extract the body of `readUsRelease` into `readRelease(html: string, opts: ReaderOptions): ReaderResult`.
  - `readUsRelease(html, quarterEnd)` becomes `readRelease(html, { periodEnd: quarterEnd, span: 'quarter', profile: 'us' })` mapped back to `ReleaseValues`.
  - `ReaderOptions = { periodEnd: string; span: 'quarter' | 'half' | 'year'; profile: 'us' | 'hk'; currency?: 'CNY' | 'USD' | 'HKD' }`.
- `profile: 'hk'` adds:
  1. **Column period:**
     - `span: 'half'` accepts only headers naming six months ended `periodEnd` (or `1H`/`interim` with that year).
     - `span: 'year'` accepts only year / twelve months ended `periodEnd`.
     - `'quarter'` keeps the US rules (never year-to-date).
  2. **Column currency:** each number's header text yields `CNY` (`RMB`, `Renminbi`), `USD` (`US$`, `USD`, plain `$` when the caption says US dollars or the issuer has no other currency) or `HKD` (`HK$`). Only columns in `opts.currency` are read (Ruling 9).
  3. **Units:** also `RMB in millions`, `in millions of RMB/Renminbi/US dollars/HK dollars`, `RMB'000`, `US$m`, `$m`, `$bn`.
  4. **EPS labels:**
     - GAAP diluted per share also matches `per ordinary share`, `per Class A ordinary share`, and `per share` alone under a GAAP block.
     - `per ADS` / `per American depositary share` is a separate field.
     - Adjusted/non-GAAP rows are ignored entirely.
  5. **Revenue labels:** add `revenue` and `total revenues` under `$m` tables (HSBC). Insurers without a revenue line give null.
- `ReaderResult = { epsShare: number | null; epsAds: number | null; epsAdjusted: number | null; epsGaap: number | null; revenue: number | null; unit: number | null; notes: string[] }`
- `releaseHk.ts`: `readHkRelease(html: string, period: { periodEnd: string; kind: HkPeriodKind }): HkReleaseValues`, where `HkReleaseValues = { revenue: number | null; revenueCurrency: string | null; eps: number | null; epsCurrency: string | null; epsBasis: 'share' | 'ads' | null; notes: string[] }`.
  - It detects the currencies present in the document's income-statement headers and picks one (Ruling 9).
  - It calls `readRelease` with `span` = `Q`→`quarter`, `H`→`half`, `FY`→`year`.
  - It returns `epsShare` when present (basis `share`), else `epsAds` (`ads`).
  - Values whose candidates disagree are null (existing `settle` rule).

- [ ] **Step 1: Write failing tests** (`releaseHk.test.ts`; inline small HTML tables, like the US reader tests):
  - `'RMB and US$ columns: only RMB is read'` (Review Focus 1): table header `RMB | RMB | US$`, revenue row `236,503 | 247,652 | 34,786`, caption `(in millions)`, period columns `Three months ended September 30, 2025 | 2026` → `{ revenue: 247_652_000_000, revenueCurrency: 'CNY' }`
  - `'per ordinary share preferred over per ADS'`: rows `Diluted earnings per share 1.10` and `Diluted earnings per ADS 8.80` → `{ eps: 1.10, epsBasis: 'share' }`
  - `'only per ADS stated → ads basis'`
  - `'half-year: six months ended June 30 column read, quarter column ignored'` (`kind: 'H'`)
  - `'quarter expected: six- and nine-month columns never read'`
  - `'non-GAAP row never replaces GAAP'`
  - `'$m table in USD (HSBC style)'`
  - `'no unit stated → revenue null'`
  - `'US reader unchanged'`: the existing `releaseReader.test.ts` is untouched and passes
- [ ] **Step 2: Run** the US corpus before refactoring: `npm run reader-corpus -w server > %TEMP%/before.txt`. Then run the new tests. Expected: new tests FAIL.
- [ ] **Step 3: Implement** the refactor, then the `hk` profile and `readHkRelease`.
- [ ] **Step 4: Run** `npm run reader-corpus -w server`. Expected: output identical to `before.txt`. Then run the full server suite and `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(hk): release reader profile for 6-K layouts (RMB/USD columns, per ADS, half-year)`.

### Task 8: 6-K corpus fixtures and the reader gate

**Files:**
- Create: `server/src/cli/collectHkCorpus.ts`, `server/test/fixtures/hk/releases/*.htm`, `server/test/fixtures/hk/releases/expected.json`, `server/test/hk/readerGate.test.ts`
- Modify:
  - `server/src/cli/readerCorpus.ts` (add `--hk`)
  - `server/src/config.ts`: `fastFields` adds `hkEps: false, hkRevenue: false`, plus a comment with the corpus result
  - `server/package.json` (`"collect-hk-corpus": "tsx src/cli/collectHkCorpus.ts"`)

**Interfaces:**
- Consumes: `fetchEarningsFilings(http, cik)`, `parseFilingDocs`, `pickReleaseDoc`, `classifyHkExhibit`, `readHkRelease`, `HK_UNIVERSE`.
- `collectHkCorpus.ts`:
  - It needs `SEC_USER_AGENT` and uses its own 120 ms client.
  - For each full-level CIK, it takes 6-K (and 8-K) filings from the last 24 months, picks the release document and classifies it.
  - It saves `results` exhibits as `<ADR>_<periodEnd>.htm` until there are ~24 files. Required coverage:
    - at least BABA, JD, NTES and HSBC
    - at least 2 half-year releases (HSBC interim, PUK)
    - at least 12 quarters
  - It adds `expected.json` entries `{ adr, cik, accession, periodEnd, kind, eps: null, epsBasis: null, epsCurrency: null, revenue: null, revenueCurrency: null, checked: false, note: '' }`.
  - Existing entries are never changed.
  - Files over 3 MB are skipped (HSBC full interim report: use its results 6-K, not the annual report).
- `readerCorpus.ts --hk`:
  - It prints, per file: got vs expected, and exact / blank / wrong.
  - It prints the totals `checked`, `exact`, `wrong`.
  - `gatePasses = checked >= 20 && exact === checked && wrong === 0`.

- [ ] **Step 1: Write the failing gate test** `readerGate.test.ts`:
  - `'never wrong'`: for every `checked: true` entry, each field `readHkRelease` returns is either null or equal to expected (EPS exact to the stated decimals, revenue exact integer).
  - `'gate flags follow the corpus'`: `config.fastFields.hkEps === gatePasses && config.fastFields.hkRevenue === gatePasses`, where `gatePasses` is computed as above.
  - `'corpus is big enough to judge'`: `checked >= 20`, and at least 2 entries have `kind: 'H'`.
- [ ] **Step 2: Run** `npx vitest run test/hk/readerGate.test.ts`. Expected: FAIL (no corpus).
- [ ] **Step 3: Collect** with `npm run collect-hk-corpus -w server`.
- [ ] **Step 4: Hand-check each saved release.**
  - Open the HTML.
  - Read GAAP diluted EPS (per ordinary share if stated, else per ADS), the reporting-currency revenue and the unit.
  - Write them into `expected.json` with `checked: true` and a `note` quoting the row label and column header.
  - Never copy the reader's output into `expected.json`.
- [ ] **Step 5: Run** `npm run reader-corpus -w server -- --hk`.
  - For any `wrong`, fix the reader in `releaseHk.ts` / the hk profile (Task 7 tests must stay green) until `wrong === 0`.
  - Set `hkEps` / `hkRevenue` to `true` only if the gate passes (20/20 exact); otherwise leave them `false` and record the score in the config comment.
- [ ] **Step 6: Run** the full server suite and `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 7: Commit** `test(hk): 6-K release corpus, hand-checked values and reader gate`. The body states the score, e.g. `HK reader 20/20 exact, 0 wrong: gate on`.

### Task 9: HK jobs: universe/profile, calendar, estimates, Yahoo results, previous moves

**Files:**
- Create:
  - `server/src/hk/jobs/context.ts`
  - `server/src/hk/jobs/stocks.ts`
  - `server/src/hk/jobs/calendar.ts`
  - `server/src/hk/jobs/estimates.ts`
  - `server/src/hk/jobs/results.ts`
  - `server/src/hk/jobs/prevMoves.ts`
- Test: `server/test/hk/jobs.test.ts`

**Interfaces:**
- Consumes:
  - Tasks 1–5
  - `trackIn` / `guardedIn` (widened in Task 5)
  - `reactionMovePct(closes, w)` from `india/domain/inMoves.ts`
  - `recordSourceError` / `recordSourceSuccess` from `db/repo.ts`
- Produces:
  - `interface HkJobContext`:
    - `{ db: DatabaseSync; now(): string; todayHKT(): string }`
    - `yahoo: (yahooSymbol: string) => Promise<YahooHkSummary | null>`
    - `yahooPastDates: (yahooSymbol: string) => Promise<YahooPastDate[]>`
    - `yahooCloses: (yahooSymbol: string, from: string, to: string) => Promise<Map<string, number>>`
    - `optionChain: (adr: string) => Promise<OptionChain | null>`
    - `secHttp: Http | null`
  - `refreshHkStocks(ctx): Promise<void>`: `syncHkUniverse(HK_UNIVERSE)`, then `setHkProfile` from Yahoo for each code, then `checkHkHolidayCoverage(ctx)` (`hk-holidays` source error when `holidaysUnknownHk(addDaysHKT(today, 60))`)
  - `refreshHkCalendar(ctx): Promise<void>`. For every active stock:
    - Yahoo `nextDate`, only when ≥ today.
    - Full level: `usAdrRows(adr, today−1, today+120)` mapped by `hkDateFromUs`, merged by Ruling 5.
    - `upsertHkCalendarRow` with `hkPeriodFor` / `hkPeriodLabel` and `dateStatus: 'estimated'`.
  - `refreshHkEstimates(ctx): Promise<void>`: for reports in [today−3, today+180], the trend item with `periodEnd === report.periodEnd` → `setHkEstimates`.
    - `currency` = `epsCurrency`, or `revenueCurrency` when there is no EPS estimate.
    - A revenue estimate whose currency differs from that `currency` is stored as null (one currency per row).
  - `refreshHkYahooResults(ctx): Promise<number[]>`
    - Basic level only.
    - Reports dated [today−20, today] with no actuals and `periodKind === 'Q'`.
    - EPS from `epsHistory` where `periodEnd` is in the same month as the report's `periodEnd`.
    - Revenue from `revenueQuarters` label `${q}Q${yyyy}`.
    - `mergeHkActuals(source: 'yahoo', epsBasis: 'share')`.
    - Returns the changed ids.
  - `computeHkPrevMoves(ctx): Promise<void>`
    - Reports [today−7, today+60] without a previous move, not checked in 20 h.
    - The prior report is `priorHkReleased`, else Yahoo past dates in the Ruling 15 window.
    - Timing: known `BMO`/`DMH`/`AMC` → `basis: 'known'`. Unknown → treated as `AMC`, `basis: 'assumed'` (spec).
    - Closes via `ctx.yahooCloses(yahooHkSymbol(code), before−5, after+1)`.
    - `setHkPrevMove`. A failed fetch → skip (retried next run); a miss never blanks.
    - The same Yahoo past-dates answer also holds upcoming rows. A TAS row dated on this report's date → `setHkTiming(id, hkTimingFromHkt(time), 'yahoo')`. This is the spec's basic-level "time-as-supplied" timing; otherwise timing stays "Time not announced".

- [ ] **Step 1: Write failing tests** (`jobs.test.ts`, stub context, fixtures from Task 5):
  - `'stale Yahoo date in the past creates no row'` (Review Focus 5): `nextDate: '2026-10-01'`, today `2026-10-27` → no `hk_reports` row
  - `'Yahoo date never moves a confirmed date'`: a confirmed row on 11-20, Yahoo says 11-27 → still 11-20 / confirmed
  - `'full level: US AMC 11-19 + Yahoo 11-20 → HK row 2026-11-20 estimated'`
  - `'full level: US and Yahoo disagree → nothing written'`
  - `'half-yearly basic name gets period 1H26 for an August date'`
  - `'estimates only for the matching period end, with currency'`
  - `'Yahoo results: basic quarterly only, labelled yahoo; full-level rows untouched'`
  - `'previous move: unknown prior timing → next-day window, basis assumed'`: closes `{ '2026-08-13': 500, '2026-08-14': 520 }`, prior date 08-13, timing unknown → `{ pct: 4, basis: 'assumed' }`
  - `'previous move: fetch failure leaves the row unchecked'`
  - `'a Yahoo TAS row on the report date sets timing; an UNKNOWN-only answer leaves "Time not announced"'`
- [ ] **Step 2: Run** `npx vitest run test/hk/jobs.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the six modules.
- [ ] **Step 4: Run** the full server suite and `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(hk): stocks, calendar, estimates, Yahoo results and previous-move jobs`.

### Task 10: Expected move from ADR chains (snapshot + live)

**Files:**
- Create: `server/src/hk/jobs/moves.ts`
- Fixture: `server/test/fixtures/hk/cboe_BABA.json` (live chain, saved as-is)
- Test: `server/test/hk/moves.test.ts`

**Interfaces:**
- Consumes:
  - `computeExpectedMove(chain: OptionChain, reportDate: string, timing: Timing): ExpectedMove | null` and `parseCboeChain(json, symbol)` (US, unchanged)
  - `firstUsSessionAfterHkRelease`, `lastUsCloseBeforeHk`
  - `todayET` from `marketCalendar.ts`
  - `saveHkExpectedMove`, `saveHkLiveMove`, `hkReportsBetween`
- Produces:
  - `snapshotHkMoves(ctx: HkJobContext): Promise<number[]>`
    - Full-level, unreleased, not-final reports dated [todayHKT, todayHKT+7].
    - `chain = guardedIn(ctx, { name: 'cboe', run: () => ctx.optionChain(adr) })`.
    - Skip when `!chain.asOfDate` or `chain.asOfDate > lastUsCloseBeforeHk(reportDate)` (priced in).
    - `em = computeExpectedMove(chain, firstUsSessionAfterHkRelease(reportDate, timing, releasedAt), 'BMO')`.
    - `final = chain.asOfDate === lastUsCloseBeforeHk(reportDate)`.
    - Returns the changed ids.
  - `refreshHkLiveMoves(ctx: HkJobContext): Promise<number[]>`: only rows where `lastUsCloseBeforeHk(reportDate) === todayET()`, same computation, `saveHkLiveMove`

- [ ] **Step 1: Write failing tests** (`moves.test.ts`, `optionChain` stub returning `parseCboeChain(fixture)` with `asOfDate` overridden):
  - `'quotes from the last US close before the HK date are final'`: report 2026-11-20, `asOfDate: '2026-11-19'` → `final: true`
  - `'an earlier close is provisional and later replaced'`: 11-18 → provisional, then 11-19 → final
  - `'quotes after the release are never used'`: `asOfDate: '2026-11-20'` → nothing saved
  - `'expiry is on or after the first US session after the release'`: timing UNKNOWN → `em.expiry > '2026-11-20'`; timing AMC → `em.expiry >= '2026-11-20'`
  - `'basic level and no-ADR rows are skipped'`
  - `'Cboe blocked: nothing written, stored value kept'`
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement** `moves.ts`.
- [ ] **Step 4: Run** the full server suite and `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(hk): expected move from ADR option chains`.

### Task 11: Live 6-K watcher, SEC sweep, delayed prices, scheduler and wiring

**Files:**
- Create:
  - `server/src/hk/live/hkSecWatch.ts`
  - `server/src/hk/jobs/secSweep.ts`
  - `server/src/hk/live/hkPrices.ts`
  - `server/src/hk/jobs/scheduler.ts`
- Modify: `server/src/index.ts`
- Test: `server/test/hk/hkSecWatch.test.ts`, `server/test/hk/hkPrices.test.ts`, `server/test/hk/scheduler.test.ts`

**Interfaces:**
- Consumes:
  - `fetchSecFeed(http, '6-K')`, `parseFilingDocs`, `pickReleaseDoc`, `classifyHkExhibit`, `readHkRelease`
  - `fetchEarningsFilings(http, cik): Promise<Filing[]>` and `fetchAcceptance(http, cik, accession): Promise<string /* ET wall clock */>` from `sources/sec.ts`
  - `createFailover`
  - Repo: `nearestUnreleasedHk`, `findHkReportId`, `moveHkReportDate`, `recordHkRelease`, `mergeHkActuals`, `upsertHkCalendarRow`, `secSeen`, `markSecSeen`
  - `fetchStockQuote`, `fetchIndexQuote`
  - `allWatched(db, 'HK')`
  - `Broadcaster`
- Produces:
  - `handleHkFiling(ctx: HkJobContext, f: { cik: number; accession: string; indexUrl: string; acceptedAt: string /* ISO UTC */; form: string }, gates = config.fastFields): Promise<{ released: number[]; dated: number[] }>`. Shared by the watcher and the sweep.
    - Fetch the index, then the release document, then classify it.
    - **`results`:**
      - The row is `findHkReportId(code, periodEnd)`. If that row is unreleased and dated ≠ the acceptance's HKT date (within ±3 days), it moves.
      - If there is no row with that period end, use `nearestUnreleasedHk` only when its `periodEnd` matches; otherwise log and do nothing (Review Focus 2).
      - Then `recordHkRelease(id, acceptedAt, form === '8-K' ? 'sec-8k' : 'sec-6k', hkTimingFromAcceptance(...))`.
      - If the gates are open: `readHkRelease` → `mergeHkActuals(source: 'sec', docUrl)`, writing only fields whose gate is open.
    - **`date-notice`:** `upsertHkCalendarRow(…, dateStatus: 'confirmed', timing, timingSource: 'sec-notice')`.
    - Always: `markSecSeen`.
  - `class HkSecWatch`:
    - Constructor: `(ctx: HkJobContext, http: Http, onReleased: (ids: number[]) => void)`.
    - `start()`: self-rescheduling timer, 2 s / 30 s cadence per Ruling 11.
    - `stop()`.
    - `tick(): Promise<number[]>`: feed through `createFailover` name `sec-6k-feed`. Only items whose CIK (from the index URL, as `cikOf` in `secWatch.ts`) is in the CIK → code map built from `hkStocks(db)` (full level) and not `secSeen` are handled, one at a time.
    - `onUsFeed(items: SecFeedItem[]): void`: 8-K items with `2.02` for full-level CIKs (YUMC, ONC) go to `handleHkFiling`.
  - `sweepHkSec(ctx: HkJobContext): Promise<number[]>`
    - For full-level stocks with a report in [today−5, today+30], call `fetchEarningsFilings` for the CIK.
    - Filings dated ≥ today−10 that are not seen get `acceptedAt` from `fetchAcceptance` (ET wall clock → ISO via luxon `ET`), then go through `handleHkFiling`.
  - `class HkPrices`:
    - Constructor: `(db: DatabaseSync, deps: { quote: (yahooSymbol: string) => Promise<{ price: number; prevClose: number; time: number }>; index: (yahooSymbol: string) => Promise<IndexQuote> }, publishPrices: (p: Record<string, HkLivePriceDto>) => void, publishIndices: (m: HkMarketDto[]) => void, now: () => number = Date.now)`.
    - `setVisible(userId: string, codes: string[]): void` (2-min TTL, like `LivePrices`).
    - `refresh(): void`: re-picks the symbol set and polls it now.
    - `start()`: a 15 s tick. Indices every tick in session. Stocks: one round of (visible ∪ watched ∪ reporting today/tomorrow), at most once per 60 s in session (Ruling 12), every 15 min outside it.
    - `snapshot(): Record<string, HkLivePriceDto>`, `indices(): HkMarketDto[]`, `stop()`.
    - It publishes only changed prices.
  - `HK_CRONS`. Timezone `Asia/Hong_Kong` unless marked ET:
    - `stocks: '0 7 * * 1'`
    - `calendar: '*/30 * * * *'`
    - `estimates: '10 * * * *'`
    - `results: '15,45 * * * *'`
    - `secSweep: '20,50 * * * *'`
    - `prevMoves: '30 1 * * *'`
    - `movesSnapshot: '20 16 * * 1-5'` (ET)
    - `liveMoves: '* 9-15 * * 1-5'` (ET)
  - `startHkScheduler(ctx: HkJobContext, job: JobRunner, hooks: { onResults?: (ids: number[]) => void; onMoves?: (ids: number[]) => void } = {}): void`
  - `warmUpHk(ctx: HkJobContext, job: JobRunner): Promise<void>`: stocks → calendar → results → secSweep → estimates → prevMoves. Job names are prefixed `hk-`.
- **`index.ts` wiring.** Do not run the server; tests and typecheck only.
  - Build `hkCtx` with:
    - `yahoo: createYahooHkFetcher()`
    - `yahooPastDates: yahooHkPastDates`
    - `yahooCloses: (s, f, t) => fetchYahooDailyCloses(yahoo, s, f, t, HKT)`
    - `optionChain: (adr) => sources.optionChain(adr)` (shared Cboe limiter)
    - `secHttp: sources.secHttp ?? null`
  - `hkPrices = new HkPrices(db, { quote: (s) => fetchStockQuote(yahoo, s), index: (s) => fetchIndexQuote(yahoo, s) }, (p) => live.publish('hk-prices', { prices: p }), (m) => live.publish('hk-indices', { indices: m }))`.
  - `buildServer(..., { hk: { prices: () => hkPrices.snapshot(), indices: () => hkPrices.indices(), indexQuote: (s) => fetchIndexQuote(yahoo, s), setVisible: (u, c) => hkPrices.setVisible(u, c) } })`.
  - `startSymbolRefresh` gets `HK: async () => hkEntries(db)`.
  - `onWatchAdded` for `'HK'` → `hkPrices.refresh()`.
  - When `secHttp` is set:
    - `const hkWatch = new HkSecWatch(hkCtx, secHttp, (ids) => live.publish('hk-results', { ids }))`.
    - Pass `(items) => hkWatch.onUsFeed(items)` as the 5th argument of the existing `new SecWatch(...)`.
    - Call `hkWatch.start()`.
  - `startHkScheduler(hkCtx, job, { onResults: (ids) => live.publish('hk-results', { ids }), onMoves: (ids) => live.publish('hk-moves', { ids }) })`.
  - `void warmUpHk(hkCtx, job)`.
  - `hkPrices.start()`.

- [ ] **Step 1: Write failing tests.**
  - `hkSecWatch.test.ts` (stub `Http` serving the Task 6 fixtures):
    - `'a results 6-K for a full-level CIK flips the matching period row and sets releasedAt'`
    - `'a 6-K for a non-universe CIK fetches nothing'` (asserts requested URLs)
    - `'a release for another period never flips today's row'` (Review Focus 2)
    - `'a date notice confirms the date and sets timing'`
    - `'acceptance at 19:30 HKT never sets AMC'` (Review Focus 3): timing stays `UNKNOWN`, `releasedAt` equals acceptance
    - `'gate closed: flipped but no actuals stored'` / `'gate open: actuals stored with currency and basis'` (pass `gates` explicitly)
    - `'seen accessions are skipped by the sweep'`
    - `'8-K 2.02 for YUMC via onUsFeed flips the YUMC row'`
    - `'feed cadence: 2 s when a full-level report is due within HK today−1..+3, else 30 s'` (fake timers)
  - `hkPrices.test.ts`:
    - `'polls visible ∪ watched ∪ reporting codes and publishes only changes'`
    - `'outside the HK session stocks poll every 15 min'` (fake clock)
    - `'index failure keeps the last value'`
  - `scheduler.test.ts`: `'warm-up runs jobs in order and survives a failing source'`
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement** the four modules and the `index.ts` wiring.
- [ ] **Step 4: Run** the full server suite and `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(hk): 6-K watcher and sweep, delayed prices, scheduler and server wiring`.

### Task 12: Web plumbing for market `'HK'`

**Files:**
- Modify (every web place that enumerates `'US' | 'IN'`):
  - `web/src/lib/market.ts`: `Market = 'US' | 'IN' | 'HK'`; `getStoredMarket` accepts `'HK'`
  - `web/src/hooks/useMarket.ts`: accepts `body.market === 'HK'`
  - `web/src/components/Header.tsx`: third button `id="market-hk"` labelled `Hong Kong`, `aria-pressed`; search placeholder for HK `Find a code or company`; the cap filter stays US-only
  - `web/src/api.ts`:
    - `fetchReport(market: Market, id)` → `/api/hk/earnings/:id` for HK.
    - `fetchWatchlist`, `watchUrl`, `putWatch`, `deleteWatch`, `searchSymbols`, `fetchWatchRows` typed `Market`.
    - New `fetchHkEarnings(p: { from; to; q }, signal)` and `fetchHkPrices()`.
    - Re-export `HkReportDto`, `HkEarningsResponse`, `HkLivePriceDto`, `HkMarketDto`, `HkAdminDto`.
  - `web/src/hooks/useLiveResults.ts`:
    - New `export interface HongKongLive { onIds?; onMoves?; onPrices?: (p: Record<string, HkLivePriceDto>) => void; onIndices?: (m: HkMarketDto[]) => void }`.
    - A 6th parameter `hk?: HongKongLive` (appended, so existing callers are unchanged).
    - Dispatch `hk-results`, `hk-moves`, `hk-prices`, `hk-indices`, and add them to the EventSource event list.
  - `web/src/hooks/useVisibleSymbols.ts`: `useVisibleSymbols(enabled: boolean, market: 'US' | 'HK' = 'US')` sends `{ market, symbols }`
  - `web/src/components/WatchlistView.tsx`:
    - `today(market)` handles HK (`Asia/Hong_Kong`).
    - Price lookup `prices[r.symbol]` for HK.
    - HK money via `formatHkPrice`.
    - `Latest` uses `formatHkEps` / `formatHkMoney` with the row's currency.
  - `web/src/lib/liveCap.ts`: add `todayHkt()`
  - `web/src/components/Calendar.tsx`:
    - `today` per market (`todayHkt` for HK; HK defaults to the week view like India).
    - `pending` / `shown` become `Record<Market, Set<number>>` and `patch` / `queue` / `flash` take `Market`.
    - New state `hkLoad`, `hkPrices`, `hkIndices`.
    - HK data effect via `fetchHkEarnings`.
    - Pass the `hk` group to `useLiveResults`, and refetch HK prices on reconnect.
    - `useVisibleSymbols(market !== 'IN', market === 'HK' ? 'HK' : 'US')`.
    - Render branches for HK (loading / error / list).
    - Footer: `Data from SEC EDGAR, Cboe (delayed) and Yahoo Finance (delayed ~15 min). Times in HKT. Prototype, not trading advice.`
- Test: `web/test/HkPlumbing.test.tsx`, `web/test/useLiveResults.test.tsx` (add case), `web/test/storage.test.ts` / `App.test.tsx` (as needed)

**Interfaces:**
- Consumes: the server types from Task 3 (type-only).
- Produces: `Market` (web), `HongKongLive`, `fetchHkEarnings`, `fetchHkPrices`, `useVisibleSymbols(enabled, market)`. Task 13 provides `HkStockList` and `HongKongMarketBar`. Until then Calendar renders a plain `<p className="muted">` placeholder for HK rows, replaced in Task 13.

- [ ] **Step 1: Write failing tests.**
  - `HkPlumbing.test.tsx`:
    - `'Hong Kong button switches market and PUTs prefs'`: click `#market-hk` → `fetch` called with `/api/prefs` and body `{"market":"HK"}`, and `/api/hk/earnings?` requested
    - `'stored HK market is restored'`: `localStorage.market = 'HK'` → `#market-hk` has `aria-pressed="true"`
  - `useLiveResults.test.tsx`: `'hk-results and hk-prices reach the hk group'`
- [ ] **Step 2: Run** `npx vitest run test/HkPlumbing.test.tsx test/useLiveResults.test.tsx` in `web/`. Expected: FAIL.
- [ ] **Step 3: Implement** the modifications listed under Files.
- [ ] **Step 4: Run** `npm test` and `npx tsc --noEmit` in `web/`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): Hong Kong market switch, API client and live events`.

### Task 13: Web HK list, markets strip, money formats, status and admin

**Files:**
- Create:
  - `web/src/components/listParts.tsx`: `Result` and `byDate` moved out of `InStockList.tsx` unchanged. `Result` gains an optional `source?: 'Yahoo' | null` tag rendered as `<span className="muted"> · from Yahoo</span>`.
  - `web/src/components/HkStockList.tsx`
- Modify:
  - `web/src/components/InStockList.tsx`: import `Result` / `byDate` from `listParts` (no visual change)
  - `web/src/components/MarketBar.tsx`: add `HongKongMarketBar({ live }: { live?: HkMarketDto[] })`, which polls `/api/hk/markets` every 15 s, merges live pushes by `index`, labels the exchange `HKEX` and adds `· delayed` after each index name
  - `web/src/lib/format.ts`: add `formatHkMoney`, `formatHkEps`, `formatHkPrice`
  - `web/src/components/Calendar.tsx`: replace the Task 12 placeholder with `HkStockList` and `HongKongMarketBar`
  - `web/src/components/StatusPage.tsx`: `<CoverageTable market="Hong Kong" rows={data.coverage.HK} />`
  - `web/src/adminApi.ts`: `fetchHkAdmin(): Promise<Result<HkAdminDto>>`
  - `web/src/components/AdminPage.tsx`: read-only `HongKongPanel` with:
    - "Full level N · Basic level M"
    - "SEC access: configured / not configured (set SEC_USER_AGENT)"
    - "6-K reader: on / off until 20 releases are read exactly right"
    - "Last 6-K seen: <when>"
  - `web/src/styles.css`: `.basic-tag` (small muted pill, no accent stripe) and `.delayed`
- Test: `web/test/HkStockList.test.tsx`, `web/test/format.test.ts` (add cases), `web/test/MarketBar.test.tsx`, `web/test/StatusPage.test.tsx`, `web/test/AdminPage.test.tsx`, `web/test/InStockList.test.tsx` (unchanged, must pass)

**Interfaces:**
- Consumes: `HkReportDto`, `HkLivePriceDto`, `HkMarketDto`, `HkAdminDto`, `Note`, `SortKey`, `sortRows`, `NoteEditor`, `Star`, `Tags`.
- Produces:
  - Formatters:
    - `formatHkMoney(n: number | null, currency: string | null): string`: prefixes `CNY`→`RMB¥`, `USD`→`US$`, `HKD`→`HK$`; otherwise `` `${currency} ` ``. Compact like `formatUsd` (`RMB¥247.7B`). `—` for null.
    - `formatHkEps(n: number | null, currency: string | null): string` → `RMB¥1.10`, `−US$0.05`.
    - `formatHkPrice(n: number): string` → `HK$612.50`.
  - `hkKey(code: string) => \`HK:${code}\``
  - `HkStockList(props)`: same props as `InStockList`, with `rows: HkReportDto[]` and `prices?: Record<string, HkLivePriceDto>`.
  - **Row head:**
    - dot, code, name
    - `Basic data` tag when `level === 'basic'` (title: "Only Yahoo data is available for this stock: no SEC results or option data")
    - price `HK$x` + change + `<span className="delayed">Delayed</span>`
    - timing text
    - `data-symbol={code}`
  - **Details lines:**
    - Stock: `code name · HKEX`, plus `· ADR BABA (1 ADS = 8 shares)` for full level
    - Result date + status: "confirmed by SEC 6-K notice" or "estimated"
    - Period label
    - Release: time in HKT + your time, `· SEC 6-K` link to `secDocUrl`
    - Sector
    - Market cap: `formatHkMoney(cap, 'HKD')` as of date
    - EPS estimate / actual:
      - each side with its own currency
      - `· per ADS` when `epsBasis === 'ads'`
      - `· from Yahoo` when `actualSource === 'yahoo'`
      - `* different currency or basis from the estimate: not compared` when both numbers exist and `result == null`
    - Revenue estimate / actual: same rules
    - Expected move:
      - `≈` when not final
      - `· from ADR options, US$ straddle at {strike}, expiry {date} (delayed)`
      - basic level: `— (no options data)`
    - Live expected move
    - Previous move: with the assumed note
    - Price: `HK$x · delayed ~15 min (Yahoo), {time}`
    - NoteEditor

- [ ] **Step 1: Write failing tests.**
  - `format.test.ts`:
    - `formatHkMoney(247_652_000_000, 'CNY') === 'RMB¥247.7B'`
    - `formatHkMoney(3.2e12, 'HKD') === 'HK$3.20T'`
    - `formatHkEps(-0.05, 'USD') === '−US$0.05'`
    - `formatHkPrice(612.5) === 'HK$612.50'`
  - `HkStockList.test.tsx`:
    - `'basic rows show the Basic data tag, full rows do not'`
    - `'price shows Delayed'`
    - `'every money value shows its currency'`: an RMB actual and an HKD estimate both render with their prefixes, and there is no beat/miss class
    - `'per ADS label and from Yahoo tag'`
    - `'provisional expected move shows ≈ and the ADR'`
    - `'expanded key is HK:<code>'`
  - `MarketBar.test.tsx`: `'HK strip shows Hang Seng, HS China Enterprises, HS Tech with delayed label'`
  - `StatusPage.test.tsx`: `'Hong Kong coverage table renders'`
  - `AdminPage.test.tsx`: `'Hong Kong panel shows reader off and SEC configured'`
- [ ] **Step 2: Run** them in `web/`. Expected: FAIL.
- [ ] **Step 3: Implement** the extraction of `listParts.tsx` first and confirm `InStockList.test.tsx` still passes. Then implement `HkStockList`, the formatters, the strip, the status table and the admin panel.
- [ ] **Step 4: Run** `npm test` and `npx tsc --noEmit` in `web/`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): Hong Kong list with Basic data tag, delayed prices, currencies, HK strip, status and admin`.

### Task 14: Live spot-check and full verification

**Files:**
- Create: `server/src/cli/hkSpotCheck.ts`
- Modify: `server/package.json` (`"hk-spot-check": "tsx src/cli/hkSpotCheck.ts"`)

**Interfaces:**
- `hkSpotCheck.ts --db <copy.db> [--codes 9988,0005,9618,9999,2378,0700,1299,0941,2318,1810]`
  - It requires `--db` and refuses `config.dbPath`.
  - It runs `warmUpHk` once against the copy with a real `HkJobContext`: Yahoo, the shared-style SEC client at 120 ms, and Cboe at 2500 ms. Nothing else runs: no prices, no watchers, no Kite.
  - Then, per code, it prints:
    - level, ADR, period label, report date + status, timing + source
    - estimates + currency, actuals + currency/basis/source
    - market cap HK$
    - expected move (final/provisional, expiry)
    - previous move
    - Yahoo price now
    - the latest SEC 6-K index URL (full level)

- [ ] **Step 1: Copy the database** to the scratchpad: `copy data\earnings.db %TEMP%\hk-check.db`. The production server keeps running untouched.
- [ ] **Step 2: Run** `npm run hk-spot-check -w server -- --db %TEMP%\hk-check.db` with `SEC_USER_AGENT` set.
- [ ] **Step 3: Compare by hand.** Use 5 full-level names (9988, 0005, 9618, 9999, 2378) and 5 basic names (0700, 1299, 0941, 2318, 1810), against:
  - the issuer's SEC filings on EDGAR (full level)
  - Yahoo Finance quote pages for `.HK`
  - the Cboe delayed quotes page for the ADR

  Never open hkex.com.hk / hkexnews.hk. Record each field as match / blank / wrong in the commit body. Any **wrong** value is a bug: fix it test-first in the owning task's module before continuing. A blank is acceptable only where the spec says blank.
- [ ] **Step 4: Run the full verification.**
  - In `server/`: `npm test` and `npx tsc --noEmit`.
  - In `web/`: `npm test` and `npx tsc --noEmit`.
  - Then `npm run coverage-check -w server -- --db %TEMP%\hk-check.db`.

  Expected: all tests pass (575+ server, 118+ web), no type errors, and HK coverage rows printed.
- [ ] **Step 5: Commit** `chore(hk): live spot-check script and results`. The body has the spot-check table.
