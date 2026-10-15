# US Earnings Calendar — Design Spec

Date: 2026-10-15
Status: Draft for review

## 1. Purpose

A web app for traders outside the US (primarily India) that shows which US-listed companies report quarterly earnings when, whether before market open (BMO) or after market close (AMC), the release moment in US Eastern time and in the user's local time, and the key numbers around each report: market cap, primary exchange, options-implied expected move, and results versus estimates.

Accuracy is the top priority. The app never guesses: missing or conflicting data is shown as "—" or flagged with ⚠, and every stored value records its source and fetch time.

This is a prototype for a client demo. It uses free data sources only. If the client approves, data sources are upgraded to licensed feeds (Approach 1, section 10) by swapping source modules.

## 2. Users and scope

- Now: the owner only (personal use). Later: a small private group.
- Platform: web app (desktop and phone browsers). A mobile app is a later phase and will reuse the same backend API.
- Universe: all US-listed stocks in the Nasdaq earnings calendar, including ADRs (e.g. TSM, ASML). A market-cap filter defaults to ≥ $2B and is user-adjustable down to "all".
- Time range: 2 years of history, plus forward as far as dates are published (typically about 3 months).

### Out of scope for v1

- Mobile app
- Paid data sources
- True highest-volume trading venue (see section 6.4)
- Login (deferred to the final phase, section 9)
- Alerts and notifications

## 3. Architecture

```
Browser (React web app) --HTTP/JSON--> Backend API (Node + TypeScript)
                                          |
                                          +-- SQLite database (cache + history)
                                          +-- Scheduled data jobs
                                                +-- nasdaqSource   calendar, BMO/AMC, market cap, EPS estimate/actual
                                                +-- finnhubSource  revenue estimate/actual
                                                +-- secSource      primary exchange, 8-K link, 8-K acceptance timestamp
                                                +-- cboeSource     delayed options chain -> expected move
```

Principles:

- Only the backend fetches external data. The browser talks only to our API. This avoids rate-limit and blocking problems, keeps API keys server-side, and lets the future mobile app reuse the API.
- All data is stored in the database. Viewing any range (day, week, month, quarter, custom) is a database query, never a live call to a source.
- Each source is one module implementing a common interface (e.g. `CalendarSource`, `ResultsSource`, `OptionsSource`, `FilingsSource`). Upgrading to paid sources means adding new modules and switching configuration; the rest of the app does not change.

Stack:

- TypeScript throughout
- Backend: Fastify, SQLite via Node's built-in `node:sqlite` (no native build step on Windows) with plain SQL, node-cron for scheduling
- Frontend: React + Vite
- Time handling: Luxon (IANA time zones, DST-correct)
- Tests: Vitest
- Runs locally for now. Hosting is decided before the client demo.

## 4. Data sources (free tier)

All of these were tested on 2026-10-15 and returned live data, except Finnhub (needs a free API key, not yet tested).

| Need | Source | Notes |
|---|---|---|
| Earnings dates, BMO/AMC, market cap, EPS consensus, # of estimates | Nasdaq calendar JSON (`api.nasdaq.com/api/calendar/earnings?date=YYYY-MM-DD`) | Unofficial endpoint used by nasdaq.com. Timing values: `time-pre-market`, `time-after-hours`, `time-not-supplied`. |
| Past EPS: actual, consensus, surprise % | Nasdaq earnings-surprise JSON (`api.nasdaq.com/api/company/{SYMBOL}/earnings-surprise`) | Unofficial. |
| Revenue estimate and actual | Finnhub free tier earnings calendar | Free API key. 60 requests/min. |
| Primary listing exchange | SEC `company_tickers_exchange.json` | Official. Requires a descriptive User-Agent. |
| Release verification, official press release link | SEC EDGAR submissions API; 8-K filings with Item 2.02, Exhibit 99.1 | Official. Max 10 requests/sec. |
| Options chain for expected move | Cboe delayed quotes JSON (`cdn.cboe.com/api/global/delayed_quotes/options/{SYMBOL}.json`) | Unofficial, 15-min delayed. Follow redirects. |

### Known limitations of the free stack (accepted)

1. Primary listing exchange is shown instead of the highest-volume venue. No free per-venue volume data exists.
2. No exact release minute. Only BMO/AMC, shown as "before 9:30 AM ET" or "after 4:00 PM ET". For past reports, the SEC filing timestamp verifies the label.
3. Expected move is our own calculation from delayed quotes, not a published vendor figure.
4. The Nasdaq and Cboe endpoints are unofficial: undocumented, no uptime guarantee, may change, and their terms likely do not permit commercial use. Acceptable for the prototype. Switch to Approach 1 before paying users.

### Findings from live data checks (2026-10-15), which shape the rules below

5. **Nasdaq drops timing for past dates.** For any date that has passed, every row reads `time-not-supplied` (checked 2024-10-15 and 2026-10-13). Consequences:
   - The app captures timing while a report is still upcoming and never overwrites a known timing with "not supplied".
   - For the 2-year backfill, timing comes from Finnhub's `hour` field (`bmo` / `amc` / `dmh`), then from the SEC filing time where that proves it. Otherwise it stays "Time not announced".
6. **Nasdaq market cap is always the current value**, even on past dates (ASML showed the same $662B for 2024-10-15 and 2026-10-14). Market cap is frozen once a report date passes. Backfilled rows are flagged "Market cap is current, not at report time".
7. **An 8-K can be filed after the press release, never before it is public.** The SEC acceptance time is therefore an upper bound on the release time, not the release time itself. Example: JPM's Q3 2026 8-K was accepted at 06:30:38 ET, consistent with its pre-market release. See section 6.6 for which timestamp field to trust.
8. **Cboe only provides the current options chain.** No free historical options data exists, so the expected move is available only for reports snapshotted from launch onward. Backfilled history shows "—".

## 5. Screens

### 5.1 Main screen

Header:

- App title
- Detected time zone, e.g. "Your time zone: IST (Asia/Kolkata)", with a manual override
- Range selector: Day / Week / Month / Quarter / Custom (from–to dates)
- Date navigation: previous / next / Today
- Market-cap filter (default ≥ $2B)
- Ticker/company search
- "Show hidden (N)" toggle

Table columns, in order:

1. Hide checkbox
2. Release (ET): e.g. "BMO · before 9:30 AM" or "AMC · after 4:00 PM"
3. Your time: the same moment in the user's detected zone, e.g. "before 7:00 PM IST". A "+1" marker shows when it falls on the next calendar day in the user's zone.
4. Ticker and company name
5. Exchange
6. Market cap (formatted, e.g. $165.9B, $2.31T)
7. EPS: estimate / actual, with ▲ green for a beat and ▼ red for a miss; surprise % on hover
8. Revenue: estimate / actual, same treatment
9. Expected move (e.g. ±5.1%)

Grouping: rows are grouped by date (sticky date headers), and within each date by BMO, then AMC, then "Time not announced". Week, month, quarter and custom views use the same table across multiple dates.

Results columns show "—" until results are released.

A ⚠ icon appears on any cell whose value is unconfirmed or where sources conflict. Hovering it explains why (e.g. "Date projected, not confirmed by company", "Nasdaq says BMO; SEC filing accepted 10:42 AM ET").

### 5.2 Hide behaviour

- Ticking a row's checkbox hides that ticker everywhere (all dates and views).
- "Show hidden (N)" reveals hidden rows greyed out, so they can be unticked.
- Until login exists, the hide list is stored in the browser (localStorage, with try/catch; the app works if storage is unavailable).

### 5.3 Detail panel

Clicking a row opens a side panel with:

- Fiscal quarter, report date, BMO/AMC, and the SEC filing acceptance time (when available)
- EPS and revenue: estimate, actual, surprise %, number of estimates
- Last year's same-quarter EPS
- Expected-move inputs: expiry used, strike, call/put mid, stock price, snapshot time
- Link to the official press release on SEC EDGAR (8-K Exhibit 99.1)
- Source and fetch time for every value
- Reschedule history, if the date moved

### 5.4 Responsive

At phone width, each row is shown as a card. No horizontal page scroll.

### 5.5 Status page

`/status` shows each source's last successful fetch, last error, and record counts.

## 6. Data rules

### 6.1 Time display

- BMO means "before 9:30 AM ET". AMC means "after 4:00 PM ET".
- On NYSE early-close days, AMC means "after 1:00 PM ET". The app keeps an NYSE holiday and early-close calendar.
- `time-not-supplied` shows "Time not announced" with ⚠. It is never guessed.
- Conversion uses the IANA zone `America/New_York` and the user's zone, evaluated on the specific report date, so DST transitions in either zone are handled correctly. Example: 4:00 PM ET is 1:30 AM IST (next day) during EDT and 2:30 AM IST (next day) during EST.
- The user's zone is read from the browser (`Intl.DateTimeFormat().resolvedOptions().timeZone`). No permission prompt is needed. The user can override it. If detection fails, it falls back to `Asia/Kolkata`.

### 6.2 Expected move (labelled "Options-implied move")

1. **Expiry:** the first listed expiry that captures the earnings reaction. For BMO on day D, that is the first expiry on or after D. For AMC on day D, it is the first expiry strictly after D.
2. **Strike:** the strike closest to the underlying price. Ties go to the lower strike.
3. **Mid:** mid = (bid + ask) / 2 for both the call and the put at that strike.
4. **Move %:** move % = (call mid + put mid) / underlying price × 100.
5. **Snapshot timing:** the last close before the report. For BMO, that is the close of D−1 (previous trading day). For AMC, it is the close of D. The snapshot time is stored and shown.
   - DMH or "time not announced": expiry is the first strictly after D, and the snapshot is taken at the D−1 close. That covers either case.
6. **Guards:**
   - If either bid is 0, or either spread (ask − bid) exceeds 30% of its mid, the value is shown with ⚠ "illiquid".
   - If no options are listed, or no expiry qualifies, show "—".
7. **Disclosure:** the label and tooltip state that this is our straddle-based calculation. It includes some non-earnings time value, so it may read slightly higher than vendor figures.

### 6.3 Results

- EPS actual, consensus and surprise % come from Nasdaq.
- Revenue estimate and actual come from Finnhub.
- Surprise % = (actual − estimate) / |estimate| × 100, rounded to 1 decimal. If the estimate is 0 or missing, show "—".
- Beat: actual > estimate. Miss: actual < estimate. Equal is shown as in-line, with no arrow.

### 6.4 Exchange

- The primary listing exchange comes from the SEC ticker file. If the ticker is not found, show "—".
- In the paid phase, this is replaced by the venue with the highest share volume on the previous full trading day, among registered exchanges only (FINRA TRF/off-exchange excluded). Only the venue name is shown, never the volume.

### 6.5 Market cap

- Comes from the Nasdaq calendar row and is stored with its fetch date. If missing or unparseable, show "—".
- It is refreshed only while the report date is today or later, then frozen.
- If the stored as-of date is after the report date (backfilled rows), the cell shows ⚠ "Market cap is current, not at report time".

### 6.6 SEC cross-check (past reports)

An 8-K is filed at or after the press release, so its acceptance time T is an **upper bound** on the release time. That bound can prove a BMO release, or disprove an AMC label. It can never prove an AMC release.

- Candidate filings come from the SEC submissions API: form `8-K`, items include `2.02`, and `filingDate` is D or the next business day. Use the earliest by acceptance time. If there is none, the timing is unverifiable.
- **The acceptance time T is read from the filing's SGML header** (`.../{accession}.hdr.sgml`, line `<ACCEPTANCE-DATETIME>yyyyMMddHHmmss`), which is ET wall-clock time.
  - Do not use the submissions API's `acceptanceDateTime`. It carries a "Z" suffix but is not UTC.
  - Checked on JPM: header 06:30:38 ET vs API `14:30:38Z` in October, and 06:41:09 vs `16:41:09Z` in January. The gap shifts with DST.
  - Only filings whose T falls on D are used.
- Derive from T on day D:
  - before 9:30 → released before the open (BMO)
  - at or after the session close (16:00, or 13:00 on early-close days) → filed after close
  - otherwise → released by T, during the session
- The label is the timing from Nasdaq or Finnhub. Result:

| Label | T before 9:30 | T during session | T after close |
|---|---|---|---|
| BMO | verified ✓ | unverifiable | unverifiable |
| AMC | contradicted ⚠ | contradicted ⚠ | consistent ≈ |
| DMH | contradicted ⚠ | consistent ≈ | unverifiable |
| Not announced | set to BMO (source: SEC) | unverifiable | unverifiable |

- "Contradicted" shows ⚠ with both values. The label is not auto-changed.
- "Unverifiable" shows no warning. The detail panel shows the SEC acceptance time.
- Store the 8-K document URL and the filing index URL (which lists Exhibit 99.1) for the detail panel.
- The SEC submissions API's `recent` block covers roughly the last 1,000 filings. For very old reports at very active filers, a missing filing means "unverifiable", never "contradicted".

### 6.6a Timing source priority

Use the first available:
1. Nasdaq, captured while the report was upcoming.
2. Finnhub `hour` (`bmo` → BMO, `amc` → AMC, `dmh` → during market hours).
3. SEC-derived BMO (table above).

If Nasdaq and Finnhub disagree, keep Nasdaq's label and flag ⚠ with both values. "DMH" is displayed as "During market hours (9:30 AM–4:00 PM)".

### 6.7 Reschedules

Each calendar refresh compares dates with stored ones. A changed date updates the record, logs the old date, and shows "Rescheduled from <old date>" in the detail panel.

## 7. Scheduled jobs (all times ET)

| Job | Schedule |
|---|---|
| Calendar refresh (today through +90 days) | Every 2 hours |
| Results refresh | Every 30 min, 6:00–10:30 AM and 4:00–8:00 PM on trading days |
| Expected move snapshot | 4:20 PM on trading days, for the next session's BMO reporters and today's AMC reporters |
| SEC sync (exchange file, 8-K verification) | Nightly at 11:00 PM |
| Historical backfill (2 years) | Once, rate-limited, resumable |

## 8. Error handling

- **Source down or blocked:** keep the last good data and show a banner, e.g. "Calendar data last updated 3h ago (Nasdaq unreachable)". A failed fetch never deletes stored data.
- **Format change:** each source module validates response shape (zod schemas). On a mismatch, the job fails loudly in the log and on `/status`, and stored data is untouched.
- **Rate limits:** requests are spaced per source (Finnhub ≤ 60/min, SEC ≤ 10/s, Nasdaq and Cboe conservatively ~1/s). The backfill is resumable.
- **Provenance:** every stored value has `source` and `fetched_at`.

## 9. Login (final phase, deferred)

- **v1:** no login. The hide list is stored in the browser.
- **Final phase:** passkeys (WebAuthn): Face ID, fingerprint or Windows Hello. No password, email, phone or Google. On first login, the browser hide list migrates into the account.
- The data model includes a `user_id` slot on user-owned data from the start.

## 10. Upgrade path (Approach 1, after client approval)

| Need | Paid source |
|---|---|
| Earnings dates, exact times, confirmed flag, estimates, actuals, guidance | Benzinga earnings (price quote needed) |
| Highest-volume venue, market cap, reference data | Massive (formerly Polygon) Stocks Developer, $79/month (individual license; business license needed for group use) |
| Published implied earnings move | ORATS Data API, from $199/month (confirm the `impErnMv` field is in the API) |
| Official release, timing verification | SEC EDGAR (free, unchanged) |

## 11. Testing

- **Unit tests (pure logic):**
  - ET ↔ user-zone conversion across March and November DST transitions (US and other zones), and early-close days
  - Expected-move calculation: expiry selection for BMO vs AMC, strike selection, illiquid guard, missing options
  - Surprise % and beat/miss classification
  - SEC timestamp → BMO / AMC / during-market classification
- **Source module tests:** run against saved real responses (fixtures), including malformed and empty responses.
- **API tests:** range queries (day, week, month, quarter, custom), market-cap filter, search.
- **Acceptance:** manually spot-check about 10 real reports from the current week against the companies' own press releases and SEC filings before declaring v1 done.
