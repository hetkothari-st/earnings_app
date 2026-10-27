# Japan Earnings Calendar — Design

Date: 2026-10-27
Status: approved in conversation ("build option 1, don't stop anywhere")
Builds on: the Hong Kong design (`2026-10-27-hong-kong-earnings-design.md`) and its implementation (`server/src/hk/`). Japan copies the Hong Kong two-level model; anything not stated here behaves as the Hong Kong tab.

## Purpose

A fourth market, Japan, behind the US / India / Hong Kong / Japan switch. The user wants **all** Japanese listed companies in the app, free, with nothing guessed.

## Research (2026-10-27) — why this shape

- JPX TDnet (live results feed) is paid (¥70k+/month) and robots-blocked; jpx.co.jp terms forbid commercial collection or secondary use of its files; J-Quants personal plans forbid apps shown to others. **None of these are used.** Yanoshin (TDnet mirror) is not used.
- **Allowed free sources:** SEC EDGAR (8 Japanese 6-K filers), Cboe delayed option chains (their ADRs), Yahoo (already used by US/India/HK, same caveats), and the **EDINET API** (FSA, Public Data Licence PDL1.0: free, commercial use allowed with source credit and an "edited" note; needs a free API key).
- Paid TDnet API is the later upgrade path ("free now, paid later").

## Levels

| Level | Who | Data |
|---|---|---|
| Full | 8 SEC 6-K filers with Cboe ADR options: Toyota 7203 (TM, 10 shares/ADS), Sony 6758 (SONY, 1), MUFG 8306 (MUFG, 1), SMFG 8316 (SMFG, verify), Mizuho 8411 (MFG, 0.2), Honda 7267 (HMC, 3), Nomura 8604 (NMR, 1), Takeda 4502 (TAK, 0.5) | SEC 6-K results-out + exact numbers, ADR expected move, plus everything basic |
| Basic | Every other listed company (TSE, ≈3,900) | Yahoo dates, estimates, delayed prices, market cap, previous move where Yahoo has history; exact half-year / annual numbers from EDINET when filed |

ORIX (IX) files 6-Ks but has no Cboe chain → basic. The builder verifies CIKs, Cboe chains and ADR ratios live (as Hong Kong Task 2).

## Universe

- From the **EDINET code list** (EdinetcodeDlInfo, public under PDL1.0): listed companies with a 4-digit securities code (証券コード, 5 digits in the file, trailing 0). Refreshed weekly. Name in English when given, else Japanese.
- Never from jpx.co.jp files.
- Full-level entries are a hand-kept list (like `hk/universe.ts`).

## Field rules

| Field | Full | Basic |
|---|---|---|
| Result date | Yahoo `.T` date; ADR's US row (Nasdaq) when Yahoo has none; a 6-K date notice confirms | Yahoo bulk earnings calendar (the visualization endpoint already used for past dates, region JP) for all companies in one sweep; `quoteSummary` only for near-term rows. Past/ranged dates ignored (as HK). |
| Timing | From 6-K notice when stated; SEC acceptance can never prove timing (EDGAR opens 19:00/20:00 JST, after the Tokyo close) → UNKNOWN unless stated | UNKNOWN unless Yahoo gives a time-as-supplied value |
| Results out | SEC 6-K (same watcher as HK, extra CIKs). Arrives 3.5–6 h after Tokyo — the UI says so. | When Yahoo shows the actual, labelled "Yahoo" |
| Revenue, EPS actual | 6-K English 決算短信 (yen millions; basic/diluted EPS per share). **Standalone quarter column when the release has one; otherwise the year-to-date figure, labelled "YTD (n months)"; never computed by subtraction.** Banks (MUFG, SMFG, Mizuho, Nomura?) report "ordinary income" / different revenue concepts → revenue blank unless a line labelled revenue/net revenue exists. Reader gate: same rule as HK (≥20 hand-checked releases, all exact, 0 wrong) per profile 'jp'. | Yahoo actuals (quarterly, labelled Yahoo) and EDINET half-year/annual XBRL figures (labelled EDINET, exact, may arrive weeks later). EDINET never replaced by Yahoo; SEC never replaced by either. |
| Estimates | Yahoo `earningsTrend` in JPY, only when period end matches | same |
| Beat/miss colour | Only same currency, same per-share basis, same period, and **same span** (YTD actual vs quarter estimate → no colour). No EPS colour for SEC actuals (GAAP vs adjusted, as HK ruling). | same |
| Expected move | ADR straddle (Cboe), as HK | blank ("no options data") |
| Previous move | Prior date from ADR's US row (as HK fix I7) or own prior release; Yahoo closes | Yahoo past dates + closes where available; else blank |
| Price | Yahoo `.T`, "Delayed ~20 min" | same |
| Market cap | Yahoo, ¥ | same |
| Strip | Nikkei 225 (`^N225`) and "TOPIX (ETF 1306)" via `1306.T`, clearly labelled as the ETF | — |

## Japan rules

- Time zone Asia/Tokyo. TSE session 09:00–11:30, 12:30–15:30 JST. Timing: BMO < 09:00, DMH 09:00–15:30, AMC > 15:30.
- Holidays: Japanese national holidays from the Cabinet Office public list (typed in by hand for 2026–2027) plus the TSE year-end closure 31 Dec–3 Jan. Never fetched from jpx.co.jp.
- Most companies have a March fiscal year; Japanese quarterly reports are cumulative. Period labels: "1Q FY26" style with fiscal year from the company's FY end (Yahoo/EDINET), e.g. Toyota quarter ending 2026-09-30 = "2Q FY27" (FY ending Mar 2027). Builder decides exact label format consistent with HK.
- Currency JPY (`¥`). No currency mixing.

## Scale

≈3,900 basic names: Yahoo calls must be bulk or tiered. Bulk calendar sweep for dates; per-symbol `quoteSummary` only for rows reporting within ~14 days, visible or watched; prices only for visible/watched/today-tomorrow. Respect ≤1 Yahoo request/s overall. EDINET: daily document list (one call per day) → fetch XBRL only for 半期報告書 / 有価証券報告書 of listed companies.

## Architecture

Mirror `server/src/hk/` as `server/src/jp/` (universe, domain, sources, db `jp_*` tables with ids from 3_000_000_001, api `/api/jp/*`, jobs, live). Generalise shared HK pieces where it avoids copy-paste (6-K watcher by market, release reader profile 'jp'). Web: market 'JP', `JpStockList` built from `listParts`, strip, status/admin rows. Credentials: `EDINET_API_KEY` env var (user registers for it; without it EDINET is off and the rest works). Never logged.

## Out of scope

Paid TDnet / J-Quants / JPX price feeds, Japanese single-stock options, analyst consensus beyond Yahoo, Yanoshin, any jpx.co.jp download.
