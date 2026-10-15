# US Earnings Calendar (prototype)

Shows US earnings reports by day/week/month/quarter with BMO/AMC timing in ET and your local time, primary exchange, market cap, options-implied move, and EPS/revenue results. Uncertain values are flagged with ⚠ — nothing is guessed.

## Requirements
- Node.js 24+

## Setup
1. `npm install`
2. Copy `.env.example` to `.env` and set:
   - `SEC_USER_AGENT` — required by SEC, e.g. `EarningsCalendar/0.1 you@example.com`
   - `FINNHUB_TOKEN` — free key from https://finnhub.io/register (revenue data)
3. `npm run dev` — API on :3001, web app on http://localhost:5173
4. Optional history: `npm run backfill` (2 years; takes a few hours, resumable) or `npm run backfill -- 2026-09-01`

## Data sources (free tier — prototype only)
Nasdaq calendar and Cboe delayed options are unofficial endpoints with no uptime guarantee and terms that likely forbid commercial use. Before real users, switch to the licensed sources in the spec (section 10). Spec: `docs/superpowers/specs/2026-10-15-earnings-calendar-design.md`.

## Known limitations
- Exchange is the primary listing, not the highest-volume venue.
- No exact release minute; BMO/AMC windows only.
- Expected move is our straddle calculation (priced off the regular-session close), available only from launch onward.
- Market cap on backfilled rows is current, not at report time (flagged).

## Health
`/status` page (or `GET /api/status`) shows each source's last success and last error.

## Tests
`npm test`
