# UK and Europe Earnings Calendar — Design

Date: 2026-10-28
Status: approved in conversation ("on by default, build it all")
Builds on: the Hong Kong and Japan designs (`2026-10-27-hong-kong-earnings-design.md`, `2026-10-27-japan-earnings-design.md`) and their code (`server/src/hk/`, `server/src/jp/`). Anything not stated here behaves as the Japan tab.

## Purpose

Two more markets behind the switch: **UK** (London Stock Exchange, Main Market + AIM) and **Europe** (main continental exchanges). The user wants all listed companies, free, as live as possible, nothing guessed.

## Research (2026-10-28) — why this shape

Full reports: session scratchpad `uk-sources.md`, `eu-sources.md` (summarised here; the builder re-verifies anything it relies on).

- **Banned for bots (never fetched by the app):** londonstockexchange.com and its JSON API (LSEG terms: "any bot, script, automation software…"), live.euronext.com / euronext.com ("spiders, robots… strictly prohibited"), nasdaq.com Nordic pages (Akamai wall), Investegate (terms: private investors only, no commercial/derived use), info-financiere.fr `/api/` (robots `Disallow: /api/`), TradingView, FT, Google Finance, Stooq, Lang & Schwarz, MarketScreener, Investing.com, finanzen.net, onvista, lse.co.uk, Sharecast, Digital Look. Never bypass a bot wall or CAPTCHA.
- **Paid (later upgrade):** LSEG RNS Data Feed / Ticker.app (~£90/month) for the 07:00 RNS headline.
- **Free and usable:** Yahoo (as the other markets), SEC EDGAR 6-K/8-K (declared `SEC_USER_AGENT`), Cboe delayed option JSON (US-listed ADR options), filings.xbrl.org API (ESEF annual reports, xBRL-JSON), PR Newswire RSS, DILA INFOFI bulk files (France regulated info, ISIN-tagged), gov.uk bank-holidays JSON, OpenFIGI API, ESMA/FCA FIRDS reference files, GLEIF ISIN↔LEI files, **Tradegate BSX `refresh.php`** (real-time quotes; robots disallows only `/json/`; no terms page found).
- **User ruling:** Tradegate real-time prices **on by default**, despite no published terms and prices being in EUR.

## Markets and levels

Two markets, `UK` and `EU`. One server module serves both (see Architecture).

| Level | UK | EU |
|---|---|---|
| Full | US-listed names with Cboe options: AZN, SHEL, BP, HSBC (shared with HK — see below), UL, GSK, DEO, VOD, RIO, BHP, BTI, NGG, BCS, LYG, NWG, RELX, PUK, SNN, HLN, WPP, CCEP, ARM | ASML, SAP, NVO, TTE, SNY, NVS, UBS, ING, PHG, ERIC, NOK, EQNR, STLA, SAN, BBVA, BUD, STM, DB, AEG, SPOT, NXPI, CRH, plus any of BNTX, ARGX, LOGI, CHKP the builder verifies |
| Basic | every other LSE Main Market + AIM company (~1,800) | every other company with a primary listing on the exchanges below (~5,000) |

Full = SEC results-out + exact numbers (reader gate), ADR expected move, plus everything basic. ADR ratios in the research are **inferred from prices**; the builder verifies each from the depositary / SEC filing (as Japan) and hides the expected move where unverified (`adrRatioVerified`). Names whose US line is an ordinary share (AZN now, ASML, CCEP, ARM, SPOT, NXPI, CRH, STLA…) have ratio 1. Names filing 10-Q/8-K (US domestic filers, e.g. CRH, NXPI) are read from 8-K like HK's 8-K path. HSBC appears in HK already; in the UK tab it is its own row (`HSBA.L`), sharing the SEC CIK and ADR data source but not the HK row.

EU exchanges and Yahoo suffixes: Euronext Paris (.PA), Amsterdam (.AS), Brussels (.BR), Lisbon (.LS), Dublin (.IR), Milan (.MI), Oslo (.OL); Xetra/Frankfurt (.DE); SIX Swiss (.SW); Nasdaq Stockholm (.ST), Copenhagen (.CO), Helsinki (.HE); BME Madrid (.MC). Each EU row carries its country and exchange; the EU tab has an exchange/country filter.

## Universe

- Source of truth: official open reference data, never exchange websites. **ESMA FIRDS** (EU MICs) and **FCA FIRDS** (UK MICs, including AIM): shares (CFI `ES*`) admitted on the target MICs; names via GLEIF (English legal name) when FIRDS only has the issuer LEI.
- Ticker mapping ISIN → exchange ticker via **OpenFIGI** (free, keyless 25 req/min × 10 ISINs, or the optional `OPENFIGI_API_KEY` env var; never logged), then the Yahoo symbol = ticker + suffix (UK share classes: `BT-A.L` style). An ISIN that maps ambiguously is left out, not guessed.
- Refreshed weekly; a company missing from two consecutive refreshes is marked inactive (never deleted).
- If FIRDS turns out impractical (file size, format), the builder may substitute another official open source (SIX share list, Deutsche Börse Xetra instrument CSV, BME list) and records the ruling; never an exchange site that bans bots.
- Full-level entries are a hand-kept list (as `hk/universe.ts` / `jp/universe.ts`).

## Field rules

| Field | Full | Basic |
|---|---|---|
| Result date | Yahoo local-line date; the ADR's US row when Yahoo has none; a 6-K notice confirms | Yahoo: bulk calendar if it still works for GB/EU regions (builder tests), otherwise the rolling per-symbol sweep exactly as Japan. Past/ranged dates ignored. |
| Timing | UNKNOWN unless a source states the time (6-K notice, Yahoo time-as-supplied, a timestamped release). **No 07:00 default** even though most UK/EU companies release at 07:00 — that would be a guess. The row tooltip says "UK/EU companies usually release at 07:00 local; not confirmed for this row." | same |
| Results out | SEC 6-K/8-K (shared watcher, extra CIKs). Plus the fast signals below. | Yahoo actual (labelled "Yahoo"), plus the fast signals below |
| Fast results-out signals | **PR Newswire RSS** (UK + Europe feeds): a release marks results-out only when its issuer maps to exactly one universe company (normalised legal-name match or ISIN in the text) AND the title matches a results pattern AND the company has a result date within ±3 days. **DILA INFOFI** bulk (France): ISIN-tagged, results-type documents mark results-out exactly. No numbers are read from these (headline numbers would need a per-profile reader gate; out of scope). Label the source and its timestamp. | same |
| Revenue, EPS actual | 6-K/8-K release, reader profiles `uk` and `eu` (IFRS; EUR, USD, GBP, CHF, DKK, SEK, NOK). Many UK/EU companies report half-years with Q1/Q3 trading updates without EPS → EPS blank for those. Standalone period only; YTD labelled as Japan; never computed by subtraction. UK pence vs pounds: EPS shown in the unit the release states (p or £), never converted silently. Reader gate per profile exactly as Japan (main ≥20 exact releases carrying a value AND 0 wrong; every held-out set 0 wrong); flags `ukEps/ukRevenue/euEps/euRevenue` **off until the gate passes**. | Yahoo actuals (labelled Yahoo) and filings.xbrl.org ESEF annual figures (labelled "ESEF annual report", exact, may arrive weeks later). ESEF never replaced by Yahoo; SEC never replaced by either. |
| Estimates | Yahoo `earningsTrend`, only when period end matches and currency matches the row's reporting currency | same |
| Beat/miss colour | Same rules as Japan (same currency, per-share basis, period and span; no EPS colour for SEC actuals) | same |
| Expected move | ADR straddle (Cboe), as Japan | blank ("no options data") |
| Previous move | as Japan (own prior release / ADR US row labelled 'assumed') with Yahoo closes | Yahoo past dates + closes, else blank |
| Price | **Tradegate real-time (EUR) when Tradegate quotes the ISIN**, labelled "Real-time · Tradegate · EUR"; % change against Tradegate's own previous close. Otherwise Yahoo local line, "Delayed ~15 min" (GBp shown as pence, `p`; read `currency` from Yahoo, some .L lines quote USD/EUR). | same |
| Market cap | Yahoo, in the listing currency | same |
| Strip | UK: FTSE 100 `^FTSE`, FTSE 250 `^FTMC`, FTSE AIM All-Share `^FTAI`. EU: Euro Stoxx 50 `^STOXX50E`, DAX `^GDAXI`, CAC 40 `^FCHI`, AEX `^AEX`, IBEX 35 `^IBEX`, FTSE MIB `FTSEMIB.MI`, SMI `^SSMI`, OMXS30 `^OMX`. Yahoo, delayed. | — |

## Tradegate rules

- Endpoint `https://www.tradegatebsx.com/refresh.php?isin=<ISIN>` (JSON: bid, ask, last, high, low, close, volume). Never `/json/` (robots). Builder re-checks robots.txt at build time and the code refuses to run if `/refresh.php` becomes disallowed (checked weekly).
- Polled only for ISINs that are visible, watched or reporting today/tomorrow; one process-wide Tradegate limiter ≤ 1 request/s; trading hours 08:00–22:00 Europe/Berlin on Tradegate trading days, else every 15 min (last close).
- On by default. `TRADEGATE_PRICES=0` turns it off; then prices fall back to Yahoo delayed. Admin/status page shows its state.
- Honest User-Agent naming the app (no personal email). Back off on 429/403 (stop for 1 h and fall back to Yahoo).

## Calendars and time zones

- UK: Europe/London; LSE trading days = weekdays minus England & Wales bank holidays from the **gov.uk bank-holidays JSON** (official, free) plus LSE's Christmas Eve / New Year's Eve half days treated as trading days.
- EU: each exchange in its own zone (Europe/Paris, Amsterdam, Brussels, Lisbon, Dublin, Rome, Oslo, Berlin, Zurich, Stockholm, Copenhagen, Helsinki, Madrid). Holidays typed by hand for 2026–2027 per exchange from each exchange's published holiday list (read by a human/the builder once, not fetched by the app).
- Sessions (BMO < open, DMH during, AMC ≥ close): LSE 08:00–16:30; Euronext/Xetra/BME/Milan 09:00–17:30; SIX 09:00–17:20; Nasdaq Nordic 09:00–17:30 (Helsinki 10:00–18:30 local); Oslo 09:00–16:20. Timing stays UNKNOWN unless stated; these rules classify a stated time.

## Scale and rate limits

- ~6,800 basic names. The existing process-wide Yahoo limiter (≤1 req/s for background jobs) is shared with Japan; the rolling sweeps of JP, UK and EU take turns so the total stays within it. Reporting windows (late Jan–early Mar, late Apr–May, late Jul–Aug, late Oct–Nov) get the larger per-run budget, as Japan.
- Cboe: a Cboe limiter (≤ 0.5 req/s, cache 15 min) for UK/EU chains — the research hit 429 after ~35 requests in a minute.
- OpenFIGI within its published limits; filings.xbrl.org at most 1 request/s with a nightly sweep; PR Newswire RSS every 2 min 06:00–18:00 London on weekdays; DILA INFOFI daily directory every 15 min 07:00–20:00 Paris.

## Architecture

- One server module `server/src/europe/` parameterised by a market profile (`uk`, `eu`): universe, domain (calendars per exchange, period labels), sources (FIRDS, OpenFIGI, Tradegate, PR Newswire, DILA, xbrl.org), db, api, jobs, live. Tables `uk_*` and `eu_*` (or shared tables with a `market` column — builder's call, recorded), ids from 4_000_000_001 (UK) and 5_000_000_001 (EU). Routes `/api/uk/*` and `/api/eu/*`.
- Reuse shared pieces from HK/JP (sixKClassify/sixKWatch/sixKSweep with new profiles and CIKs, releaseReader profiles `uk`/`eu`, delayedPrices, adrMoves, exchangeCalendar, yahooClient/yahooLimiter, the Cboe client which already follows the 307 to cdn-api.cboe.com). Generalise rather than copy where it avoids duplication.
- Web: markets `UK` and `EU` in the switch; `UkStockList` / `EuStockList` (or one parameterised list) from `listParts`/`foreignParts`; strips; exchange filter for EU; status/admin rows (Tradegate on/off, last poll, FIRDS/OpenFIGI refresh, PRN/DILA last item, reader gate state).
- Credentials: `OPENFIGI_API_KEY` optional; `SEC_USER_AGENT` already present. Never logged or returned.
- Tests: as Japan (unit tests per source with recorded fixtures, corpus gates, US/HK/JP snapshots unchanged).

## Out of scope

Paid RNS / LSEG feeds; scraping any banned site above; reading numbers from PR Newswire or DILA releases; ICE/Eurex/Euronext single-stock options; Börse Frankfurt API (Deutsche Börse FWB-Data licence turns paid when commercialised); consensus beyond Yahoo; UK/EU news text in the UI beyond title + link.

## Decisions made by me (the user can override)

1. Two tabs, UK and Europe, one shared server module.
2. No default 07:00 timing (exact-data rule wins over convention).
3. PR Newswire / DILA give "results out" only, no numbers.
4. Reader flags stay off until each profile passes the same gate as Japan.
5. Tradegate % change uses Tradegate's own previous close (no cross-venue mixing).
6. Universe from FIRDS + OpenFIGI; ambiguous ISINs left out.
