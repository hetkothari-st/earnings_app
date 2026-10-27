# Hong Kong Earnings Calendar — Design

Date: 2026-10-27
Status: approved in conversation (option 1, "two levels"); awaiting written-spec review
Builds on: `2026-10-15-earnings-calendar-design.md` (US) and `2026-10-15-india-earnings-design.md` (India). Anything not stated here behaves as in the India tab.

## Purpose

Same as the US and India tabs: upcoming and just-released results for Hong Kong stocks, with expected move, previous move, price, estimates and notes. The user wants Hong Kong specifically, free and accurate, without waiting on licences or emails.

## Why two levels (research, 2026-10-27)

- HKEX / HKEXnews Terms of Use s.5 forbid bots, scrapers, monitoring, systematic retrieval and redistribution. So the HKEXnews announcement feed, issuer PDFs on HKEXnews, the HKEX securities list and the HKEX daily options report (dqe) are all **out**.
- Free market-data APIs with HK coverage (Finnhub, Twelve Data, iTick, AllTick, FMP, EODHD) are personal-use / non-display only. Chinese portal quote endpoints (qt.gtimg.cn, hq.sinajs.cn) have no licence. Futu/moomoo do not accept Indian residents. **Out.**
- Issuer websites: only Tencent is reachable without a bot wall, and its legal statement is not an explicit grant. Grey, so **out** (user chose option 1 without it).
- **Allowed and free:** SEC EDGAR (public information, may be copied/distributed; 10 req/s with declared User-Agent), Cboe delayed option quotes (already used by the US tab), Yahoo (already used by the US and India tabs, same caveats).

Result: **full level** for HK companies that also file with the SEC and have US-listed options; **basic level** for the rest.

## Decisions

| Topic | Decision | Whose call |
|---|---|---|
| Tab | Third market `HK` in the header switch: US / India / Hong Kong. Remembered per user like the others. | user (copy US/India) |
| Universe | Hand-maintained list in the repo, not downloaded from HKEX. Starts with the big HK names (≈ the HKEX stock-option underlyings the user cares about: Tencent, Alibaba, HSBC, AIA, BYD, Ping An, Meituan, Xiaomi, banks…). Each entry: HK code, US ADR ticker or null, ADR ratio (HK shares per ADS) or null, SEC CIK or null. Names, sector, market cap from Yahoo. | my call (HKEX list is off-limits) |
| Full level | Entries with a CIK **and** Cboe-listed ADR options (≈15–18: BABA, JD, BIDU, NTES, TCOM, LI, NIO, XPEV, BILI, YUMC, ONC, ZTO, BEKE, HSBC, PUK, TME and others the builder verifies). | user (option 1) |
| Basic level | Everything else. Shows a small "Basic data" tag so the user knows why fields are blank. | my call |
| Exactness | Uncertain means blank. Never overwrite a stored value with a blank. Same as US/India. | standing rule |

## Sources and rules per field

| Field | Full level | Basic level |
|---|---|---|
| Result date | Nasdaq/US row of the ADR when it exists (the US tab already fetches it) and agrees with Yahoo; a 6-K that announces the date makes it "Confirmed". Otherwise Yahoo `calendarEvents` = "Estimated". | Yahoo = "Estimated". Yahoo dates already in the past are ignored (they are stale, e.g. 0285, 2382). |
| Timing | From the 6-K acceptance time / release time when known: before HK open (< 09:30 HKT), during market (09:30–16:00, lunch counts as during), after close (> 16:00). | "Time not announced" unless Yahoo gives a time-as-supplied value. |
| Results out | The SEC live feed (already polled every 2 s for 8-Ks) also watches **6-K** filings from the full-level CIKs. A 6-K counts as results only if its exhibit is an earnings release for the expected period. Note: EDGAR accepts filings 06:00–22:00 ET only, so a midday HK release can land hours later. | Not available (no allowed source). Row flips only when Yahoo shows actuals, labelled "from Yahoo". |
| Revenue, EPS actual | Read from the 6-K Ex-99.1 press release by the existing US release reader, extended for 6-K / foreign-issuer layouts. Period must match; half-year and quarter both supported; never year-to-date when a quarter is expected. Currency as stated (RMB, USD, HKD). EPS **per ordinary share** when the release states it; otherwise per ADS, labelled "per ADS". | Yahoo actuals when Yahoo has them, labelled "Yahoo" (not official). Otherwise blank. |
| Reader gate | The HK reading of 6-Ks stays switched off until it gets **20 past releases exactly right** (checked by hand against the releases), same rule as India's PDF reader. | — |
| Estimates | Yahoo `earningsTrend` of the `.HK` symbol, used only when its period end equals the result period end. Shown with analyst count and **currency**. | Same. Many smaller names have none → blank. |
| Beat/miss colour | Only when estimate and actual have the same currency, same per-share basis (share vs ADS) and period. Otherwise numbers shown without colour. | Same. |
| Expected move | Cboe ADR chain: nearest-strike straddle of the nearest expiry on or after the HK release, divided by ADR price — a percentage, applied to the HK line. Valid only when the expiry is on or after the first US session after the HK release. Same final/provisional (≈) rule as US. 15-min delayed. | Blank ("no options data"). |
| Price, change | Yahoo `.HK`, labelled "Delayed ~15 min". Polled for rows on screen / watchlist like the US fallback poll. | Same. |
| Market cap | Yahoo, HK$. | Same. |
| Previous move | Yahoo daily bars around the prior result date (dates from Yahoo past earnings, TAS rows only, as India `yahooPastDates`). After-close or unknown timing → next HK trading day, marked "assumed" like the US. | Same. |
| Markets strip | Hang Seng (^HSI), Hang Seng China Enterprises, Hang Seng Tech — via Yahoo, delayed, 15 s poll like the US strip. Builder verifies the Yahoo symbols. | — |

## HK rules

- Time zone Asia/Hong_Kong. Session 09:30–12:00 and 13:00–16:00 HKT.
- Holidays 2026–2027: typed in by hand from the HK Government general-holiday list (gov.hk), not from HKEX.
- Many HK firms report half-yearly (interim / annual); some quarterly. Period label: "1H26", "2H26"/"FY26", "Q3 26".
- Money: reporting currency shown with its symbol (RMB ¥, US$, HK$); prices and market cap in HK$. Never mix currencies in one comparison.

## Architecture

Follows the India layout. US and India code untouched except shared plumbing.

- `server/src/hk/`
  - `universe.ts` — the hand-maintained list (code, ADR, ratio, CIK).
  - `sources/` — Yahoo `.HK` (reuse the India Yahoo session/crumb code), 6-K exhibit fetch (reuse `sec.ts` / `secFeed.ts`), Cboe (reuse `cboe.ts`).
  - `domain/` — HKT session and holidays, period labels, currency formatting.
  - `jobs/` — stocks (weekly, Yahoo profile/cap), calendar (every 30 min), estimates (hourly), prices (1 min, visible rows), expected move (from ADR chains, every minute in US session + snapshot at US close), previous moves (nightly), results (Yahoo actuals check every 30 min for basic level).
  - `live/` — hook into the existing SEC watcher for 6-Ks from full-level CIKs; push `hk-results`, `hk-moves`, `hk-prices`, `hk-indices` events over the existing WebSocket/SSE channel.
- Database (same SQLite file): `hk_stocks`, `hk_reports`; notes, watchlist and prefs accept market `'HK'`; expanded list stores `HK:<code>`.
- API (behind login): `GET /api/hk/earnings?from&to`, `/api/hk/earnings/:id`, `/api/hk/prices`, `/api/hk/markets`. Row DTO adds `level: 'full' | 'basic'`, `currency`, `epsBasis: 'share' | 'ads' | null`, `actualSource: 'sec' | 'yahoo' | null`, `period`.
- Admin/status page: HK sources and coverage rows, like India.

### Web

- Header switch gains "Hong Kong". `Calendar`/`StockList` take `market: 'HK'`.
- Stock line as India; full-level rows show no tag, basic rows a small "Basic data" tag.
- Prices show "Delayed" label. Details show currency on every money value.
- Style rules unchanged.

## Failure handling

As India: source failure keeps the last good value, logs, retries next cycle. SEC limits respected (declared User-Agent from env, ≤ 10 req/s).

## Testing

- TDD, full suite + typecheck before each commit.
- Fixtures: real 6-K Ex-99.1 releases (Alibaba, HSBC, JD, NetEase at least; half-year and quarter), Yahoo `.HK` quoteSummary and chart samples, Cboe ADR chain sample.
- Reader gate: 20 past HK-issuer 6-K releases checked by hand; reader switched on only at 20/20.
- Live spot-check before calling it done: 5 full-level and 5 basic names compared by hand.

## Out of scope

HKEX / HKEXnews data of any kind, issuer websites (incl. Tencent), paid or personal-use APIs, live HK prices, HK-listed option data, names outside the hand-maintained list.

## Open for the builder

- Exact full-level list (verify CIK, ADR ratio, Cboe chain for each).
- Yahoo symbols for HSCEI and HSTECH.
- How each full-level issuer's release states EPS (per share vs per ADS, GAAP vs non-GAAP) — read basic/diluted per-share GAAP when stated; non-GAAP never replaces GAAP.
