# Live Data and Watchlist — Design

Date: 2026-10-21
Status: written from the 2026-10-21 conversation, awaiting user review
Builds on: `2026-10-15-earnings-calendar-design.md` (US) and `2026-10-15-india-earnings-design.md` (India). Everything not stated here stays as in those.

## Why

The user will demo the app to clients before paying for any data. The demo moment is a result coming out while the client watches: **new results and prices must appear within seconds, with no page refresh.** Clients also need a watchlist so they don't have to search and scroll every time.

## Goals

1. Results: the stock flips to "Results out" within seconds of the company's release, for both US and India, with numbers shown straight away when they can be read.
2. Every piece of data uses the fastest free source available, even if that source might block us, **and every fast source has a backup** that takes over automatically when it fails, is blocked, or can't be trusted.
3. A per-user watchlist for each market, covering any stock on the exchange.
4. Prices are live for everything a user is looking at, not only the watchlist.

## Non-goals

- Paid data (Benzinga, Polygon/Massive, ORATS, NSE/vendor licences). Only after the client buys in.
- Watchlist alerts, notifications, sharing, or multiple named lists.
- Real-time US option prices (Cboe's free feed is 15 minutes behind; that stays).

## Anti-goals (a failure even if it "works")

- A fast number shown as if it were official. Fast numbers are always tagged "preliminary" until confirmed.
- A wrong number when the fast reader wasn't sure. If unsure, the field stays "—" until the backup arrives.
- Data stopping because a fast source was blocked and nothing took over.
- A stored good value overwritten by a blank (rule from both earlier specs).

## Constraints

- Free sources only. The user accepts the risk of being rate-limited or blocked, provided a backup exists.
- Sources already ruled out stay out: no scraping of nseindia.com pages or its `/api/` endpoints, nothing from bseindia.com, no MarketChameleon. (User's earlier decision; terms forbid it.) The Investing.com scraper stays opt-in (`INVESTING_SCRAPER=1`) and may be one more backup for US actuals.
- SEC asks for at most 10 requests per second and a User-Agent with contact details (`SEC_USER_AGENT`, already configured).
- Finnhub free: the live stream allows 50 symbols per connection; REST allows 60 calls per minute.
- Kite ticker: up to 3,000 instruments per connection (3 connections per key).
- Same stack as today: Node/TypeScript Fastify server, SQLite, server-sent events to the browser (`/api/stream`), React web app.

## What the user decided

### 1. Results within seconds, with preliminary numbers

Every result arrives on two paths.

**Fast path (seconds).**
- **US:** watch SEC EDGAR's latest-filings feed (8-K filings) every few seconds. When a company on the calendar files an 8-K with an earnings release (Item 2.02, press-release exhibit), mark the report "Results out" with the SEC acceptance time. Then read EPS and revenue from the press release.
- **India:** watch NSE's `Online_announcements` feed every few seconds. When it lists a results announcement for a known stock, mark it "Results out" with the announcement time. Then read EPS, revenue (banks: total income) and net profit from the attached results PDF.

**Backup (minutes, official).**
- **US:** Nasdaq and Finnhub (as today), checked every minute while results are expected; Investing.com if enabled.
- **India:** the NSE Integrated_Filing XBRL (as today).

**How fast numbers behave on screen (user approved):**
- Fast numbers show with a small **"preliminary"** tag.
- When the official numbers arrive and match, the tag disappears.
- When they differ, the official numbers replace the fast ones and the row shows a small **"corrected"** note.
- If the fast reader can't find a number with confidence, that field shows "—" until the official one arrives.

**Beat/miss on preliminary numbers (user: show colours straight away):** preliminary values drive beat/miss colour and surprise % at once, like official ones. If the official figure later flips the result (e.g. beat → miss), the colour changes and the "corrected" note shows.

**Which US EPS (user asked for my recommendation, accepted pending review):**
- The fast reader takes **adjusted (non-GAAP) EPS** when the release clearly labels it. That's the basis of the consensus estimate and of Nasdaq's actual.
- When only GAAP EPS is found, show it labelled "GAAP", **without** beat/miss colour, until the adjusted official figure arrives.
- India: basic EPS, consolidated preferred, as in the India spec.

**Making the fast reader rarely fail (user: "try to make sure it doesn't fail"):**
- Accept a number only when the document clearly labels it for the right period. Examples: "Diluted EPS" or "Basic EPS" for the quarter, "Revenue from operations", "Total income", "Net profit". Never take a year-to-date or annual column.
- Check units and scale ("in millions", "₹ in crore", "in lakhs"), and record which column was read.
- Test the reader against a corpus of real past press releases (US) and results PDFs (India), at least 30 of each, before relying on it. Measure how often it reads a value, and how often that value matches the official figure.
- Log every miss and every mismatch with the document link, so the reader can be improved.
- A PDF with no text layer (a scanned image) is a miss: no number from it, and the backup fills in. No OCR in this round.

### 2. Every data type: fastest source plus backup

| Data | Fast source | Backup when it fails, is blocked or unsure |
|---|---|---|
| Results, US | SEC 8-K feed every few seconds; numbers from the press release (preliminary) | Nasdaq / Finnhub every minute (official); Investing.com if enabled |
| Results, India | NSE announcements every few seconds; numbers from the PDF (preliminary) | NSE XBRL filing (official) |
| Prices, US | Finnhub live stream: watchlist plus the stocks on screen | Finnhub quote polling, then Yahoo |
| Prices, India | Kite live stream for every stock needed | Yahoo |
| Market cap | Live price × share count (share count refreshed daily) | Last stored market cap |
| Expected move, India | Kite option prices streamed live (straddle recalculated as ticks arrive) | Kite quotes every minute (today's method) |
| Expected move, US | Cboe every minute (its free data is 15 minutes behind) | Last snapshot |
| Result dates | US: Nasdaq calendar every few minutes. India: NSE Board_Meetings every minute | Yahoo dates, marked "estimated" |
| Estimates | Yahoo, as often as it allows | Last stored values |

**Rules for every fast source:**
- When a fast source errors, is blocked (HTTP 403/429, a challenge page, an HTML error page) or keeps failing, the app switches to the backup at once. It also backs off the fast source, retrying later, so a block can lift.
- A small marker on the row (or in the markets strip) shows when backup data is in use.
- The status page lists each source as working, failing, or on backup.

### 3. Watchlist

- Anyone signed in can **search any stock on the exchange** and add it with one click.
  - US: every listed US stock (SEC's ticker list).
  - India: every NSE equity (Kite instrument list), not only F&O.
- The watchlist is **saved per user on the server**, so it's the same on any device and after signing in again. US and India have separate watchlists.
- A **Watchlist view** shows only the watched stocks, each with:
  - live price
  - next result date, if known
  - expected move, if the stock has options (non-F&O Indian stocks never do: "—")
  - latest results
- Watched stocks get a small marker in the normal calendar (builder's call: see below).
- **Watched stocks with no stored history** (India non-F&O; US stocks outside the calendar): US fetches past results from free sources on add (Nasdaq/SEC). India shows "—" for latest results until the company next files (user's choice; nseindia.com is ruled out).
- The India calendar itself stays F&O only. Non-F&O stocks appear only through a watchlist. Their result dates and numbers come from the same NSE feeds.

### 4. Everything live, not just the watchlist

- **India:** stream all F&O stocks plus every stock on any user's India watchlist (well within Kite's 3,000 per connection).
- **US:** the free stream allows only 50 symbols. It carries the signed-in users' watchlists plus the stocks currently on screen, switching as users scroll or change the date. Stocks off screen don't update, but nobody is looking at them. When more than 50 are needed, the builder decides how to share the 50 slots. Watched stocks and on-screen stocks come before everything else, and anything left over falls back to quote polling within Finnhub's 60 per minute.

### 5. Blanks must be rare (user: the app "often shows — for all of them, make sure it isn't the case")

- A "—" is acceptable only where no allowed source has the value. It must not become the normal state of a column.
- **Fill gaps from backups:**
  - India previous move: Yahoo past result dates (TAS rows) plus Kite daily candles, when the app hasn't captured the earlier report itself (ruling 4 of the India plan, not yet built).
  - Estimates and market cap: Yahoo.
  - US: as today, plus SEC.
- **Coverage on the status page:** per market and per field, the share of upcoming reports (next 14 days) that have a value, e.g. "EPS estimate 92%, previous move 40%". Each field has a minimum (builder sets sensible minimums per field and source). Below it, the field is flagged on the status page.
- **Pre-demo check:** a script run against live data lists every field below its minimum, so gaps are fixed before a client sees them.

## Left to the builder

- How the browser tells the server what is on screen (for US price slots).
- PDF and HTML parsing libraries; the parsing heuristics within the rules above.
- Exact polling intervals within "every few seconds" / "every minute". Tune them to stay under SEC's 10/s and to avoid needless blocks.
- How the "preliminary", "corrected" and "backup in use" markers look, within the existing style rules: dark theme, Archivo, dots not stripes, no all-caps.
- Where the watchlist view lives in the UI (tab, toggle or page), and whether watched stocks get a calendar marker.
- Schema for watchlists, preliminary values and source state.
- Building in stages: fast results first, then the watchlist, then the remaining speed-ups.

## Settled after the builder check (my calls)

- **India reader basis:** basic EPS, consolidated preferred (standalone labelled), the same as the official XBRL path. Net profit and bank total income are already stored from the XBRL (`pnl_actual`, total income as revenue for banks), so the preliminary tags on them can clear.
- **What counts as a match:** EPS within 0.01 (₹ or $); revenue and profit within 0.5%, or the same figure after rounding to the document's stated unit. Anything further apart is "corrected".
- **Reader gate:** the "Results out" flip ships first, whatever the reader's accuracy. The number reader is switched on field by field (US EPS, US revenue, India EPS, revenue, profit). A field goes live only when, on the saved corpus, at least 95% of the values it accepts match the official figure. Fields below that stay off ("—" until official) until the reader improves.
- **Share count:** US from SEC company facts (`dei:EntityCommonStockSharesOutstanding`), India from Yahoo (`sharesOutstanding`), refreshed daily. Live market cap applies only to rows whose report date is today or later. Past rows keep the US rule: market cap is frozen after the report date.

## Calls I made (not discussed with the user)

- The US fast path relies on SEC filings. Companies that put out a press release before filing their 8-K show "Results out" only when the 8-K is filed (usually within minutes).
- No OCR for scanned PDFs this round.
- Separate watchlists per market, rather than one mixed list.

## Testing

- TDD as in the earlier specs.
- Reader accuracy measured on the saved corpus, as above.
- Fail-over tested by simulating each fast source failing: errors, 403/429, an HTML page instead of data.
- A live check during a results day before the demo.
