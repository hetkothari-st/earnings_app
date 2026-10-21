# India Earnings Calendar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an India (NSE F&O stocks) earnings calendar to the existing app behind a US / India switch, with NSE-filing dates, timings and actuals, Yahoo estimates, and Zerodha Kite prices, expected move and previous move.

**Architecture:** All India code lives in `server/src/india/` (sources, domain, db, jobs, api, live). It reuses the shared plumbing (Http, Broadcaster, PriceBook, auth, notes, job runner) and adds its own tables (`in_*`) inside the same SQLite file. The web app gets a `market` prop on `Calendar`/`StockList`/`Header`; India rows use the same `ReportDto` shape plus a few optional fields.

**Tech Stack:** Node 24, TypeScript (NodeNext, strict), Fastify 5, node:sqlite, zod 4, luxon, node-cron, Vitest; React 19 + Vite + Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-15-india-earnings-design.md` (read it first). Verified source formats: this plan's "Source facts" section (fetched live 2026-10-15).

## Global Constraints

- No scraping of nseindia.com pages or its `/api/` endpoints, and nothing from bseindia.com. Allowed hosts: `nsearchives.nseindia.com` (RSS feeds, files they link, `content/fo/fo_mktlots.csv`), `api.kite.trade`, `ws.kite.trade`, `kite.zerodha.com` (login only), Yahoo (`fc.yahoo.com`, `query1/query2.finance.yahoo.com`).
- Data must be accurate; nothing guessed; uncertainty is flagged or the field stays `null`/"—". Never overwrite a stored value with a blank.
- Kite credentials only from env vars `KITE_API_KEY`, `KITE_API_SECRET`, `KITE_USER_ID`, `KITE_PASSWORD`, `KITE_TOTP_SECRET`; never stored in the DB, logged, or returned by any endpoint. Access token in memory only. No order-placing code anywhere.
- Times: IST (`Asia/Kolkata`); NSE regular session 09:15–15:30. Timing: `BMO` < 09:15, `DMH` 09:15–15:30 inclusive, `AMC` > 15:30.
- Money stored in full rupees (as in the filings); shown as `₹… Cr` (rupees / 1e7, en-IN grouping). EPS shown as `₹x.xx`.
- Style: dark theme, Archivo, no colored left/top accent stripes, no all-caps labels; session shown by dots.
- TDD: write the test, watch it fail, implement, watch it pass. Full suite (`npm test`) + typecheck (`npx tsc --noEmit -p server`, `npm run build -w web`) before every commit.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Server imports use `.js` extensions (NodeNext). Web imports server types via `../../server/src/api/types`.

## Source facts (verified live 2026-10-15; fixtures saved)

Fixture source dir (copy in Task 1): `C:\Users\ST269\AppData\Local\Temp\claude\C--Users-ST269-Desktop-earnings-app\98aceeb0-672e-406c-9a8e-dc8a6a0a932e\scratchpad\india\`.

- RSS base `https://nsearchives.nseindia.com/content/RSS/`. Items: `<title>` company name (may carry trailing whitespace/newline), `<link>`, `<description>`, `<pubDate>` `DD-Mon-YYYY HH:MM:SS` in IST without offset. Feeds are rolling windows (today only) → poll and store.
  - `Board_Meetings.xml`: description `"<Purpose> |Meeting Date: DD-Mon-YYYY"`. Links are either PDFs `/corporate/<UPLOADER>_<DDMMYYYYHHMMSS>_<x>.pdf` (prefix usually, not always, the NSE symbol) or XBRL `/corporate/xbrl/PRIOR_INTIMATION_<n>_WebXMLFile_<...>.xml` (purpose "Board Meeting Intimation"; XML has `NSESymbol`, `DateOfProposedMeeting`, `Agenda1..n`, `MonthOfPeriodEnded`, `YearOfPeriodEnded`).
  - `Online_announcements.xml`: description `"<text> |SUBJECT: <subject>"`; subjects of interest `Outcome of Board Meeting`, `Financial Results Updates`.
  - `Integrated_Filing.xml` (the live results feed; `Financial_Results.xml` is stale since Mar-2025): link `https://nsearchives.nseindia.com/corporate/INTEGRATED_FILING_<TYPE>_<id>_<ts>_WEB.xml|<pdf|null|>`; real file is at `/corporate/xbrl/INTEGRATED_FILING_...`; available ~15–20 min after pubDate (404 before). Description `Integrated Filing- Financials|Original|` or `...|Revision|...`.
  - A missing feed can return HTTP 200 with an HTML page → reject bodies without `<rss`.
- Integrated filing XBRL (`in-capmkt` prefix): context `OneD` = current quarter (no `xbrli:scenario`), `FourD` = year to date. Facts on `OneD`: `Symbol`, `NameOfTheCompany` (banks `NameOfBank`), `DateOfStartOfReportingPeriod`, `DateOfEndOfReportingPeriod`, `NatureOfReportStandaloneConsolidated` (`Standalone`/`Consolidated`), `DateOfBoardMeetingWhenFinancialResultsWereApproved`. Ind AS: `RevenueFromOperations`, `ProfitLossForPeriod`, `BasicEarningsLossPerShareFromContinuingAndDiscontinuedOperations`. Banking: `InterestEarned`, `Income`, `ProfitLossForThePeriod`, `BasicEarningsPerShareAfterExtraordinaryItems`; no `RevenueFromOperations`. Money in absolute rupees (`unitRef="INR"`), EPS `unitRef="INRPerShare"`. NBFC format unverified.
- `https://nsearchives.nseindia.com/content/fo/fo_mktlots.csv`: space-padded CSV; 6 index rows, then row starting `Derivatives on Individual Securities`, then 213 stocks; column 0 name (truncated), column 1 symbol.
- Kite: instruments CSV `https://api.kite.trade/instruments/<EXCHANGE>` (no auth). Columns `instrument_token,exchange_token,tradingsymbol,name,last_price,expiry,strike,tick_size,lot_size,instrument_type,segment,exchange`. Options: `segment=NFO-OPT`, `name=<symbol>`, `instrument_type` `CE`/`PE`. Monthly stock expiry = last Tuesday (moved to the previous trading day on holidays, e.g. 2026-11-23). REST headers `X-Kite-Version: 3`, `Authorization: token <api_key>:<access_token>`. `/quote?i=NSE:RELIANCE&i=NFO:...` ≤500 keys, 1 req/s; response `{status, data: {"NSE:X": {instrument_token, last_price, ohlc:{close}, depth:{buy:[{price,quantity}], sell:[...]}, timestamp}}}`. `/instruments/historical/<token>/day?from=YYYY-MM-DD+00:00:00&to=...` → `data.candles: [[ "2026-10-14T00:00:00+0530", o,h,l,c,v ]]`, 3 req/s. Session: `POST https://api.kite.trade/session/token` form `api_key, request_token, checksum=sha256(api_key+request_token+api_secret)` → `data.access_token`. WebSocket `wss://ws.kite.trade?api_key=&access_token=`; send `{"a":"subscribe","v":[tokens]}`, `{"a":"mode","v":["full",[tokens]]}`; binary frame = int16 count, then (int16 len, packet)*; int32 big-endian; prices in paise (/100). Tradable packet: 0 token, 4 LTP, 40 close (len ≥ 44), 44 last-trade epoch seconds (len 184). Index packet (token & 0xff === 9): 0 token, 4 LTP, 20 close (len ≥ 28). 1-byte frames are heartbeats.
- Unofficial login: `POST https://kite.zerodha.com/api/login` form `user_id,password` → `data.request_id, data.twofa_type`; `POST https://kite.zerodha.com/api/twofa` form `user_id, request_id, twofa_value, twofa_type` (sets cookies); `GET https://kite.zerodha.com/connect/login?v=3&api_key=<key>` with cookies, follow `Location` hops manually until one contains `request_token=`.
- Kite index tokens: NIFTY 50 `256265`, SENSEX `265`, NIFTY BANK `260105`, NIFTY MIDCAP 100 `256777`. Yahoo: `^NSEI`, `^BSESN`, `^NSEBANK`, `NIFTY_MIDCAP_100.NS`; stocks `<SYMBOL>.NS` (URL-encode `&`).
- Yahoo past result dates: `POST https://query1.finance.yahoo.com/v1/finance/visualization?crumb=` body `{size, offset:0, sortField:'startdatetime', sortType:'DESC', entityIdType:'earnings', includeFields:['ticker','startdatetime','startdatetimetype'], query:{operator:'eq', operands:['ticker','RELIANCE.NS']}}` → `finance.result[0].documents[0].rows: [["RELIANCE.NS","2025-04-25T14:31:00.000Z","TAS"],...]`. Coverage is stale for many stocks (RELIANCE latest 2025-04).
- NSE 2026 trading holidays (weekdays): 01-15, 01-26, 03-03, 03-26, 03-31, 04-03, 04-14, 05-01, 05-28, 06-26, 09-14, 10-02, 10-20, 11-10, 11-24, 12-25. 2027 list not yet published.

## Rulings (decisions where the spec is silent or facts differ)

1. `Financial_Results.xml` is stale → results come from `Integrated_Filing.xml` (+ `/xbrl/` path fix, retries for the 15–20 min lag).
2. Notes: India report ids start at `1_000_000_001` so they never collide with US ids; the `notes` table needs no `market` column (spec said "market column"; disjoint ids achieve the same).
3. Banks: revenue actual = `Income` (total income), `revenueKind = 'total-income'`; no revenue beat/miss colour for them.
4. Previous move: prior result date/time from our own stored filings, else Yahoo past dates (TAS rows only). Many will stay "—" this season (Yahoo stale); fills as the app captures results.
5. 2027 holidays unpublished → weekends-only for 2027 plus a `nse-holidays` source error so the status page shows it.
6. India day view hides the US `SessionBand` (its axis is US-specific).
7. Expected-move "close" snapshot runs at 15:25 IST (Kite depth is empty after the close).
8. `MAX_SYMBOL_LEN` for the expanded list rises 12 → 24 (`IN:BAJAJ-AUTO` is 13).
9. Timing = earliest of: Online_announcements item (subject `Outcome of Board Meeting` or `Financial Results Updates`, text mentioning financial results) and the Integrated_Filing financials item, for that symbol on that day.
10. Test fixtures for India are files under `server/test/fixtures/india/` (the US tests inline them; XML is too long to inline).
11. Yahoo crumb session is extracted into an exported helper reused by US and India.
12. Market preference stored server-side in a new `user_prefs` table (`GET/PUT /api/prefs`).
13. Quarter for a PDF board-meeting notice = latest quarter end (Mar 31/Jun 30/Sep 30/Dec 31) strictly before the meeting date.

## Review Focus

1. Same company filed twice (PDF + XBRL notice, or Standalone + Consolidated results): one report row; consolidated actuals win and are never replaced by standalone.
2. A late filing for an older quarter (period end ≠ current quarter): must update only the row with matching `quarter_end`, never today's row.
3. Kite session missing/expired: all Kite-dependent jobs skip quietly (no crash, no blanking), prices/expected move show "—".
4. Company name ↔ symbol mismatch (`GAIL (India) Limited` vs Kite `GAIL (INDIA)`; `&` in `M&M`): matcher must find the F&O symbol or skip, never map to a wrong symbol.
5. RSS body is an HTML error page or truncated XML: parser throws `SourceFormatError`, job records the error, stored data untouched.

Each line above has a pinning test in the owning task (Tasks 3, 4, 6, 8, 12, 13).

---

## File map

Server (create):
- `server/src/india/domain/nseCalendar.ts` — IST date helpers, holidays, timing from time.
- `server/src/india/domain/quarter.ts` — quarter-end logic.
- `server/src/india/domain/inMoves.ts` — expected move from Kite quotes; reaction move from candles.
- `server/src/india/sources/totp.ts` — RFC 6238.
- `server/src/india/sources/nseRss.ts` — RSS + link helpers.
- `server/src/india/sources/xbrl.ts` — prior-intimation and integrated-filing parsers.
- `server/src/india/sources/foList.ts` — F&O list CSV + Kite instruments CSV.
- `server/src/india/sources/symbolMatch.ts` — company name → symbol.
- `server/src/india/sources/kiteLogin.ts` — automated login + session holder.
- `server/src/india/sources/kiteApi.ts` — REST client.
- `server/src/india/sources/kiteStream.ts` — WebSocket + binary parser.
- `server/src/india/sources/yahooIn.ts` — `.NS` summary + past dates.
- `server/src/india/db/schema.ts`, `server/src/india/db/inRepo.ts`.
- `server/src/india/jobs/context.ts`, `stocks.ts`, `calendar.ts`, `results.ts`, `moves.ts`, `prevMoves.ts`, `scheduler.ts`.
- `server/src/india/live/inPrices.ts`.
- `server/src/india/api/dto.ts`, `server/src/india/api/routes.ts`.
- `server/src/auth/prefs.ts`.

Server (modify): `db/repo.ts` (append India schema), `sources/yahooEarnings.ts` (export session), `api/types.ts` (optional India fields), `notes/store.ts` + `notes/routes.ts` (India deadline/lookup), `auth/routes.ts` (symbol length), `auth/adminRoutes.ts` (Kite status), `config.ts`, `index.ts`.

Web (create): `web/src/hooks/useMarket.ts`, `web/src/lib/market.ts`. Web (modify): `api.ts`, `App.tsx`, `components/Header.tsx`, `components/Calendar.tsx`, `components/StockList.tsx`, `components/MarketBar.tsx`, `components/AdminPage.tsx`, `lib/format.ts`, `styles.css`.

## Status (2026-10-21)

Built and tested (server `test/india/*`, web `test/InStockList.test.tsx`): F&O universe (`in_stocks`), calendar from Board_Meetings
(PDF + XBRL, results purpose only, F&O only, reschedules), results from Integrated_Filing (OneD quarter facts only, consolidated wins,
non-blocking retry for the 15–20 min lag), timing = earliest NSE announcement/filing, Yahoo sector/market cap/quarterly estimates and
estimated dates, Kite login (07:45 IST, 3 tries) + admin status / "Log in now", Kite quotes → expected move (15:25 IST, final vs
provisional) and live expected move, Kite ticker prices + India markets strip (Yahoo fallback), previous move from captured reports,
India notes, `IN:` expanded keys, ids from 1_000_000_001 (old rows migrated), 2027-holiday warning on the status page.

Not done / unverified:
- Kite-dependent paths are tested with fixtures only; not run against a live Kite session (no credentials here).
- Previous move has no Yahoo past-dates fallback yet (ruling 4): fills as the app captures results.
- NBFC integrated-filing format unverified; revenue stays null if `RevenueFromOperations` is absent.

