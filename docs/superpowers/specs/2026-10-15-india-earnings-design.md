# India Earnings Calendar — Design

Date: 2026-10-15
Status: approved in conversation, awaiting written-spec review
Builds on: `2026-10-15-earnings-calendar-design.md` (the US app). Everything not stated here behaves as in the US app.

## Purpose

Same purpose as the US calendar: show traders upcoming and just-released quarterly results, with expected move, previous reaction, live price and per-user notes — for Indian stocks. Private use by the client; not for redistribution.

## Decisions (from the user)

- Universe: NSE futures & options (F&O) stocks only, about 200.
- Same app, a US / India switch in the header. One login, same users, same admin page, one Railway service.
- Zerodha Kite Connect (paid "Connect" plan, live data included) supplies prices, option quotes and daily candles.
- Kite login is automated daily with user ID, password and an auto-generated TOTP. The user accepts that Zerodha discourages automated login.
- Data must be accurate; nothing guessed; uncertainty flagged.

## Sources and rules

- No scraping of nseindia.com pages/hidden APIs (NSE terms forbid automated collection) or bseindia.com (BSE disclaimer forbids reproduction/redistribution). Only NSE's published RSS feeds, the company filings they link, NSE's published F&O list file, Yahoo (backup), and Kite.
- Commercial use of the NSE RSS feeds is a grey area; flag to the client before launch (ask NSE, or license from a vendor such as CMOTS / Accord Fintech).

| Field | Source | Rule |
|---|---|---|
| Name, symbol | NSE F&O list (published file), cross-checked with Kite instrument dump (NFO futures underlyings) | Refreshed weekly. NSE symbol (RELIANCE). |
| Sector, market cap | Yahoo `<SYMBOL>.NS` quoteSummary (`price`, `assetProfile`) | Market cap in ₹ crore. Backup source. |
| Result date | NSE `Board_Meetings.xml` RSS (purpose mentions financial results), else Yahoo `calendarEvents` | "Confirmed" only from NSE filing; Yahoo = "Estimated". A newer NSE filing for the same company/quarter replaces the older (rescheduled meetings). |
| Timing | NSE announcements RSS: timestamp of the board-meeting-outcome / results filing | Before open (< 09:15 IST), During market (09:15–15:30), After close (> 15:30). Before release: "Time not announced" unless the NSE notice states a time. |
| EPS estimate, revenue estimate | Yahoo `earningsTrend` | Used only when the trend entry's period end equals the result quarter end (e.g. 2026-09-30). Shown with analyst count. |
| EPS actual, revenue actual | XBRL filing linked from NSE `Financial_Results.xml` RSS | Period end must match; quarter alone (non-cumulative). Prefer Consolidated, else Standalone, labelled "Cons." / "Stand.". Revenue = revenue from operations, rupees → ₹ crore. EPS = basic EPS. |
| Expected move | Kite quotes on the option chain: nearest-strike straddle (call + put) of the nearest expiry on or after the result date, divided by underlying price | Taken at the last regular-session close before release = final; from an earlier close = provisional (≈). Null if nearest strike is > 10% from price. |
| Live expected move | Same straddle from live Kite quotes, every minute during market hours | Shows change in percentage points vs last close's value. |
| Price, change | Kite WebSocket ticks (LTP, previous close) | Real time; pushed at most once a second. |
| Previous move | Kite daily candles, close to close around the prior result | During-market result → same day (prev close → that day's close). After-close → next trading day. Before-open → same day. Timing basis stored (known / assumed) as in US. |
| Markets strip | NIFTY 50, SENSEX, NIFTY BANK, NIFTY MIDCAP 100 | Kite live; Yahoo fallback. |

Beat/miss colour: only when an estimate exists and the actual is consolidated. A standalone-only actual is shown without colour, because the estimate's basis may differ.

## Architecture

### Server — `server/src/india/` (US code untouched except shared plumbing)

- `india/sources/`
  - `nseRss.ts` — parse Board_Meetings, Financial_Results, Announcements RSS.
  - `xbrl.ts` — parse a results XBRL into `{periodEnd, cumulative, basis, revenue, eps, currency}`.
  - `kite.ts` — REST: instruments dump, quote, historical daily candles.
  - `kiteStream.ts` — WebSocket ticks (binary protocol), reconnect.
  - `kiteLogin.ts` — login (ID + password) → 2FA with TOTP → request_token → `session/token` (checksum SHA-256 of api_key + request_token + api_secret) → access token.
  - `totp.ts` — RFC 6238 TOTP (SHA-1, 30 s, 6 digits) from base32 secret.
  - `yahooIn.ts` — `.NS` estimates, sector, market cap, date; reuses the US Yahoo session/crumb code.
- `india/domain/` — IST session rules, NSE holiday list 2026–2027 (from NSE circular), expected-move and previous-move math (shared helpers reused where identical).
- `india/jobs/` — stocks (weekly), calendar (every 30 min), results (every minute 09:00–21:00 IST), expected move (after close; live every minute in session), previous moves (nightly), Kite login (07:45 IST, 3 retries 5 min apart).
- Database (same SQLite file): new tables `in_stocks`, `in_reports`. `notes` gains `market` ('US' default, 'IN'). Expanded list stores Indian symbols as `IN:<SYMBOL>`. Notes still deleted 24 h after the result.
- API (all behind login):
  - `GET /api/in/earnings?from&to` — US shape plus `basis` ('consolidated' | 'standalone' | null), `currency: 'INR'`, `timing` adds `during`.
  - `GET /api/in/prices`, `GET /api/in/markets`.
  - `/api/stream` adds events `in-results`, `in-moves`, `in-prices`.
  - Admin: Zerodha status (connected, last login time, last error) and "Log in now".
- Credentials: Railway variables `KITE_API_KEY`, `KITE_API_SECRET`, `KITE_USER_ID`, `KITE_PASSWORD`, `KITE_TOTP_SECRET`. Never in DB, logs or responses. Access token in memory only. No order-placing code.
- Without a Kite session: calendar, estimates, results work; price, expected move and live expected move show "—"; previous moves already stored stay, new ones wait for the next session.

### Web

- US / India switch in the header, remembered per user (server-side, with the expanded list).
- `Calendar` and `StockList` take a `market` prop; money as `₹… Cr`; times IST; third timing dot for "During market"; markets strip per market.
- Stock line: dot, symbol, name, price + change, timing.
- Details order: result date (confirmed/estimated), sector, market cap, EPS est/actual, revenue est/actual (basis), expected move, live expected move, previous move, price, note.
- Sort: date, market cap, biggest previous rise, biggest previous fall — within each date.
- Style rules unchanged: dark theme, Archivo, no accent stripes, no all-caps.

## Failure handling

- Any source failure: fields stay "—" or keep their last good value (never overwritten with blanks); error logged; next cycle retries.
- Kite login failure: 3 retries, then admin shows the error; manual "Log in now".
- Kite WebSocket drop: reconnect with backoff; prices marked stale after 2 minutes without ticks during market hours.

## Testing

- TDD (red → green), full suite + typecheck before each commit.
- Fixtures: saved real NSE RSS samples, a real XBRL filing (consolidated and standalone), Kite JSON/binary tick samples.
- TOTP checked against RFC 6238 test vectors.
- Live spot-check before deploy: 5 stocks' dates, estimates and actuals compared by hand against the filings.

## Security notes

- Zerodha credentials on the server = full account access if the Railway project is compromised. Site passwords (`Akshay123`, `00000000`) must be changed before Kite credentials are added.

## Out of scope

- BSE-only stocks, non-F&O stocks, order placement, redistribution features, bank-specific fields (NII, NIM, NPA).
