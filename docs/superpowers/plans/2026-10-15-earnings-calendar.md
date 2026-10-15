# US Earnings Calendar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A web app that lists US earnings reports by day/week/month/quarter/custom range with BMO/AMC timing in ET and the user's local time, primary exchange, market cap, options-implied expected move, and EPS/revenue results — never guessing, flagging every uncertain value.

**Architecture:** A Node/TypeScript backend owns all external data: scheduled jobs pull from free sources (Nasdaq, Finnhub, SEC EDGAR, Cboe) through swappable source modules, validate with zod, and store everything in SQLite (`node:sqlite`). A Fastify JSON API serves stored data; a React/Vite frontend renders it, converting ET to the user's detected zone with Luxon.

**Tech Stack:** Node 24, TypeScript 5.9.3, Fastify 5.12.7, node:sqlite, zod 4.6.7, Luxon 3.7.2, node-cron 4.6.0, React 19.2.9, Vite 7.3.7, Vitest 4.0.6, Testing Library 16.3.3, jsdom 26.1.0.

**Spec:** `docs/superpowers/specs/2026-10-15-earnings-calendar-design.md` (read it before starting; sections 4, 6 and 6.6/6.6a are the accuracy rules this plan implements).

## Global Constraints

- Node ≥ 24 (uses built-in `node:sqlite`, `process.loadEnvFile`, `AbortSignal.timeout`).
- Exact dependency versions as listed in each `package.json` below — no ranges.
- Never invent data: a missing/unparseable value is `null` in storage and `—` in the UI; uncertainty is a `flags` entry rendered as ⚠ with an explanatory tooltip.
- BMO = "before 9:30 AM ET"; AMC = "after 4:00 PM ET" (13:00 on NYSE early-close days); DMH = "During market · 9:30 AM–<close>"; unknown = "Time not announced".
- All ET math uses IANA zone `America/New_York`; user zone from `Intl.DateTimeFormat().resolvedOptions().timeZone`, fallback `Asia/Kolkata`, user-overridable.
- Default market-cap filter ≥ $2B; rows with unknown market cap are never filtered out.
- Timing source priority: Nasdaq (captured while upcoming) > Finnhub `hour` > SEC-derived BMO. A known timing is never overwritten by "not supplied".
- SEC acceptance time comes from the filing's `.hdr.sgml` `<ACCEPTANCE-DATETIME>` (ET wall clock) — never from the submissions API `acceptanceDateTime` (mislabelled "Z").
- SEC requests must send `User-Agent` from env `SEC_USER_AGENT` and stay ≤ 10 req/s (we use 150 ms spacing). Nasdaq and Cboe: 1 req/s. Finnhub: token via `X-Finnhub-Token` header, ≤ 60 req/min.
- Secrets (`FINNHUB_TOKEN`, `SEC_USER_AGENT`) live only in `.env` (git-ignored).
- Browser storage (`localStorage`) access always wrapped in try/catch; app must work without it.
- Commit after each task with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A past date is refreshed and Nasdaq now says `time-not-supplied`** — the stored BMO/AMC must survive (Nasdaq erases timing once a date passes). Test: Task 8 `keeps known timing when Nasdaq later says not supplied`.
2. **Weekend or holiday date** — Nasdaq returns `rows: null`; must yield an empty list, not a crash. Test: Task 5 `weekend response yields no rows`.
3. **Class-share tickers spelled differently by each source** (`BRK/B` Nasdaq, `BRK.B` Finnhub, `BRK-B` SEC) — exchange and revenue must still attach to the right row. Tests: Task 1 `normalizeTicker`, Task 8 `merges Finnhub row across ticker spellings`, Task 9 `sets exchange for class-share ticker`.
4. **User zone where the local date flips, around DST changes** — e.g. AMC 4 PM ET → 1:30 AM IST next day in October but 2:30 AM in December; London during the one week the US and UK DST rules disagree. Tests: Task 11 `describeTiming` cases.
5. **A source is down or changes its JSON shape** — stored data stays untouched and `/status` shows the error. Test: Task 9 `format error records status and keeps stored data`.

---

## File Structure

```
package.json                 npm workspaces root (server, web), dev/test scripts
.gitignore, .env.example, README.md
server/
  package.json, tsconfig.json
  src/
    config.ts                env loading (.env), typed config
    types.ts                 internal domain types
    api/types.ts             DTO types shared with web (type-only)
    domain/
      ticker.ts              normalizeTicker
      parse.ts               parseNumber / parseIntOrNull for vendor strings
      marketCalendar.ts      NYSE holidays/early closes, trading-day math, todayET
      surprise.ts            surprisePct, beatMiss
      expectedMove.ts        parseOptionSymbol, chooseExpiry, computeExpectedMove
      secTiming.ts           deriveFromAcceptance, checkTiming
    sources/
      http.ts                rate-limited fetch (json/text), HttpError, SourceFormatError
      nasdaq.ts              calendar parse/fetch
      finnhub.ts             earnings (revenue + hour) parse/fetch
      cboe.ts                option chain parse/fetch
      sec.ts                 tickers, earnings 8-K list, acceptance header
      index.ts               createSources(config): Sources
    db/repo.ts               schema + all SQL
    jobs/
      context.ts             Sources & JobContext interfaces, track()
      refreshCalendar.ts, refreshResults.ts, snapshotMoves.ts, secSync.ts, backfill.ts
      scheduler.ts           node-cron wiring
    api/dto.ts               ReportRecord -> ReportDto (+flags)
    api/server.ts            Fastify routes
    index.ts                 entrypoint
    cli/backfill.ts          one-time history backfill
  test/                      *.test.ts mirroring src
web/
  package.json, tsconfig.json, vite.config.ts, index.html
  src/
    main.tsx, App.tsx, styles.css, test-setup.ts
    api.ts                   fetch wrappers
    lib/time.ts              detectZone, zoneLabel, describeTiming, todayEt
    lib/ranges.ts            rangeFor, shiftAnchor
    lib/format.ts            formatUsd, formatEps, formatPct, formatDateHeading
    lib/storage.ts           readJson/writeJson (safe localStorage)
    lib/stale.ts             staleSources
    hooks/useHidden.ts, hooks/useZone.ts
    components/Calendar.tsx, Header.tsx, EarningsTable.tsx, DetailPanel.tsx, StaleBanner.tsx, StatusPage.tsx
  test/                      *.test.ts(x)
```

---

### Task 1: Monorepo scaffold, ticker and number parsing

**Files:**
- Create: `package.json`, `.gitignore`, `.env.example`, `server/package.json`, `server/tsconfig.json`
- Create: `server/src/domain/ticker.ts`, `server/src/domain/parse.ts`
- Test: `server/test/domain/ticker.test.ts`, `server/test/domain/parse.test.ts`

**Interfaces:**
- Produces: `normalizeTicker(symbol: string): string`; `parseNumber(input: string | number | null | undefined): number | null`; `parseIntOrNull(input): number | null`

- [ ] **Step 1: Create root files**

`package.json`:
```json
{
  "name": "earnings-app",
  "private": true,
  "workspaces": ["server"],
  "scripts": {
    "dev": "npm run dev -w server",
    "test": "npm test -w server",
    "backfill": "npm run backfill -w server"
  },
  "devDependencies": {
    "concurrently": "10.0.6"
  }
}
```

`.gitignore`:
```
node_modules/
dist/
data/
.env
*.log
```

`.env.example`:
```
# Free key from https://finnhub.io/register
FINNHUB_TOKEN=
# SEC requires a descriptive User-Agent with contact info, e.g. "EarningsCalendar/0.1 you@example.com"
SEC_USER_AGENT=
PORT=3001
# DB_PATH=./data/earnings.db
```

`server/package.json`:
```json
{
  "name": "server",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "start": "tsx src/index.ts",
    "backfill": "tsx src/cli/backfill.ts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "fastify": "5.12.7",
    "luxon": "3.7.2",
    "node-cron": "4.6.0",
    "zod": "4.6.7"
  },
  "devDependencies": {
    "@types/luxon": "3.7.6",
    "@types/node": "24.19.2",
    "tsx": "4.23.15",
    "typescript": "5.9.3",
    "vitest": "4.0.6"
  }
}
```

`server/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src", "test"]
}
```

Run: `git config user.name ainaman2512 && git config user.email your-email@example.com` (repo-local identity), then `npm install -w server` from the repo root (creates root `node_modules` and lockfile). Expected: installs without errors.

- [ ] **Step 2: Write the failing tests**

`server/test/domain/ticker.test.ts`:
```ts
import { describe, expect, test } from 'vitest';
import { normalizeTicker } from '../../src/domain/ticker.js';

describe('normalizeTicker', () => {
  test('class-share spellings from every source collapse to one key', () => {
    expect(normalizeTicker('BRK/B')).toBe('BRK-B');
    expect(normalizeTicker('BRK.B')).toBe('BRK-B');
    expect(normalizeTicker('BRK-B')).toBe('BRK-B');
  });
  test('trims and upper-cases', () => {
    expect(normalizeTicker(' jpm ')).toBe('JPM');
  });
});
```

`server/test/domain/parse.test.ts`:
```ts
import { describe, expect, test } from 'vitest';
import { parseIntOrNull, parseNumber } from '../../src/domain/parse.js';

describe('parseNumber', () => {
  test('dollar amounts with separators', () => {
    expect(parseNumber('$2,308,617,010,000')).toBe(2308617010000);
    expect(parseNumber('$4.45')).toBe(4.45);
  });
  test('negative forms', () => {
    expect(parseNumber('$-0.76')).toBe(-0.76);
    expect(parseNumber('($0.76)')).toBe(-0.76);
    expect(parseNumber('-3.2')).toBe(-3.2);
  });
  test('plain numbers and numeric input', () => {
    expect(parseNumber('10.69')).toBe(10.69);
    expect(parseNumber(7)).toBe(7);
  });
  test('missing values are null, never 0', () => {
    for (const v of [null, undefined, '', ' ', 'N/A', 'NA', '--', '-', '$']) {
      expect(parseNumber(v)).toBeNull();
    }
  });
});

describe('parseIntOrNull', () => {
  test('integers and missing', () => {
    expect(parseIntOrNull('6')).toBe(6);
    expect(parseIntOrNull('N/A')).toBeNull();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -w server`
Expected: FAIL — cannot resolve `../../src/domain/ticker.js` / `parse.js`.

- [ ] **Step 4: Implement**

`server/src/domain/ticker.ts`:
```ts
/** One key per security regardless of source spelling: BRK/B, BRK.B, BRK-B -> BRK-B. */
export function normalizeTicker(symbol: string): string {
  return symbol.trim().toUpperCase().replace(/[./]/g, '-');
}
```

`server/src/domain/parse.ts`:
```ts
const EMPTY = new Set(['', 'N/A', 'NA', '--', '-', '$']);

/** Parses vendor number strings like "$2,308,617,010,000", "$-0.76", "($0.76)". Missing -> null. */
export function parseNumber(input: string | number | null | undefined): number | null {
  if (input == null) return null;
  if (typeof input === 'number') return Number.isFinite(input) ? input : null;
  const s = input.trim();
  if (EMPTY.has(s.toUpperCase())) return null;
  const negative = s.includes('-') || (s.startsWith('(') && s.endsWith(')'));
  const digits = s.replace(/[^0-9.]/g, '');
  if (digits === '' || digits === '.') return null;
  const n = Number(digits);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

export function parseIntOrNull(input: string | number | null | undefined): number | null {
  const n = parseNumber(input);
  return n == null ? null : Math.trunc(n);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -w server`
Expected: PASS (2 files).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json .gitignore .env.example server
git commit -m "chore: scaffold workspace and add ticker/number parsing" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: NYSE market calendar

**Files:**
- Create: `server/src/domain/marketCalendar.ts`
- Test: `server/test/domain/marketCalendar.test.ts`

**Interfaces:**
- Produces: `ET = 'America/New_York'`; `isWeekend(date: string): boolean`; `isTradingDay(date: string): boolean` (throws `RangeError` outside covered years 2024–2027); `sessionClose(date: string): '16:00' | '13:00'`; `nextTradingDay(date)`, `prevTradingDay(date)`: `string`; `tradingDaysBetween(from, to): string[]` (inclusive); `addDays(date, n): string`; `todayET(now?: Date): string`. All dates `YYYY-MM-DD`.

- [ ] **Step 1: Write the failing test**

`server/test/domain/marketCalendar.test.ts`:
```ts
import { describe, expect, test } from 'vitest';
import {
  addDays, isTradingDay, isWeekend, nextTradingDay, prevTradingDay,
  sessionClose, todayET, tradingDaysBetween,
} from '../../src/domain/marketCalendar.js';

describe('market calendar', () => {
  test('weekdays trade, weekends and holidays do not', () => {
    expect(isTradingDay('2026-10-15')).toBe(true);   // Thu
    expect(isTradingDay('2026-10-17')).toBe(false);  // Sat
    expect(isTradingDay('2026-11-26')).toBe(false);  // Thanksgiving
    expect(isTradingDay('2026-07-03')).toBe(false);  // Independence Day observed
    expect(isTradingDay('2025-01-09')).toBe(false);  // National day of mourning
  });
  test('early close days', () => {
    expect(sessionClose('2026-11-27')).toBe('13:00');
    expect(sessionClose('2026-12-24')).toBe('13:00');
    expect(sessionClose('2026-10-15')).toBe('16:00');
  });
  test('next/prev trading day skip weekends and holidays', () => {
    expect(nextTradingDay('2026-11-25')).toBe('2026-11-27');
    expect(prevTradingDay('2026-10-19')).toBe('2026-10-16');
    expect(nextTradingDay('2026-10-16')).toBe('2026-10-19');
  });
  test('tradingDaysBetween is inclusive', () => {
    expect(tradingDaysBetween('2026-10-15', '2026-10-20'))
      .toEqual(['2026-10-15', '2026-10-16', '2026-10-19', '2026-10-20']);
  });
  test('uncovered years throw instead of guessing', () => {
    expect(() => isTradingDay('2030-01-02')).toThrow(RangeError);
  });
  test('isWeekend works for any year', () => {
    expect(isWeekend('2030-01-05')).toBe(true);
  });
  test('addDays and todayET', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    // 2026-10-15T03:00Z is still Oct 14 in New York
    expect(todayET(new Date('2026-10-15T03:00:00Z'))).toBe('2026-10-14');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w server -- marketCalendar`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`server/src/domain/marketCalendar.ts`:
```ts
import { DateTime } from 'luxon';

export const ET = 'America/New_York';

// NYSE full-day closures. Source: nyse.com/markets/hours-calendars. Extend yearly.
const HOLIDAYS: Record<number, string[]> = {
  2024: ['2024-01-01', '2024-01-15', '2024-02-19', '2024-03-29', '2024-05-27', '2024-06-19', '2024-07-04', '2024-09-02', '2024-11-28', '2024-12-25'],
  2025: ['2025-01-01', '2025-01-09', '2025-01-20', '2025-02-17', '2025-04-18', '2025-05-26', '2025-06-19', '2025-07-04', '2025-09-01', '2025-11-27', '2025-12-25'],
  2026: ['2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25'],
  2027: ['2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24'],
};

// NYSE 1:00 PM ET early closes.
const EARLY_CLOSES: Record<number, string[]> = {
  2024: ['2024-07-03', '2024-11-29', '2024-12-24'],
  2025: ['2025-07-03', '2025-11-28', '2025-12-24'],
  2026: ['2026-11-27', '2026-12-24'],
  2027: ['2027-11-26'],
};

function year(date: string): number {
  return Number(date.slice(0, 4));
}

function covered(date: string): number {
  const y = year(date);
  if (!(y in HOLIDAYS)) throw new RangeError(`Market calendar does not cover ${date}; add ${y} to marketCalendar.ts`);
  return y;
}

function dt(date: string): DateTime {
  return DateTime.fromISO(date, { zone: ET });
}

export function addDays(date: string, n: number): string {
  return dt(date).plus({ days: n }).toISODate()!;
}

export function isWeekend(date: string): boolean {
  return dt(date).weekday > 5;
}

export function isTradingDay(date: string): boolean {
  const y = covered(date);
  return !isWeekend(date) && !HOLIDAYS[y]!.includes(date);
}

export function sessionClose(date: string): '16:00' | '13:00' {
  const y = covered(date);
  return EARLY_CLOSES[y]!.includes(date) ? '13:00' : '16:00';
}

export function nextTradingDay(date: string): string {
  let d = addDays(date, 1);
  while (!isTradingDay(d)) d = addDays(d, 1);
  return d;
}

export function prevTradingDay(date: string): string {
  let d = addDays(date, -1);
  while (!isTradingDay(d)) d = addDays(d, -1);
  return d;
}

export function tradingDaysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) if (isTradingDay(d)) out.push(d);
  return out;
}

export function todayET(now: Date = new Date()): string {
  return DateTime.fromJSDate(now).setZone(ET).toISODate()!;
}
```

- [ ] **Step 4: Verify the holiday lists against the official source**

Open https://www.nyse.com/markets/hours-calendars and compare every date in `HOLIDAYS` and `EARLY_CLOSES` for 2026 and 2027 (2024–2025 are historical; spot-check 3 of them). Fix any mismatch before continuing — this table drives every AMC label on early-close days.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -w server -- marketCalendar`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/domain/marketCalendar.ts server/test/domain/marketCalendar.test.ts
git commit -m "feat: add NYSE trading calendar" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Surprise and expected move math

**Files:**
- Create: `server/src/types.ts`, `server/src/api/types.ts`, `server/src/domain/surprise.ts`, `server/src/domain/expectedMove.ts`
- Test: `server/test/domain/surprise.test.ts`, `server/test/domain/expectedMove.test.ts`

**Interfaces:**
- Produces (api/types.ts, shared with web): `Timing`, `TimingSource`, `SecCheck`, `BeatMiss`, `Flag`, `ReportDto`, `SourceStatusDto`, `EarningsResponse`, `StatusResponse`.
- Produces (types.ts): `CalendarRow`, `RevenueRow`, `OptionQuote`, `OptionChain`, `ExpectedMove`, `Filing`, `ReportRecord`.
- Produces: `surprisePct(actual, estimate): number | null`; `beatMiss(actual, estimate): BeatMiss | null`; `parseOptionSymbol(s): { expiry: string; type: 'C' | 'P'; strike: number } | null`; `chooseExpiry(expiries: string[], reportDate: string, timing: Timing): string | null`; `computeExpectedMove(chain: OptionChain, reportDate: string, timing: Timing): ExpectedMove | null`.

- [ ] **Step 1: Create shared types (no test needed — types only)**

`server/src/api/types.ts`:
```ts
// Type-only module shared with the web app. No runtime code here.
export type Timing = 'BMO' | 'AMC' | 'DMH' | 'UNKNOWN';
export type TimingSource = 'nasdaq' | 'finnhub' | 'sec' | null;
export type SecCheck = 'verified' | 'consistent' | 'derived' | 'contradicted' | 'unverifiable';
export type BeatMiss = 'beat' | 'miss' | 'inline';

export interface Flag {
  field: 'timing' | 'marketCap' | 'expectedMove';
  message: string;
}

export interface ResultPart {
  estimate: number | null;
  actual: number | null;
  surprisePct: number | null;
  result: BeatMiss | null;
}

export interface ReportDto {
  id: number;
  symbol: string;
  name: string;
  reportDate: string;
  fiscalQuarter: string | null;
  timing: Timing;
  timingSource: TimingSource;
  sessionClose: '16:00' | '13:00';
  rescheduledFrom: string | null;
  exchange: string | null;
  marketCap: number | null;
  marketCapAsOf: string | null;
  eps: ResultPart & { noOfEsts: number | null };
  revenue: ResultPart;
  expectedMove: {
    movePct: number;
    illiquid: boolean;
    expiry: string;
    strike: number;
    callMid: number;
    putMid: number;
    underlying: number;
    snapshotAt: string;
  } | null;
  sec: { check: SecCheck | null; acceptedAt: string | null; docUrl: string | null; indexUrl: string | null };
  fetched: { calendar: string | null; revenue: string | null; sec: string | null };
  flags: Flag[];
}

export interface SourceStatusDto {
  source: string;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
}

export interface EarningsResponse {
  rows: ReportDto[];
  sources: SourceStatusDto[];
}

export interface StatusResponse {
  sources: SourceStatusDto[];
  counts: { reports: number; withExpectedMove: number; secVerified: number };
}
```

`server/src/types.ts`:
```ts
import type { SecCheck, Timing, TimingSource } from './api/types.js';
export type { SecCheck, Timing, TimingSource } from './api/types.js';

/** One row of the Nasdaq earnings calendar for one date. */
export interface CalendarRow {
  symbol: string;
  name: string;
  reportDate: string;        // YYYY-MM-DD
  fiscalQuarter: string;     // e.g. "Sep/2026", or "date:<reportDate>" when missing
  timing: Timing;
  marketCap: number | null;
  epsEstimate: number | null;
  noOfEsts: number | null;
  epsActual: number | null;
  epsSurprisePct: number | null;
}

/** One Finnhub earnings-calendar item (revenue + timing hint). */
export interface RevenueRow {
  symbol: string;
  reportDate: string;
  timing: Timing;
  revenueEstimate: number | null;
  revenueActual: number | null;
}

export interface OptionQuote {
  expiry: string;            // YYYY-MM-DD
  type: 'C' | 'P';
  strike: number;
  bid: number;
  ask: number;
}

export interface OptionChain {
  underlying: number;
  quotes: OptionQuote[];
}

export interface ExpectedMove {
  expiry: string;
  strike: number;
  callMid: number;
  putMid: number;
  underlying: number;
  movePct: number;           // rounded to 2 decimals
  illiquid: boolean;
}

/** An 8-K containing Item 2.02 (results of operations). */
export interface Filing {
  accession: string;         // e.g. 0001628280-26-065582
  filingDate: string;        // YYYY-MM-DD
  docUrl: string;
  indexUrl: string;
}

export interface ReportRecord {
  id: number;
  symbol: string;
  symbolKey: string;
  name: string;
  fiscalQuarter: string;
  reportDate: string;
  rescheduledFrom: string | null;
  timing: Timing;
  timingSource: TimingSource;
  timingConflict: string | null;
  marketCap: number | null;
  marketCapAsOf: string | null;
  epsEstimate: number | null;
  epsActual: number | null;
  epsSurprisePct: number | null;
  noOfEsts: number | null;
  revenueEstimate: number | null;
  revenueActual: number | null;
  exchange: string | null;
  secCheck: SecCheck | null;
  secAcceptedAt: string | null;   // ET wall clock, YYYY-MM-DDTHH:mm:ss
  secDocUrl: string | null;
  secIndexUrl: string | null;
  calendarFetchedAt: string | null;
  revenueFetchedAt: string | null;
  secCheckedAt: string | null;
  expectedMove: (ExpectedMove & { snapshotAt: string }) | null;
}
```

- [ ] **Step 2: Write the failing tests**

`server/test/domain/surprise.test.ts`:
```ts
import { describe, expect, test } from 'vitest';
import { beatMiss, surprisePct } from '../../src/domain/surprise.js';

describe('surprisePct', () => {
  test('positive and negative estimates use |estimate|', () => {
    expect(surprisePct(1.71, 1.66)).toBe(3.0);
    expect(surprisePct(-0.76, -0.71)).toBe(-7.0);
    expect(surprisePct(5.75, 5.94)).toBe(-3.2);
  });
  test('zero or missing estimate -> null', () => {
    expect(surprisePct(1, 0)).toBeNull();
    expect(surprisePct(1, null)).toBeNull();
    expect(surprisePct(null, 1)).toBeNull();
  });
});

describe('beatMiss', () => {
  test('classifies', () => {
    expect(beatMiss(1.71, 1.66)).toBe('beat');
    expect(beatMiss(1.6, 1.66)).toBe('miss');
    expect(beatMiss(1.66, 1.66)).toBe('inline');
    expect(beatMiss(null, 1.66)).toBeNull();
    expect(beatMiss(1.66, null)).toBeNull();
  });
});
```

`server/test/domain/expectedMove.test.ts`:
```ts
import { describe, expect, test } from 'vitest';
import { chooseExpiry, computeExpectedMove, parseOptionSymbol } from '../../src/domain/expectedMove.js';
import type { OptionChain, OptionQuote } from '../../src/types.js';

const q = (expiry: string, type: 'C' | 'P', strike: number, bid: number, ask: number): OptionQuote =>
  ({ expiry, type, strike, bid, ask });

function chain(underlying: number, extra: OptionQuote[] = []): OptionChain {
  return {
    underlying,
    quotes: [
      q('2026-10-16', 'C', 95, 6.0, 6.4), q('2026-10-16', 'P', 95, 0.9, 1.1),
      q('2026-10-16', 'C', 100, 2.9, 3.1), q('2026-10-16', 'P', 100, 2.9, 3.1),
      q('2026-10-16', 'C', 105, 0.9, 1.1), q('2026-10-16', 'P', 105, 6.0, 6.4),
      q('2026-10-23', 'C', 100, 4.4, 4.6), q('2026-10-23', 'P', 100, 4.4, 4.6),
      ...extra,
    ],
  };
}

describe('parseOptionSymbol', () => {
  test('OCC-style symbols', () => {
    expect(parseOptionSymbol('JPM261016C00180000')).toEqual({ expiry: '2026-10-16', type: 'C', strike: 180 });
    expect(parseOptionSymbol('BRKB261016P00412500')).toEqual({ expiry: '2026-10-16', type: 'P', strike: 412.5 });
    expect(parseOptionSymbol('garbage')).toBeNull();
  });
});

describe('chooseExpiry', () => {
  const exp = ['2026-10-23', '2026-10-16', '2026-10-16'];
  test('BMO may use an expiry on the report date', () => {
    expect(chooseExpiry(exp, '2026-10-16', 'BMO')).toBe('2026-10-16');
  });
  test('AMC, DMH and UNKNOWN need an expiry strictly after the report date', () => {
    expect(chooseExpiry(exp, '2026-10-16', 'AMC')).toBe('2026-10-23');
    expect(chooseExpiry(exp, '2026-10-16', 'DMH')).toBe('2026-10-23');
    expect(chooseExpiry(exp, '2026-10-16', 'UNKNOWN')).toBe('2026-10-23');
  });
  test('none qualifies -> null', () => {
    expect(chooseExpiry(exp, '2026-10-23', 'AMC')).toBeNull();
  });
});

describe('computeExpectedMove', () => {
  test('ATM straddle mid / price', () => {
    expect(computeExpectedMove(chain(100), '2026-10-16', 'BMO')).toEqual({
      expiry: '2026-10-16', strike: 100, callMid: 3, putMid: 3, underlying: 100, movePct: 6, illiquid: false,
    });
  });
  test('AMC uses the next expiry', () => {
    expect(computeExpectedMove(chain(100), '2026-10-16', 'AMC')?.movePct).toBe(9);
  });
  test('equidistant strikes pick the lower one', () => {
    const em = computeExpectedMove(chain(102.5), '2026-10-16', 'BMO');
    expect(em?.strike).toBe(100);
    expect(em?.movePct).toBe(5.85);
  });
  test('zero bid is flagged illiquid', () => {
    const c = chain(100);
    c.quotes = c.quotes.map((x) => (x.expiry === '2026-10-16' && x.strike === 100 && x.type === 'P' ? { ...x, bid: 0 } : x));
    expect(computeExpectedMove(c, '2026-10-16', 'BMO')?.illiquid).toBe(true);
  });
  test('spread over 30% of mid is flagged illiquid', () => {
    const c = chain(100);
    c.quotes = c.quotes.map((x) => (x.expiry === '2026-10-16' && x.strike === 100 && x.type === 'C' ? { ...x, bid: 2, ask: 4 } : x));
    expect(computeExpectedMove(c, '2026-10-16', 'BMO')?.illiquid).toBe(true);
  });
  test('strikes with no ask (no market) are skipped before choosing ATM', () => {
    const c = chain(100);
    c.quotes = c.quotes.map((x) => (x.expiry === '2026-10-16' && x.strike === 100 ? { ...x, bid: 0, ask: 0 } : x));
    // 95 and 105 are equidistant from 100; the lower one wins.
    expect(computeExpectedMove(c, '2026-10-16', 'BMO')?.strike).toBe(95);
  });
  test('strike must have both call and put', () => {
    const c: OptionChain = { underlying: 100, quotes: [q('2026-10-16', 'C', 100, 2.9, 3.1)] };
    expect(computeExpectedMove(c, '2026-10-16', 'BMO')).toBeNull();
  });
  test('no options or bad price -> null', () => {
    expect(computeExpectedMove({ underlying: 100, quotes: [] }, '2026-10-16', 'BMO')).toBeNull();
    expect(computeExpectedMove({ ...chain(100), underlying: 0 }, '2026-10-16', 'BMO')).toBeNull();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -w server -- surprise expectedMove`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement**

`server/src/domain/surprise.ts`:
```ts
import type { BeatMiss } from '../api/types.js';

export function surprisePct(actual: number | null, estimate: number | null): number | null {
  if (actual == null || estimate == null || estimate === 0) return null;
  return Math.round(((actual - estimate) / Math.abs(estimate)) * 1000) / 10;
}

export function beatMiss(actual: number | null, estimate: number | null): BeatMiss | null {
  if (actual == null || estimate == null) return null;
  if (actual > estimate) return 'beat';
  if (actual < estimate) return 'miss';
  return 'inline';
}
```

`server/src/domain/expectedMove.ts`:
```ts
import type { ExpectedMove, OptionChain, OptionQuote, Timing } from '../types.js';

const SYMBOL = /(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/;

export function parseOptionSymbol(symbol: string): { expiry: string; type: 'C' | 'P'; strike: number } | null {
  const m = SYMBOL.exec(symbol);
  if (!m) return null;
  const [, yy, mm, dd, type, strike] = m;
  return { expiry: `20${yy}-${mm}-${dd}`, type: type as 'C' | 'P', strike: Number(strike) / 1000 };
}

/** First expiry that captures the earnings reaction (spec 6.2 step 1). */
export function chooseExpiry(expiries: string[], reportDate: string, timing: Timing): string | null {
  const sorted = [...new Set(expiries)].sort();
  const found = timing === 'BMO' ? sorted.find((e) => e >= reportDate) : sorted.find((e) => e > reportDate);
  return found ?? null;
}

const mid = (o: OptionQuote) => (o.bid + o.ask) / 2;
const twoSided = (o: OptionQuote | undefined): o is OptionQuote => !!o && o.ask > 0 && o.bid >= 0 && o.ask >= o.bid;

export function computeExpectedMove(chain: OptionChain, reportDate: string, timing: Timing): ExpectedMove | null {
  const u = chain.underlying;
  if (!(u > 0)) return null;
  const expiry = chooseExpiry(chain.quotes.map((x) => x.expiry), reportDate, timing);
  if (!expiry) return null;

  const atExpiry = chain.quotes.filter((x) => x.expiry === expiry);
  const pairs = new Map<number, { call?: OptionQuote; put?: OptionQuote }>();
  for (const o of atExpiry) {
    const p = pairs.get(o.strike) ?? {};
    if (o.type === 'C') p.call = o;
    else p.put = o;
    pairs.set(o.strike, p);
  }
  const strikes = [...pairs.entries()]
    .filter(([, p]) => twoSided(p.call) && twoSided(p.put))
    .map(([k]) => k)
    .sort((a, b) => a - b);
  if (strikes.length === 0) return null;

  let strike = strikes[0]!;
  for (const k of strikes) if (Math.abs(k - u) < Math.abs(strike - u)) strike = k;

  const { call, put } = pairs.get(strike)! as { call: OptionQuote; put: OptionQuote };
  const callMid = mid(call);
  const putMid = mid(put);
  const illiquid =
    call.bid <= 0 || put.bid <= 0 ||
    call.ask - call.bid > 0.3 * callMid || put.ask - put.bid > 0.3 * putMid;

  return {
    expiry,
    strike,
    callMid,
    putMid,
    underlying: u,
    movePct: Math.round(((callMid + putMid) / u) * 10000) / 100,
    illiquid,
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -w server -- surprise expectedMove`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/types.ts server/src/api/types.ts server/src/domain/surprise.ts server/src/domain/expectedMove.ts server/test/domain
git commit -m "feat: add surprise and options-implied move calculations" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: SEC timing classification

**Files:**
- Create: `server/src/domain/secTiming.ts`
- Test: `server/test/domain/secTiming.test.ts`

**Interfaces:**
- Consumes: `sessionClose` (Task 2), `Timing`, `SecCheck` (Task 3).
- Produces: `type SecDerived = 'BMO' | 'AMC' | 'BEFORE_CLOSE' | null`; `deriveFromAcceptance(reportDate: string, acceptedEt: string): SecDerived` (`acceptedEt` = `YYYY-MM-DDTHH:mm:ss` ET wall clock); `checkTiming(label: Timing, derived: SecDerived): { check: SecCheck; timing: Timing }`.

- [ ] **Step 1: Write the failing test**

`server/test/domain/secTiming.test.ts`:
```ts
import { describe, expect, test } from 'vitest';
import { checkTiming, deriveFromAcceptance } from '../../src/domain/secTiming.js';

describe('deriveFromAcceptance', () => {
  test('real JPM case: 06:30:38 ET on report day is before the open', () => {
    expect(deriveFromAcceptance('2026-10-13', '2026-10-13T06:30:38')).toBe('BMO');
  });
  test('boundaries', () => {
    expect(deriveFromAcceptance('2026-10-13', '2026-10-13T09:29:59')).toBe('BMO');
    expect(deriveFromAcceptance('2026-10-13', '2026-10-13T09:30:00')).toBe('BEFORE_CLOSE');
    expect(deriveFromAcceptance('2026-10-13', '2026-10-13T15:59:59')).toBe('BEFORE_CLOSE');
    expect(deriveFromAcceptance('2026-10-13', '2026-10-13T16:00:00')).toBe('AMC');
  });
  test('early close day uses 13:00', () => {
    expect(deriveFromAcceptance('2026-11-27', '2026-11-27T13:05:00')).toBe('AMC');
    expect(deriveFromAcceptance('2026-11-27', '2026-11-27T12:59:00')).toBe('BEFORE_CLOSE');
  });
  test('filing on another day proves nothing', () => {
    expect(deriveFromAcceptance('2026-10-13', '2026-10-12T17:00:00')).toBeNull();
  });
});

describe('checkTiming (spec 6.6 table)', () => {
  const cases: [Parameters<typeof checkTiming>[0], Parameters<typeof checkTiming>[1], string, string][] = [
    ['BMO', 'BMO', 'verified', 'BMO'],
    ['BMO', 'BEFORE_CLOSE', 'unverifiable', 'BMO'],
    ['BMO', 'AMC', 'unverifiable', 'BMO'],
    ['AMC', 'BMO', 'contradicted', 'AMC'],
    ['AMC', 'BEFORE_CLOSE', 'contradicted', 'AMC'],
    ['AMC', 'AMC', 'consistent', 'AMC'],
    ['DMH', 'BMO', 'contradicted', 'DMH'],
    ['DMH', 'BEFORE_CLOSE', 'consistent', 'DMH'],
    ['DMH', 'AMC', 'unverifiable', 'DMH'],
    ['UNKNOWN', 'BMO', 'derived', 'BMO'],
    ['UNKNOWN', 'BEFORE_CLOSE', 'unverifiable', 'UNKNOWN'],
    ['UNKNOWN', 'AMC', 'unverifiable', 'UNKNOWN'],
    ['AMC', null, 'unverifiable', 'AMC'],
    ['UNKNOWN', null, 'unverifiable', 'UNKNOWN'],
  ];
  test.each(cases)('label %s + derived %s -> %s (%s)', (label, derived, check, timing) => {
    expect(checkTiming(label, derived)).toEqual({ check, timing });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w server -- secTiming`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`server/src/domain/secTiming.ts`:
```ts
import type { SecCheck, Timing } from '../types.js';
import { sessionClose } from './marketCalendar.js';

export type SecDerived = 'BMO' | 'AMC' | 'BEFORE_CLOSE' | null;

/**
 * acceptedEt is the SGML header ACCEPTANCE-DATETIME as ET wall clock (YYYY-MM-DDTHH:mm:ss).
 * An 8-K is filed at or after the release, so this is an upper bound on the release time.
 */
export function deriveFromAcceptance(reportDate: string, acceptedEt: string): SecDerived {
  if (acceptedEt.slice(0, 10) !== reportDate) return null;
  const time = acceptedEt.slice(11, 19);
  if (time < '09:30:00') return 'BMO';
  if (time >= `${sessionClose(reportDate)}:00`) return 'AMC';
  return 'BEFORE_CLOSE';
}

/** Spec 6.6 table. The upper bound can prove BMO or disprove AMC, never prove AMC. */
export function checkTiming(label: Timing, derived: SecDerived): { check: SecCheck; timing: Timing } {
  const r = (check: SecCheck, timing: Timing = label) => ({ check, timing });
  if (derived === null) return r('unverifiable');
  switch (label) {
    case 'BMO':
      return derived === 'BMO' ? r('verified') : r('unverifiable');
    case 'AMC':
      return derived === 'AMC' ? r('consistent') : r('contradicted');
    case 'DMH':
      if (derived === 'BMO') return r('contradicted');
      return derived === 'BEFORE_CLOSE' ? r('consistent') : r('unverifiable');
    case 'UNKNOWN':
      return derived === 'BMO' ? r('derived', 'BMO') : r('unverifiable');
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w server -- secTiming`
Expected: PASS (all 14 table rows + boundary tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/domain/secTiming.ts server/test/domain/secTiming.test.ts
git commit -m "feat: classify release timing from SEC acceptance time" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: HTTP client and Nasdaq calendar source

**Files:**
- Create: `server/src/sources/http.ts`, `server/src/sources/nasdaq.ts`
- Test: `server/test/sources/http.test.ts`, `server/test/sources/nasdaq.test.ts`

**Interfaces:**
- Consumes: `parseNumber`, `parseIntOrNull` (Task 1); `CalendarRow`, `Timing` (Task 3).
- Produces: `class HttpError extends Error { status: number }`; `class SourceFormatError extends Error`; `interface Http { json(url: string): Promise<unknown>; text(url: string): Promise<string> }`; `makeHttp(opts: { headers?: Record<string,string>; minIntervalMs: number; timeoutMs?: number; retries?: number; backoffMs?: number; fetchImpl?: typeof fetch }): Http`; `BROWSER_UA: string`; `nasdaqTiming(time: string | null | undefined): Timing`; `parseNasdaqCalendar(json: unknown, date: string): CalendarRow[]`; `fetchNasdaqCalendar(http: Http, date: string): Promise<CalendarRow[]>`.

- [ ] **Step 1: Write the failing tests**

`server/test/sources/http.test.ts`:
```ts
import { describe, expect, test, vi } from 'vitest';
import { HttpError, makeHttp } from '../../src/sources/http.js';

const res = (status: number, body: unknown) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

describe('makeHttp', () => {
  test('retries 5xx then succeeds', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(res(503, 'busy'))
      .mockResolvedValueOnce(res(200, { ok: true }));
    const http = makeHttp({ minIntervalMs: 0, backoffMs: 0, fetchImpl });
    await expect(http.json('https://x.test/a')).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  test('404 is not retried and throws HttpError with status', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(404, 'nope'));
    const http = makeHttp({ minIntervalMs: 0, backoffMs: 0, fetchImpl });
    await expect(http.json('https://x.test/a')).rejects.toMatchObject({ status: 404 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  test('gives up after retries', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(500, 'err'));
    const http = makeHttp({ minIntervalMs: 0, backoffMs: 0, retries: 2, fetchImpl });
    await expect(http.json('https://x.test/a')).rejects.toBeInstanceOf(HttpError);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
  test('sends configured headers and returns text', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(200, 'hello'));
    const http = makeHttp({ minIntervalMs: 0, headers: { 'User-Agent': 'UA' }, fetchImpl });
    await expect(http.text('https://x.test/t')).resolves.toBe('hello');
    expect(fetchImpl.mock.calls[0]![1].headers).toEqual({ 'User-Agent': 'UA' });
  });
});
```

`server/test/sources/nasdaq.test.ts`:
```ts
import { describe, expect, test } from 'vitest';
import { nasdaqTiming, parseNasdaqCalendar } from '../../src/sources/nasdaq.js';
import { SourceFormatError } from '../../src/sources/http.js';

// Shapes copied from live responses on 2026-10-15.
const upcoming = {
  data: {
    asOf: 'Thu, Oct 15, 2026',
    rows: [
      { lastYearRptDt: '10/16/2025', lastYearEPS: '$1.31', time: 'time-pre-market', symbol: 'SCHW',
        name: 'The Charles Schwab Corporation', marketCap: '$165,912,461,000', fiscalQuarterEnding: 'Sep/2026',
        epsForecast: '$1.66', noOfEsts: '10' },
      { time: 'time-after-hours', symbol: 'BRK/B', name: ' Berkshire ', marketCap: 'N/A',
        fiscalQuarterEnding: null, epsForecast: '', noOfEsts: 'N/A' },
    ],
  },
};
const past = {
  data: { rows: [
    { eps: '$5.75', surprise: '-3.2', time: 'time-not-supplied', symbol: 'JPM', name: 'J P Morgan Chase & Co',
      marketCap: '$881,002,680,000', fiscalQuarterEnding: 'Sep/2026', epsForecast: '$5.94', noOfEsts: '6' },
  ] },
};
const weekend = { data: { asOf: 'Sun, Oct 18, 2026', headers: null, rows: null }, message: null, status: { rCode: 200 } };

describe('nasdaqTiming', () => {
  test('maps known values, anything else is UNKNOWN', () => {
    expect(nasdaqTiming('time-pre-market')).toBe('BMO');
    expect(nasdaqTiming('time-after-hours')).toBe('AMC');
    expect(nasdaqTiming('time-not-supplied')).toBe('UNKNOWN');
    expect(nasdaqTiming(undefined)).toBe('UNKNOWN');
  });
});

describe('parseNasdaqCalendar', () => {
  test('upcoming rows', () => {
    const rows = parseNasdaqCalendar(upcoming, '2026-10-15');
    expect(rows[0]).toEqual({
      symbol: 'SCHW', name: 'The Charles Schwab Corporation', reportDate: '2026-10-15', fiscalQuarter: 'Sep/2026',
      timing: 'BMO', marketCap: 165912461000, epsEstimate: 1.66, noOfEsts: 10, epsActual: null, epsSurprisePct: null,
    });
    expect(rows[1]).toMatchObject({
      symbol: 'BRK/B', name: 'Berkshire', timing: 'AMC', marketCap: null, epsEstimate: null, noOfEsts: null,
      fiscalQuarter: 'date:2026-10-15',
    });
  });
  test('past rows carry actuals', () => {
    expect(parseNasdaqCalendar(past, '2026-10-13')[0]).toMatchObject({ epsActual: 5.75, epsSurprisePct: -3.2, timing: 'UNKNOWN' });
  });
  test('weekend response yields no rows', () => {
    expect(parseNasdaqCalendar(weekend, '2026-10-18')).toEqual([]);
  });
  test('unexpected shape throws SourceFormatError', () => {
    expect(() => parseNasdaqCalendar({ data: { rows: [{ symbol: 5 }] } }, '2026-10-15')).toThrow(SourceFormatError);
    expect(() => parseNasdaqCalendar('<html>blocked</html>', '2026-10-15')).toThrow(SourceFormatError);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w server -- http nasdaq`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`server/src/sources/http.ts`:
```ts
export class HttpError extends Error {
  constructor(public readonly status: number, url: string) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpError';
  }
}

/** The source answered, but not in the shape we know. Never store anything from it. */
export class SourceFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceFormatError';
  }
}

export interface Http {
  json(url: string): Promise<unknown>;
  text(url: string): Promise<string>;
}

export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

class RateLimiter {
  private next = 0;
  constructor(private readonly minIntervalMs: number) {}
  async wait(): Promise<void> {
    const now = Date.now();
    const slot = Math.max(now, this.next);
    this.next = slot + this.minIntervalMs;
    if (slot > now) await sleep(slot - now);
  }
}

export function makeHttp(opts: {
  headers?: Record<string, string>;
  minIntervalMs: number;
  timeoutMs?: number;
  retries?: number;
  backoffMs?: number;
  fetchImpl?: typeof fetch;
}): Http {
  const { headers = {}, minIntervalMs, timeoutMs = 20_000, retries = 2, backoffMs = 2_000, fetchImpl = fetch } = opts;
  const limiter = new RateLimiter(minIntervalMs);

  async function get(url: string): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      await limiter.wait();
      try {
        const res = await fetchImpl(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
        if (res.ok) return res;
        const retryable = res.status === 429 || res.status >= 500;
        if (!retryable || attempt >= retries) throw new HttpError(res.status, url);
      } catch (err) {
        if (err instanceof HttpError && (err.status < 500 && err.status !== 429)) throw err;
        if (attempt >= retries) throw err;
      }
      await sleep(backoffMs * (attempt + 1));
    }
  }

  return {
    json: async (url) => (await get(url)).json(),
    text: async (url) => (await get(url)).text(),
  };
}
```

`server/src/sources/nasdaq.ts`:
```ts
import { z } from 'zod';
import { parseIntOrNull, parseNumber } from '../domain/parse.js';
import type { CalendarRow, Timing } from '../types.js';
import { type Http, SourceFormatError } from './http.js';

const Str = z.union([z.string(), z.number()]).nullish().transform((v) => (v == null ? null : String(v)));

const RowSchema = z.object({
  symbol: z.string(),
  name: z.string(),
  time: z.string().nullish(),
  marketCap: Str,
  fiscalQuarterEnding: z.string().nullish(),
  epsForecast: Str,
  noOfEsts: Str,
  eps: Str,
  surprise: Str,
});

const ResponseSchema = z.object({
  data: z.object({ rows: z.array(RowSchema).nullish() }).nullish(),
});

export function nasdaqTiming(time: string | null | undefined): Timing {
  if (time === 'time-pre-market') return 'BMO';
  if (time === 'time-after-hours') return 'AMC';
  return 'UNKNOWN';
}

export function parseNasdaqCalendar(json: unknown, date: string): CalendarRow[] {
  const parsed = ResponseSchema.safeParse(json);
  if (!parsed.success) throw new SourceFormatError(`Nasdaq calendar ${date}: ${parsed.error.message}`);
  return (parsed.data.data?.rows ?? [])
    .filter((r) => r.symbol.trim() !== '')
    .map((r) => ({
      symbol: r.symbol.trim(),
      name: r.name.trim(),
      reportDate: date,
      fiscalQuarter: r.fiscalQuarterEnding?.trim() || `date:${date}`,
      timing: nasdaqTiming(r.time),
      marketCap: parseNumber(r.marketCap),
      epsEstimate: parseNumber(r.epsForecast),
      noOfEsts: parseIntOrNull(r.noOfEsts),
      epsActual: parseNumber(r.eps),
      epsSurprisePct: parseNumber(r.surprise),
    }));
}

export async function fetchNasdaqCalendar(http: Http, date: string): Promise<CalendarRow[]> {
  return parseNasdaqCalendar(await http.json(`https://api.nasdaq.com/api/calendar/earnings?date=${date}`), date);
}
```

Note: `http.json` on an HTML block page throws a `SyntaxError` from `res.json()`; that propagates as a fetch failure (recorded in status), same as an HTTP error.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w server -- http nasdaq`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/sources server/test/sources
git commit -m "feat: add rate-limited http client and Nasdaq calendar source" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Finnhub and Cboe sources

**Files:**
- Create: `server/src/sources/finnhub.ts`, `server/src/sources/cboe.ts`
- Test: `server/test/sources/finnhub.test.ts`, `server/test/sources/cboe.test.ts`

**Interfaces:**
- Consumes: `Http`, `HttpError`, `SourceFormatError` (Task 5); `parseOptionSymbol` (Task 3); `RevenueRow`, `OptionChain`, `Timing` (Task 3).
- Produces: `finnhubTiming(hour): Timing`; `parseFinnhubEarnings(json: unknown): RevenueRow[]`; `fetchFinnhubEarnings(http: Http, from: string, to: string): Promise<RevenueRow[]>`; `parseCboeChain(json: unknown): OptionChain | null`; `fetchCboeChain(http: Http, symbol: string): Promise<OptionChain | null>`.

- [ ] **Step 1: Write the failing tests**

`server/test/sources/finnhub.test.ts`:
```ts
import { describe, expect, test } from 'vitest';
import { finnhubTiming, parseFinnhubEarnings } from '../../src/sources/finnhub.js';
import { SourceFormatError } from '../../src/sources/http.js';

// Shape per Finnhub /calendar/earnings docs; numbers are test values.
const body = {
  earningsCalendar: [
    { date: '2026-10-13', epsActual: 5.75, epsEstimate: 5.94, hour: 'bmo', quarter: 3,
      revenueActual: 47_100_000_000, revenueEstimate: 46_500_000_000, symbol: 'JPM', year: 2026 },
    { date: '2026-10-15', epsActual: null, epsEstimate: 1.2, hour: '', quarter: 3,
      revenueActual: null, revenueEstimate: null, symbol: 'BRK.B', year: 2026 },
  ],
};

describe('finnhub', () => {
  test('hour mapping', () => {
    expect(finnhubTiming('bmo')).toBe('BMO');
    expect(finnhubTiming('amc')).toBe('AMC');
    expect(finnhubTiming('dmh')).toBe('DMH');
    expect(finnhubTiming('')).toBe('UNKNOWN');
    expect(finnhubTiming(null)).toBe('UNKNOWN');
  });
  test('parses items', () => {
    expect(parseFinnhubEarnings(body)).toEqual([
      { symbol: 'JPM', reportDate: '2026-10-13', timing: 'BMO', revenueEstimate: 46_500_000_000, revenueActual: 47_100_000_000 },
      { symbol: 'BRK.B', reportDate: '2026-10-15', timing: 'UNKNOWN', revenueEstimate: null, revenueActual: null },
    ]);
  });
  test('bad shape throws', () => {
    expect(() => parseFinnhubEarnings({ error: 'You don\'t have access' })).toThrow(SourceFormatError);
  });
});
```

`server/test/sources/cboe.test.ts`:
```ts
import { describe, expect, test, vi } from 'vitest';
import { fetchCboeChain, parseCboeChain } from '../../src/sources/cboe.js';
import { HttpError, SourceFormatError } from '../../src/sources/http.js';

// Shape copied from live JPM response on 2026-10-15 (trimmed).
const body = {
  timestamp: '2026-10-15 02:18:14',
  data: {
    symbol: 'JPM', current_price: 335.9,
    options: [
      { option: 'JPM261016C00180000', bid: 153.3, ask: 157.25, iv: 0 },
      { option: 'JPM261016P00180000', bid: 0, ask: 0.01, iv: 2.5 },
      { option: 'WEIRD', bid: 1, ask: 2 },
    ],
  },
};

describe('cboe', () => {
  test('parses chain and skips unparseable symbols', () => {
    expect(parseCboeChain(body)).toEqual({
      underlying: 335.9,
      quotes: [
        { expiry: '2026-10-16', type: 'C', strike: 180, bid: 153.3, ask: 157.25 },
        { expiry: '2026-10-16', type: 'P', strike: 180, bid: 0, ask: 0.01 },
      ],
    });
  });
  test('missing price -> null', () => {
    expect(parseCboeChain({ data: { current_price: null, options: [] } })).toBeNull();
  });
  test('bad shape throws', () => {
    expect(() => parseCboeChain({ nope: 1 })).toThrow(SourceFormatError);
  });
  test('403/404 means no options listed -> null', async () => {
    const http = { json: vi.fn().mockRejectedValue(new HttpError(403, 'u')), text: vi.fn() };
    await expect(fetchCboeChain(http, 'ZZZZ')).resolves.toBeNull();
  });
  test('class shares use a dot for Cboe', async () => {
    const http = { json: vi.fn().mockResolvedValue(body), text: vi.fn() };
    await fetchCboeChain(http, 'BRK/B');
    expect(http.json).toHaveBeenCalledWith('https://cdn.cboe.com/api/global/delayed_quotes/options/BRK.B.json');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w server -- finnhub cboe`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`server/src/sources/finnhub.ts`:
```ts
import { z } from 'zod';
import type { RevenueRow, Timing } from '../types.js';
import { type Http, SourceFormatError } from './http.js';

const ItemSchema = z.object({
  symbol: z.string(),
  date: z.string(),
  hour: z.string().nullish(),
  revenueActual: z.number().nullish(),
  revenueEstimate: z.number().nullish(),
});
const ResponseSchema = z.object({ earningsCalendar: z.array(ItemSchema) });

export function finnhubTiming(hour: string | null | undefined): Timing {
  if (hour === 'bmo') return 'BMO';
  if (hour === 'amc') return 'AMC';
  if (hour === 'dmh') return 'DMH';
  return 'UNKNOWN';
}

export function parseFinnhubEarnings(json: unknown): RevenueRow[] {
  const parsed = ResponseSchema.safeParse(json);
  if (!parsed.success) throw new SourceFormatError(`Finnhub earnings: ${parsed.error.message}`);
  return parsed.data.earningsCalendar.map((i) => ({
    symbol: i.symbol.trim(),
    reportDate: i.date,
    timing: finnhubTiming(i.hour),
    revenueEstimate: i.revenueEstimate ?? null,
    revenueActual: i.revenueActual ?? null,
  }));
}

/** Token is sent by makeHttp as the X-Finnhub-Token header, never in the URL. */
export async function fetchFinnhubEarnings(http: Http, from: string, to: string): Promise<RevenueRow[]> {
  return parseFinnhubEarnings(await http.json(`https://finnhub.io/api/v1/calendar/earnings?from=${from}&to=${to}`));
}
```

`server/src/sources/cboe.ts`:
```ts
import { z } from 'zod';
import { parseOptionSymbol } from '../domain/expectedMove.js';
import type { OptionChain, OptionQuote } from '../types.js';
import { type Http, HttpError, SourceFormatError } from './http.js';

const ResponseSchema = z.object({
  data: z.object({
    current_price: z.number().nullish(),
    options: z.array(z.object({ option: z.string(), bid: z.number().nullish(), ask: z.number().nullish() })),
  }),
});

export function parseCboeChain(json: unknown): OptionChain | null {
  const parsed = ResponseSchema.safeParse(json);
  if (!parsed.success) throw new SourceFormatError(`Cboe chain: ${parsed.error.message}`);
  const { current_price, options } = parsed.data.data;
  if (!current_price || current_price <= 0) return null;
  const quotes: OptionQuote[] = [];
  for (const o of options) {
    const p = parseOptionSymbol(o.option);
    if (p) quotes.push({ ...p, bid: o.bid ?? 0, ask: o.ask ?? 0 });
  }
  return { underlying: current_price, quotes };
}

export async function fetchCboeChain(http: Http, symbol: string): Promise<OptionChain | null> {
  const cboeSymbol = symbol.trim().toUpperCase().replace('/', '.');
  try {
    return parseCboeChain(await http.json(`https://cdn.cboe.com/api/global/delayed_quotes/options/${cboeSymbol}.json`));
  } catch (err) {
    if (err instanceof HttpError && (err.status === 403 || err.status === 404)) return null;
    throw err;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w server -- finnhub cboe`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/sources/finnhub.ts server/src/sources/cboe.ts server/test/sources/finnhub.test.ts server/test/sources/cboe.test.ts
git commit -m "feat: add Finnhub revenue and Cboe options sources" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: SEC EDGAR source

**Files:**
- Create: `server/src/sources/sec.ts`
- Test: `server/test/sources/sec.test.ts`

**Interfaces:**
- Consumes: `Http`, `SourceFormatError` (Task 5); `normalizeTicker` (Task 1); `Filing` (Task 3).
- Produces: `interface SecTicker { cik: number; exchange: string | null }`; `parseSecTickers(json): Map<string, SecTicker>` (keyed by `normalizeTicker`); `parseEarningsFilings(json, cik: number): Filing[]`; `parseAcceptance(text: string): string` (returns `YYYY-MM-DDTHH:mm:ss` ET); `fetchSecTickers(http)`, `fetchEarningsFilings(http, cik)`, `fetchAcceptance(http, cik, accession)`.

- [ ] **Step 1: Write the failing test**

`server/test/sources/sec.test.ts`:
```ts
import { describe, expect, test, vi } from 'vitest';
import {
  fetchAcceptance, parseAcceptance, parseEarningsFilings, parseSecTickers,
} from '../../src/sources/sec.js';
import { SourceFormatError } from '../../src/sources/http.js';

// Shapes copied from live responses on 2026-10-15.
const tickers = {
  fields: ['cik', 'name', 'ticker', 'exchange'],
  data: [
    [19617, 'JPMORGAN CHASE & CO', 'JPM', 'NYSE'],
    [1067983, 'BERKSHIRE HATHAWAY INC', 'BRK-B', 'NYSE'],
    [1067983, 'BERKSHIRE HATHAWAY INC', 'BRK-A', 'NYSE'],
    [999, 'NO EXCHANGE CO', 'NOEX', null],
  ],
};

const submissions = {
  cik: '0000019617',
  filings: { recent: {
    accessionNumber: ['0001628280-26-065616', '0001628280-26-065582', '0001628280-26-060000', '0001628280-26-048078'],
    filingDate: ['2026-10-13', '2026-10-13', '2026-10-01', '2026-07-14'],
    acceptanceDateTime: ['2026-10-13T17:38:53.000Z', '2026-10-13T14:30:38.000Z', '2026-10-01T20:00:00.000Z', '2026-07-14T14:30:38.000Z'],
    form: ['8-K', '8-K', '10-Q', '8-K'],
    items: ['7.01,9.01', '2.02,9.01', '', '2.02,9.01'],
    primaryDocument: ['jpm-a.htm', 'jpm-20261013.htm', 'q.htm', 'jpm-20260714.htm'],
  } },
};

const header = `<SEC-HEADER>0001628280-26-065582.hdr.sgml : 20261013
<ACCEPTANCE-DATETIME>20261013063038
<ACCESSION-NUMBER>0001628280-26-065582
<TYPE>8-K`;

describe('sec', () => {
  test('tickers keyed by normalized ticker', () => {
    const m = parseSecTickers(tickers);
    expect(m.get('JPM')).toEqual({ cik: 19617, exchange: 'NYSE' });
    expect(m.get('BRK-B')).toEqual({ cik: 1067983, exchange: 'NYSE' });
    expect(m.get('NOEX')).toEqual({ cik: 999, exchange: null });
  });
  test('tickers bad shape throws', () => {
    expect(() => parseSecTickers({ fields: ['x'], data: [] })).toThrow(SourceFormatError);
  });
  test('only 8-K with item 2.02, with document and index URLs', () => {
    expect(parseEarningsFilings(submissions, 19617)).toEqual([
      {
        accession: '0001628280-26-065582', filingDate: '2026-10-13',
        docUrl: 'https://www.sec.gov/Archives/edgar/data/19617/000162828026065582/jpm-20261013.htm',
        indexUrl: 'https://www.sec.gov/Archives/edgar/data/19617/000162828026065582/0001628280-26-065582-index.htm',
      },
      {
        accession: '0001628280-26-048078', filingDate: '2026-07-14',
        docUrl: 'https://www.sec.gov/Archives/edgar/data/19617/000162828026048078/jpm-20260714.htm',
        indexUrl: 'https://www.sec.gov/Archives/edgar/data/19617/000162828026048078/0001628280-26-048078-index.htm',
      },
    ]);
  });
  test('acceptance comes from the SGML header as ET wall clock', () => {
    expect(parseAcceptance(header)).toBe('2026-10-13T06:30:38');
    expect(() => parseAcceptance('<html>rate limited</html>')).toThrow(SourceFormatError);
  });
  test('fetchAcceptance builds the header URL', async () => {
    const http = { json: vi.fn(), text: vi.fn().mockResolvedValue(header) };
    await fetchAcceptance(http, 19617, '0001628280-26-065582');
    expect(http.text).toHaveBeenCalledWith(
      'https://www.sec.gov/Archives/edgar/data/19617/000162828026065582/0001628280-26-065582.hdr.sgml');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w server -- sec.test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`server/src/sources/sec.ts`:
```ts
import { z } from 'zod';
import { normalizeTicker } from '../domain/ticker.js';
import type { Filing } from '../types.js';
import { type Http, SourceFormatError } from './http.js';

export interface SecTicker {
  cik: number;
  exchange: string | null;
}

const TickersSchema = z.object({
  fields: z.array(z.string()),
  data: z.array(z.array(z.union([z.string(), z.number(), z.null()]))),
});

export function parseSecTickers(json: unknown): Map<string, SecTicker> {
  const parsed = TickersSchema.safeParse(json);
  if (!parsed.success) throw new SourceFormatError(`SEC tickers: ${parsed.error.message}`);
  const { fields, data } = parsed.data;
  const iCik = fields.indexOf('cik');
  const iTicker = fields.indexOf('ticker');
  const iExchange = fields.indexOf('exchange');
  if (iCik < 0 || iTicker < 0 || iExchange < 0) throw new SourceFormatError(`SEC tickers: unexpected fields ${fields.join(',')}`);
  const map = new Map<string, SecTicker>();
  for (const row of data) {
    const cik = Number(row[iCik]);
    const ticker = row[iTicker];
    const exchange = row[iExchange];
    if (typeof ticker !== 'string' || !Number.isFinite(cik)) continue;
    const key = normalizeTicker(ticker);
    if (!map.has(key)) map.set(key, { cik, exchange: typeof exchange === 'string' ? exchange : null });
  }
  return map;
}

const SubmissionsSchema = z.object({
  filings: z.object({
    recent: z.object({
      accessionNumber: z.array(z.string()),
      filingDate: z.array(z.string()),
      form: z.array(z.string()),
      items: z.array(z.string()),
      primaryDocument: z.array(z.string()),
    }),
  }),
});

export function parseEarningsFilings(json: unknown, cik: number): Filing[] {
  const parsed = SubmissionsSchema.safeParse(json);
  if (!parsed.success) throw new SourceFormatError(`SEC submissions ${cik}: ${parsed.error.message}`);
  const r = parsed.data.filings.recent;
  const out: Filing[] = [];
  r.form.forEach((form, i) => {
    if (form !== '8-K') return;
    const items = (r.items[i] ?? '').split(',').map((s) => s.trim());
    if (!items.includes('2.02')) return;
    const accession = r.accessionNumber[i] ?? '';
    const base = `https://www.sec.gov/Archives/edgar/data/${cik}/${accession.replace(/-/g, '')}`;
    out.push({
      accession,
      filingDate: r.filingDate[i] ?? '',
      docUrl: `${base}/${r.primaryDocument[i] ?? ''}`,
      indexUrl: `${base}/${accession}-index.htm`,
    });
  });
  return out;
}

/** <ACCEPTANCE-DATETIME>yyyyMMddHHmmss is ET wall clock (verified against EDGAR index pages). */
export function parseAcceptance(text: string): string {
  const m = /<ACCEPTANCE-DATETIME>(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(text);
  if (!m) throw new SourceFormatError('SEC header: ACCEPTANCE-DATETIME not found');
  const [, y, mo, d, h, mi, s] = m;
  return `${y}-${mo}-${d}T${h}:${mi}:${s}`;
}

export async function fetchSecTickers(http: Http): Promise<Map<string, SecTicker>> {
  return parseSecTickers(await http.json('https://www.sec.gov/files/company_tickers_exchange.json'));
}

export async function fetchEarningsFilings(http: Http, cik: number): Promise<Filing[]> {
  const padded = String(cik).padStart(10, '0');
  return parseEarningsFilings(await http.json(`https://data.sec.gov/submissions/CIK${padded}.json`), cik);
}

export async function fetchAcceptance(http: Http, cik: number, accession: string): Promise<string> {
  const url = `https://www.sec.gov/Archives/edgar/data/${cik}/${accession.replace(/-/g, '')}/${accession}.hdr.sgml`;
  return parseAcceptance(await http.text(url));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w server -- sec.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/sources/sec.ts server/test/sources/sec.test.ts
git commit -m "feat: add SEC EDGAR tickers, filings and acceptance header source" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Database repository

**Files:**
- Create: `server/src/db/repo.ts`
- Test: `server/test/db/repo.test.ts`

**Interfaces:**
- Consumes: `normalizeTicker` (Task 1); types from Task 3.
- Produces:
  - `type Db = DatabaseSync`; `openDb(path: string): Db` (`':memory:'` for tests)
  - `inTransaction(db, fn: () => void): void`
  - `upsertCalendarRow(db, row: CalendarRow, now: string, today: string): void`
  - `mergeFinnhubRow(db, row: RevenueRow, now: string): boolean`
  - `listRange(db, f: { from: string; to: string; minCap: number | null; q: string | null }): ReportRecord[]`
  - `getReport(db, id: number): ReportRecord | undefined`
  - `distinctSymbolKeys(db): string[]`; `setExchange(db, symbolKey: string, exchange: string | null): void`
  - `reportsNeedingSec(db, today: string, recheckSince: string): PendingSec[]` where `PendingSec = { id: number; symbolKey: string; reportDate: string; timing: Timing; timingSource: TimingSource }`
  - `setSecResult(db, id, r: { check: SecCheck; timing: Timing; timingSource: TimingSource; acceptedAt: string | null; docUrl: string | null; indexUrl: string | null }, now: string): void`
  - `reportsForSnapshot(db, today: string, nextDay: string): { id: number; symbol: string; reportDate: string; timing: Timing }[]`
  - `saveExpectedMove(db, reportId: number, em: ExpectedMove, snapshotAt: string): void`
  - `recordSourceSuccess(db, source: string, now: string)`, `recordSourceError(db, source: string, message: string, now: string)`, `listSourceStatus(db): SourceStatusDto[]`
  - `isBackfilled(db, key: string): boolean`, `markBackfilled(db, key: string, now: string): void`
  - `counts(db): { reports: number; withExpectedMove: number; secVerified: number }`

- [ ] **Step 1: Write the failing test**

`server/test/db/repo.test.ts`:
```ts
import { beforeEach, describe, expect, test } from 'vitest';
import {
  type Db, getReport, isBackfilled, listRange, listSourceStatus, markBackfilled, mergeFinnhubRow, openDb,
  recordSourceError, recordSourceSuccess, reportsForSnapshot, reportsNeedingSec, saveExpectedMove,
  setExchange, setSecResult, upsertCalendarRow,
} from '../../src/db/repo.js';
import type { CalendarRow } from '../../src/types.js';

const NOW = '2026-10-15T20:00:00.000Z';
const TODAY = '2026-10-15';

const row = (over: Partial<CalendarRow> = {}): CalendarRow => ({
  symbol: 'SCHW', name: 'Charles Schwab', reportDate: '2026-10-16', fiscalQuarter: 'Sep/2026', timing: 'BMO',
  marketCap: 165_900_000_000, epsEstimate: 1.66, noOfEsts: 10, epsActual: null, epsSurprisePct: null, ...over,
});

const all = (db: Db) => listRange(db, { from: '2000-01-01', to: '2100-01-01', minCap: null, q: null });

let db: Db;
beforeEach(() => { db = openDb(':memory:'); });

describe('upsertCalendarRow', () => {
  test('inserts with nasdaq timing source and market-cap date', () => {
    upsertCalendarRow(db, row(), NOW, TODAY);
    expect(all(db)[0]).toMatchObject({
      symbol: 'SCHW', symbolKey: 'SCHW', timing: 'BMO', timingSource: 'nasdaq', marketCap: 165_900_000_000,
      marketCapAsOf: TODAY, calendarFetchedAt: NOW,
    });
  });
  test('keeps known timing when Nasdaq later says not supplied', () => {
    upsertCalendarRow(db, row(), NOW, TODAY);
    upsertCalendarRow(db, row({ timing: 'UNKNOWN', epsActual: 1.71, epsSurprisePct: 3 }), NOW, '2026-10-17');
    expect(all(db)[0]).toMatchObject({ timing: 'BMO', timingSource: 'nasdaq', epsActual: 1.71, epsSurprisePct: 3 });
  });
  test('market cap is frozen once the report date has passed', () => {
    upsertCalendarRow(db, row(), NOW, TODAY);
    upsertCalendarRow(db, row({ marketCap: 999 }), NOW, '2026-10-17');
    expect(all(db)[0]).toMatchObject({ marketCap: 165_900_000_000, marketCapAsOf: TODAY });
  });
  test('null fields never erase stored values', () => {
    upsertCalendarRow(db, row(), NOW, TODAY);
    upsertCalendarRow(db, row({ epsEstimate: null, noOfEsts: null, marketCap: null }), NOW, TODAY);
    expect(all(db)[0]).toMatchObject({ epsEstimate: 1.66, noOfEsts: 10, marketCap: 165_900_000_000 });
  });
  test('reschedule moves the date, logs the old one, and drops stale timing, SEC result and snapshot', () => {
    upsertCalendarRow(db, row(), NOW, TODAY);
    const id = all(db)[0]!.id;
    saveExpectedMove(db, id, { expiry: '2026-10-16', strike: 100, callMid: 3, putMid: 3, underlying: 100, movePct: 6, illiquid: false }, NOW);
    upsertCalendarRow(db, row({ reportDate: '2026-10-21', timing: 'UNKNOWN' }), NOW, TODAY);
    expect(getReport(db, id)).toMatchObject({
      reportDate: '2026-10-21', rescheduledFrom: '2026-10-16', timing: 'UNKNOWN', timingSource: null, expectedMove: null,
    });
  });
});

describe('mergeFinnhubRow', () => {
  test('merges Finnhub row across ticker spellings', () => {
    upsertCalendarRow(db, row({ symbol: 'BRK/B', timing: 'UNKNOWN' }), NOW, TODAY);
    const ok = mergeFinnhubRow(db, { symbol: 'BRK.B', reportDate: '2026-10-16', timing: 'AMC', revenueEstimate: 9e10, revenueActual: null }, NOW);
    expect(ok).toBe(true);
    expect(all(db)[0]).toMatchObject({ revenueEstimate: 9e10, timing: 'AMC', timingSource: 'finnhub', revenueFetchedAt: NOW });
  });
  test('nasdaq timing wins; disagreement is recorded as a conflict', () => {
    upsertCalendarRow(db, row(), NOW, TODAY);
    mergeFinnhubRow(db, { symbol: 'SCHW', reportDate: '2026-10-16', timing: 'AMC', revenueEstimate: null, revenueActual: null }, NOW);
    expect(all(db)[0]).toMatchObject({ timing: 'BMO', timingSource: 'nasdaq', timingConflict: 'Nasdaq says BMO, Finnhub says AMC' });
    mergeFinnhubRow(db, { symbol: 'SCHW', reportDate: '2026-10-16', timing: 'BMO', revenueEstimate: null, revenueActual: null }, NOW);
    expect(all(db)[0]!.timingConflict).toBeNull();
  });
  test('no matching report -> false', () => {
    expect(mergeFinnhubRow(db, { symbol: 'NONE', reportDate: '2026-10-16', timing: 'BMO', revenueEstimate: 1, revenueActual: 1 }, NOW)).toBe(false);
  });
});

describe('listRange', () => {
  beforeEach(() => {
    upsertCalendarRow(db, row(), NOW, TODAY);
    upsertCalendarRow(db, row({ symbol: 'TINY', name: 'Tiny Corp', marketCap: 5e8 }), NOW, TODAY);
    upsertCalendarRow(db, row({ symbol: 'NOCAP', name: 'Unknown Cap', marketCap: null }), NOW, TODAY);
    upsertCalendarRow(db, row({ symbol: 'LATER', name: 'Later Inc', reportDate: '2026-11-01' }), NOW, TODAY);
  });
  test('date range and min cap; unknown caps are never filtered out', () => {
    const rows = listRange(db, { from: '2026-10-16', to: '2026-10-16', minCap: 2e9, q: null });
    expect(rows.map((r) => r.symbol)).toEqual(['SCHW', 'NOCAP']);
  });
  test('search by ticker prefix or name', () => {
    expect(listRange(db, { from: '2026-10-01', to: '2026-12-31', minCap: null, q: 'tin' }).map((r) => r.symbol)).toEqual(['TINY']);
    expect(listRange(db, { from: '2026-10-01', to: '2026-12-31', minCap: null, q: 'schwab' }).map((r) => r.symbol)).toEqual(['SCHW']);
  });
});

describe('sec, snapshot, status, backfill helpers', () => {
  test('exchange is set for every row of a symbol', () => {
    upsertCalendarRow(db, row({ symbol: 'BRK/B' }), NOW, TODAY);
    setExchange(db, 'BRK-B', 'NYSE');
    expect(all(db)[0]!.exchange).toBe('NYSE');
  });
  test('reportsNeedingSec: past reports never checked, plus recent unverifiable ones', () => {
    upsertCalendarRow(db, row({ symbol: 'OLD', reportDate: '2026-10-01' }), NOW, TODAY);
    upsertCalendarRow(db, row({ symbol: 'RECENT', reportDate: '2026-10-14' }), NOW, TODAY);
    upsertCalendarRow(db, row({ symbol: 'FUTURE', reportDate: '2026-10-20' }), NOW, TODAY);
    const pending = reportsNeedingSec(db, TODAY, '2026-10-10');
    expect(pending.map((p) => p.symbolKey).sort()).toEqual(['OLD', 'RECENT']);
    for (const p of pending) {
      setSecResult(db, p.id, { check: 'unverifiable', timing: p.timing, timingSource: p.timingSource, acceptedAt: null, docUrl: null, indexUrl: null }, NOW);
    }
    expect(reportsNeedingSec(db, TODAY, '2026-10-10').map((p) => p.symbolKey)).toEqual(['RECENT']);
  });
  test('reportsForSnapshot: AMC today, BMO/DMH/UNKNOWN next trading day', () => {
    upsertCalendarRow(db, row({ symbol: 'AMCTODAY', reportDate: TODAY, timing: 'AMC' }), NOW, TODAY);
    upsertCalendarRow(db, row({ symbol: 'BMOTODAY', reportDate: TODAY, timing: 'BMO' }), NOW, TODAY);
    upsertCalendarRow(db, row({ symbol: 'BMONEXT', reportDate: '2026-10-16', timing: 'BMO' }), NOW, TODAY);
    upsertCalendarRow(db, row({ symbol: 'UNKNEXT', reportDate: '2026-10-16', timing: 'UNKNOWN' }), NOW, TODAY);
    upsertCalendarRow(db, row({ symbol: 'AMCNEXT', reportDate: '2026-10-16', timing: 'AMC' }), NOW, TODAY);
    expect(reportsForSnapshot(db, TODAY, '2026-10-16').map((r) => r.symbol).sort()).toEqual(['AMCTODAY', 'BMONEXT', 'UNKNEXT']);
  });
  test('source status keeps last success and last error', () => {
    recordSourceSuccess(db, 'nasdaq', NOW);
    recordSourceError(db, 'nasdaq', 'HTTP 403', '2026-10-15T21:00:00.000Z');
    expect(listSourceStatus(db)).toEqual([
      { source: 'nasdaq', lastSuccessAt: NOW, lastError: 'HTTP 403', lastErrorAt: '2026-10-15T21:00:00.000Z' },
    ]);
  });
  test('backfill progress', () => {
    expect(isBackfilled(db, 'nasdaq:2026-10-01')).toBe(false);
    markBackfilled(db, 'nasdaq:2026-10-01', NOW);
    expect(isBackfilled(db, 'nasdaq:2026-10-01')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w server -- repo`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`server/src/db/repo.ts`:
```ts
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SourceStatusDto } from '../api/types.js';
import { normalizeTicker } from '../domain/ticker.js';
import type {
  CalendarRow, ExpectedMove, ReportRecord, RevenueRow, SecCheck, Timing, TimingSource,
} from '../types.js';

export type Db = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY,
  symbol TEXT NOT NULL,
  symbol_key TEXT NOT NULL,
  name TEXT NOT NULL,
  fiscal_quarter TEXT NOT NULL,
  report_date TEXT NOT NULL,
  rescheduled_from TEXT,
  timing TEXT NOT NULL DEFAULT 'UNKNOWN',
  timing_source TEXT,
  timing_conflict TEXT,
  market_cap REAL,
  market_cap_as_of TEXT,
  eps_estimate REAL,
  eps_actual REAL,
  eps_surprise_pct REAL,
  no_of_ests INTEGER,
  revenue_estimate REAL,
  revenue_actual REAL,
  exchange TEXT,
  sec_check TEXT,
  sec_accepted_at TEXT,
  sec_doc_url TEXT,
  sec_index_url TEXT,
  calendar_fetched_at TEXT,
  revenue_fetched_at TEXT,
  sec_checked_at TEXT,
  UNIQUE (symbol_key, fiscal_quarter)
);
CREATE INDEX IF NOT EXISTS idx_reports_date ON reports (report_date);
CREATE INDEX IF NOT EXISTS idx_reports_key_date ON reports (symbol_key, report_date);
CREATE TABLE IF NOT EXISTS expected_moves (
  report_id INTEGER PRIMARY KEY REFERENCES reports (id) ON DELETE CASCADE,
  expiry TEXT NOT NULL,
  strike REAL NOT NULL,
  call_mid REAL NOT NULL,
  put_mid REAL NOT NULL,
  underlying REAL NOT NULL,
  move_pct REAL NOT NULL,
  illiquid INTEGER NOT NULL,
  snapshot_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS source_status (
  source TEXT PRIMARY KEY,
  last_success_at TEXT,
  last_error TEXT,
  last_error_at TEXT
);
CREATE TABLE IF NOT EXISTS backfill_progress (
  key TEXT PRIMARY KEY,
  done_at TEXT NOT NULL
);
`;

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

export function inTransaction(db: Db, fn: () => void): void {
  db.exec('BEGIN');
  try {
    fn();
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

interface ReportRow {
  id: number; symbol: string; symbol_key: string; name: string; fiscal_quarter: string; report_date: string;
  rescheduled_from: string | null; timing: Timing; timing_source: TimingSource; timing_conflict: string | null;
  market_cap: number | null; market_cap_as_of: string | null; eps_estimate: number | null; eps_actual: number | null;
  eps_surprise_pct: number | null; no_of_ests: number | null; revenue_estimate: number | null; revenue_actual: number | null;
  exchange: string | null; sec_check: SecCheck | null; sec_accepted_at: string | null; sec_doc_url: string | null;
  sec_index_url: string | null; calendar_fetched_at: string | null; revenue_fetched_at: string | null; sec_checked_at: string | null;
}

interface JoinedRow extends ReportRow {
  em_expiry: string | null; em_strike: number | null; em_call_mid: number | null; em_put_mid: number | null;
  em_underlying: number | null; em_move_pct: number | null; em_illiquid: number | null; em_snapshot_at: string | null;
}

const SELECT_REPORT = `
SELECT r.*, m.expiry AS em_expiry, m.strike AS em_strike, m.call_mid AS em_call_mid, m.put_mid AS em_put_mid,
       m.underlying AS em_underlying, m.move_pct AS em_move_pct, m.illiquid AS em_illiquid, m.snapshot_at AS em_snapshot_at
FROM reports r LEFT JOIN expected_moves m ON m.report_id = r.id`;

function toRecord(r: JoinedRow): ReportRecord {
  return {
    id: r.id, symbol: r.symbol, symbolKey: r.symbol_key, name: r.name, fiscalQuarter: r.fiscal_quarter,
    reportDate: r.report_date, rescheduledFrom: r.rescheduled_from, timing: r.timing, timingSource: r.timing_source,
    timingConflict: r.timing_conflict, marketCap: r.market_cap, marketCapAsOf: r.market_cap_as_of,
    epsEstimate: r.eps_estimate, epsActual: r.eps_actual, epsSurprisePct: r.eps_surprise_pct, noOfEsts: r.no_of_ests,
    revenueEstimate: r.revenue_estimate, revenueActual: r.revenue_actual, exchange: r.exchange,
    secCheck: r.sec_check, secAcceptedAt: r.sec_accepted_at, secDocUrl: r.sec_doc_url, secIndexUrl: r.sec_index_url,
    calendarFetchedAt: r.calendar_fetched_at, revenueFetchedAt: r.revenue_fetched_at, secCheckedAt: r.sec_checked_at,
    expectedMove: r.em_snapshot_at == null ? null : {
      expiry: r.em_expiry!, strike: r.em_strike!, callMid: r.em_call_mid!, putMid: r.em_put_mid!,
      underlying: r.em_underlying!, movePct: r.em_move_pct!, illiquid: r.em_illiquid === 1, snapshotAt: r.em_snapshot_at,
    },
  };
}

export function upsertCalendarRow(db: Db, row: CalendarRow, now: string, today: string): void {
  const key = normalizeTicker(row.symbol);
  const existing = db.prepare('SELECT * FROM reports WHERE symbol_key = ? AND fiscal_quarter = ?')
    .get(key, row.fiscalQuarter) as unknown as ReportRow | undefined;

  if (!existing) {
    db.prepare(`INSERT INTO reports (symbol, symbol_key, name, fiscal_quarter, report_date, timing, timing_source,
      market_cap, market_cap_as_of, eps_estimate, eps_actual, eps_surprise_pct, no_of_ests, calendar_fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      row.symbol, key, row.name, row.fiscalQuarter, row.reportDate, row.timing,
      row.timing === 'UNKNOWN' ? null : 'nasdaq',
      row.marketCap, row.marketCap == null ? null : today,
      row.epsEstimate, row.epsActual, row.epsSurprisePct, row.noOfEsts, now);
    return;
  }

  const rescheduled = existing.report_date !== row.reportDate;
  let timing: Timing = existing.timing;
  let timingSource: TimingSource = existing.timing_source;
  if (row.timing !== 'UNKNOWN') {
    timing = row.timing;
    timingSource = 'nasdaq';
  } else if (rescheduled) {
    timing = 'UNKNOWN';         // old timing belonged to the old date
    timingSource = null;
  }
  const capLive = row.reportDate >= today && row.marketCap != null;

  db.prepare(`UPDATE reports SET name = ?, report_date = ?, rescheduled_from = ?, timing = ?, timing_source = ?,
      timing_conflict = CASE WHEN ? THEN NULL ELSE timing_conflict END,
      market_cap = ?, market_cap_as_of = ?,
      eps_estimate = COALESCE(?, eps_estimate), eps_actual = COALESCE(?, eps_actual),
      eps_surprise_pct = COALESCE(?, eps_surprise_pct), no_of_ests = COALESCE(?, no_of_ests),
      sec_check = CASE WHEN ? THEN NULL ELSE sec_check END,
      sec_accepted_at = CASE WHEN ? THEN NULL ELSE sec_accepted_at END,
      calendar_fetched_at = ?
    WHERE id = ?`).run(
    row.name, row.reportDate, rescheduled ? existing.report_date : existing.rescheduled_from, timing, timingSource,
    rescheduled ? 1 : 0,
    capLive ? row.marketCap : existing.market_cap, capLive ? today : existing.market_cap_as_of,
    row.epsEstimate, row.epsActual, row.epsSurprisePct, row.noOfEsts,
    rescheduled ? 1 : 0, rescheduled ? 1 : 0,
    now, existing.id);

  if (rescheduled) db.prepare('DELETE FROM expected_moves WHERE report_id = ?').run(existing.id);
}

export function mergeFinnhubRow(db: Db, r: RevenueRow, now: string): boolean {
  const existing = db.prepare('SELECT * FROM reports WHERE symbol_key = ? AND report_date = ?')
    .get(normalizeTicker(r.symbol), r.reportDate) as unknown as ReportRow | undefined;
  if (!existing) return false;

  let timing = existing.timing;
  let source = existing.timing_source;
  let conflict = existing.timing_conflict;
  if (r.timing !== 'UNKNOWN') {
    if (source === 'nasdaq' || source === 'sec') {
      const label = source === 'nasdaq' ? 'Nasdaq' : 'SEC filing';
      conflict = r.timing === timing ? null : `${label} says ${timing}, Finnhub says ${r.timing}`;
    } else {
      timing = r.timing;
      source = 'finnhub';
      conflict = null;
    }
  }

  db.prepare(`UPDATE reports SET revenue_estimate = COALESCE(?, revenue_estimate),
      revenue_actual = COALESCE(?, revenue_actual), timing = ?, timing_source = ?, timing_conflict = ?,
      revenue_fetched_at = ? WHERE id = ?`)
    .run(r.revenueEstimate, r.revenueActual, timing, source, conflict, now, existing.id);
  return true;
}

export function listRange(
  db: Db,
  f: { from: string; to: string; minCap: number | null; q: string | null },
): ReportRecord[] {
  const where = ['r.report_date BETWEEN ? AND ?'];
  const params: (string | number)[] = [f.from, f.to];
  if (f.minCap != null) {
    where.push('(r.market_cap >= ? OR r.market_cap IS NULL)');
    params.push(f.minCap);
  }
  const term = f.q?.replace(/[%_]/g, '').trim();
  if (term) {
    where.push('(r.symbol_key LIKE ? OR r.name LIKE ?)');
    params.push(`${normalizeTicker(term)}%`, `%${term}%`);
  }
  const rows = db.prepare(`${SELECT_REPORT} WHERE ${where.join(' AND ')} ORDER BY r.report_date, r.market_cap DESC, r.symbol`)
    .all(...params) as unknown as JoinedRow[];
  return rows.map(toRecord);
}

export function getReport(db: Db, id: number): ReportRecord | undefined {
  const r = db.prepare(`${SELECT_REPORT} WHERE r.id = ?`).get(id) as unknown as JoinedRow | undefined;
  return r && toRecord(r);
}

export function distinctSymbolKeys(db: Db): string[] {
  return (db.prepare('SELECT DISTINCT symbol_key AS k FROM reports').all() as unknown as { k: string }[]).map((r) => r.k);
}

export function setExchange(db: Db, symbolKey: string, exchange: string | null): void {
  db.prepare('UPDATE reports SET exchange = ? WHERE symbol_key = ?').run(exchange, symbolKey);
}

export interface PendingSec {
  id: number;
  symbolKey: string;
  reportDate: string;
  timing: Timing;
  timingSource: TimingSource;
}

export function reportsNeedingSec(db: Db, today: string, recheckSince: string): PendingSec[] {
  return db.prepare(`SELECT id, symbol_key AS symbolKey, report_date AS reportDate, timing, timing_source AS timingSource
      FROM reports
      WHERE report_date <= ?
        AND (sec_check IS NULL OR (sec_check = 'unverifiable' AND report_date >= ?))
      ORDER BY symbol_key, report_date`)
    .all(today, recheckSince) as unknown as PendingSec[];
}

export function setSecResult(
  db: Db,
  id: number,
  r: { check: SecCheck; timing: Timing; timingSource: TimingSource; acceptedAt: string | null; docUrl: string | null; indexUrl: string | null },
  now: string,
): void {
  db.prepare(`UPDATE reports SET sec_check = ?, timing = ?, timing_source = ?, sec_accepted_at = ?, sec_doc_url = ?,
      sec_index_url = ?, sec_checked_at = ? WHERE id = ?`)
    .run(r.check, r.timing, r.timingSource, r.acceptedAt, r.docUrl, r.indexUrl, now, id);
}

export function reportsForSnapshot(
  db: Db, today: string, nextDay: string,
): { id: number; symbol: string; reportDate: string; timing: Timing }[] {
  return db.prepare(`SELECT id, symbol, report_date AS reportDate, timing FROM reports
      WHERE (report_date = ? AND timing = 'AMC')
         OR (report_date = ? AND timing IN ('BMO', 'DMH', 'UNKNOWN'))`)
    .all(today, nextDay) as unknown as { id: number; symbol: string; reportDate: string; timing: Timing }[];
}

export function saveExpectedMove(db: Db, reportId: number, em: ExpectedMove, snapshotAt: string): void {
  db.prepare(`INSERT OR REPLACE INTO expected_moves
      (report_id, expiry, strike, call_mid, put_mid, underlying, move_pct, illiquid, snapshot_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(reportId, em.expiry, em.strike, em.callMid, em.putMid, em.underlying, em.movePct, em.illiquid ? 1 : 0, snapshotAt);
}

export function recordSourceSuccess(db: Db, source: string, now: string): void {
  db.prepare(`INSERT INTO source_status (source, last_success_at) VALUES (?, ?)
      ON CONFLICT (source) DO UPDATE SET last_success_at = excluded.last_success_at`).run(source, now);
}

export function recordSourceError(db: Db, source: string, message: string, now: string): void {
  db.prepare(`INSERT INTO source_status (source, last_error, last_error_at) VALUES (?, ?, ?)
      ON CONFLICT (source) DO UPDATE SET last_error = excluded.last_error, last_error_at = excluded.last_error_at`)
    .run(source, message.slice(0, 500), now);
}

export function listSourceStatus(db: Db): SourceStatusDto[] {
  return db.prepare(`SELECT source, last_success_at AS lastSuccessAt, last_error AS lastError, last_error_at AS lastErrorAt
      FROM source_status ORDER BY source`).all() as unknown as SourceStatusDto[];
}

export function isBackfilled(db: Db, key: string): boolean {
  return db.prepare('SELECT 1 FROM backfill_progress WHERE key = ?').get(key) !== undefined;
}

export function markBackfilled(db: Db, key: string, now: string): void {
  db.prepare('INSERT OR REPLACE INTO backfill_progress (key, done_at) VALUES (?, ?)').run(key, now);
}

export function counts(db: Db): { reports: number; withExpectedMove: number; secVerified: number } {
  const one = (sql: string) => (db.prepare(sql).get() as unknown as { n: number }).n;
  return {
    reports: one('SELECT COUNT(*) AS n FROM reports'),
    withExpectedMove: one('SELECT COUNT(*) AS n FROM expected_moves'),
    secVerified: one(`SELECT COUNT(*) AS n FROM reports WHERE sec_check IN ('verified', 'consistent', 'derived')`),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w server -- repo`
Expected: PASS. (Node may print an `ExperimentalWarning` for `node:sqlite`; that is expected.)

- [ ] **Step 5: Commit**

```bash
git add server/src/db/repo.ts server/test/db/repo.test.ts
git commit -m "feat: add SQLite repository with timing-preserving upserts" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Data jobs and source wiring

**Files:**
- Create: `server/src/config.ts`, `server/src/jobs/context.ts`, `server/src/jobs/refreshCalendar.ts`, `server/src/jobs/refreshResults.ts`, `server/src/jobs/snapshotMoves.ts`, `server/src/jobs/secSync.ts`, `server/src/jobs/backfill.ts`, `server/src/sources/index.ts`
- Test: `server/test/jobs/jobs.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–8.
- Produces:
  - `config: { port: number; dbPath: string; finnhubToken: string; secUserAgent: string }`
  - `interface Sources { calendar(date): Promise<CalendarRow[]>; earningsDetails(from, to): Promise<RevenueRow[]>; optionChain(symbol): Promise<OptionChain | null>; secTickers(): Promise<Map<string, SecTicker>>; secEarningsFilings(cik): Promise<Filing[]>; secAcceptance(cik, accession): Promise<string> }`
  - `interface JobContext { db: Db; sources: Sources; now(): string; today(): string }`
  - `track<T>(ctx, source: string, fn: () => Promise<T>): Promise<T | undefined>`
  - `refreshCalendar(ctx, days = 90)`, `refreshResults(ctx)`, `snapshotMoves(ctx)`, `secSync(ctx)`, `backfill(ctx, start: string, log?: (msg: string) => void)` — all `Promise<void>`
  - `createSources(cfg): Sources`

- [ ] **Step 1: Write the failing test**

`server/test/jobs/jobs.test.ts`:
```ts
import { describe, expect, test, vi } from 'vitest';
import { listRange, listSourceStatus, openDb, upsertCalendarRow } from '../../src/db/repo.js';
import { backfill } from '../../src/jobs/backfill.js';
import type { JobContext, Sources } from '../../src/jobs/context.js';
import { refreshCalendar } from '../../src/jobs/refreshCalendar.js';
import { refreshResults } from '../../src/jobs/refreshResults.js';
import { secSync } from '../../src/jobs/secSync.js';
import { snapshotMoves } from '../../src/jobs/snapshotMoves.js';
import { SourceFormatError } from '../../src/sources/http.js';
import type { CalendarRow, OptionChain } from '../../src/types.js';

const NOW = '2026-10-15T20:30:00.000Z';
const TODAY = '2026-10-15'; // Thursday

function makeCtx(over: Partial<Sources> = {}): JobContext {
  const sources: Sources = {
    calendar: async () => [],
    earningsDetails: async () => [],
    optionChain: async () => null,
    secTickers: async () => new Map(),
    secEarningsFilings: async () => [],
    secAcceptance: async () => '',
    ...over,
  };
  return { db: openDb(':memory:'), sources, now: () => NOW, today: () => TODAY };
}

const cal = (over: Partial<CalendarRow> = {}): CalendarRow => ({
  symbol: 'SCHW', name: 'Charles Schwab', reportDate: TODAY, fiscalQuarter: 'Sep/2026', timing: 'BMO',
  marketCap: 1.6e11, epsEstimate: 1.66, noOfEsts: 10, epsActual: null, epsSurprisePct: null, ...over,
});
const all = (ctx: JobContext) => listRange(ctx.db, { from: '2000-01-01', to: '2100-01-01', minCap: null, q: null });

describe('refreshCalendar', () => {
  test('fetches weekdays only and stores rows', async () => {
    const calendar = vi.fn(async (date: string) => (date === TODAY ? [cal()] : []));
    const ctx = makeCtx({ calendar });
    await refreshCalendar(ctx, 3); // Thu..Sun
    expect(calendar.mock.calls.map((c) => c[0])).toEqual(['2026-10-15', '2026-10-16']);
    expect(all(ctx)).toHaveLength(1);
    expect(listSourceStatus(ctx.db)[0]).toMatchObject({ source: 'nasdaq', lastSuccessAt: NOW, lastError: null });
  });
  test('format error records status and keeps stored data', async () => {
    const ctx = makeCtx();
    upsertCalendarRow(ctx.db, cal(), NOW, TODAY);
    ctx.sources.calendar = async () => { throw new SourceFormatError('Nasdaq calendar: bad shape'); };
    await refreshCalendar(ctx, 0);
    expect(all(ctx)[0]).toMatchObject({ symbol: 'SCHW', timing: 'BMO', marketCap: 1.6e11 });
    expect(listSourceStatus(ctx.db)[0]).toMatchObject({ source: 'nasdaq', lastError: 'Nasdaq calendar: bad shape', lastErrorAt: NOW });
  });
});

describe('refreshResults', () => {
  test('re-reads previous and current day and merges Finnhub revenue', async () => {
    const calendar = vi.fn(async (date: string) => (date === TODAY ? [cal({ epsActual: 1.71, epsSurprisePct: 3 })] : []));
    const earningsDetails = vi.fn(async () => [
      { symbol: 'SCHW', reportDate: TODAY, timing: 'BMO' as const, revenueEstimate: 6.0e9, revenueActual: 6.2e9 },
    ]);
    const ctx = makeCtx({ calendar, earningsDetails });
    await refreshResults(ctx);
    expect(calendar.mock.calls.map((c) => c[0])).toEqual(['2026-10-14', '2026-10-15']);
    expect(earningsDetails).toHaveBeenCalledWith('2026-10-14', '2026-10-15');
    expect(all(ctx)[0]).toMatchObject({ epsActual: 1.71, revenueActual: 6.2e9 });
  });
});

describe('snapshotMoves', () => {
  test('computes for AMC today and BMO next trading day', async () => {
    const chain: OptionChain = {
      underlying: 100,
      quotes: [
        { expiry: '2026-10-16', type: 'C', strike: 100, bid: 2.9, ask: 3.1 },
        { expiry: '2026-10-16', type: 'P', strike: 100, bid: 2.9, ask: 3.1 },
      ],
    };
    const optionChain = vi.fn(async () => chain);
    const ctx = makeCtx({ optionChain });
    upsertCalendarRow(ctx.db, cal({ symbol: 'AMCT', timing: 'AMC' }), NOW, TODAY);
    upsertCalendarRow(ctx.db, cal({ symbol: 'BMON', reportDate: '2026-10-16' }), NOW, TODAY);
    await snapshotMoves(ctx);
    const rows = all(ctx);
    expect(rows.find((r) => r.symbol === 'BMON')?.expectedMove).toMatchObject({ movePct: 6, expiry: '2026-10-16', snapshotAt: NOW });
    // AMC on 10-15 needs an expiry after 10-15: 10-16 qualifies
    expect(rows.find((r) => r.symbol === 'AMCT')?.expectedMove?.movePct).toBe(6);
  });
  test('no options -> no snapshot, no crash', async () => {
    const ctx = makeCtx({ optionChain: async () => null });
    upsertCalendarRow(ctx.db, cal({ timing: 'AMC' }), NOW, TODAY);
    await snapshotMoves(ctx);
    expect(all(ctx)[0]!.expectedMove).toBeNull();
  });
});

describe('secSync', () => {
  const tickers = new Map([
    ['JPM', { cik: 19617, exchange: 'NYSE' }],
    ['BRK-B', { cik: 1067983, exchange: 'NYSE' }],
  ]);
  const filing = {
    accession: '0001628280-26-065582', filingDate: '2026-10-13',
    docUrl: 'https://www.sec.gov/doc.htm', indexUrl: 'https://www.sec.gov/index.htm',
  };

  test('verifies BMO from the header acceptance time and stores links', async () => {
    const ctx = makeCtx({
      secTickers: async () => tickers,
      secEarningsFilings: async () => [filing],
      secAcceptance: async () => '2026-10-13T06:30:38',
    });
    upsertCalendarRow(ctx.db, cal({ symbol: 'JPM', reportDate: '2026-10-13', timing: 'BMO' }), NOW, '2026-10-12');
    await secSync(ctx);
    expect(all(ctx)[0]).toMatchObject({
      exchange: 'NYSE', secCheck: 'verified', timing: 'BMO', secAcceptedAt: '2026-10-13T06:30:38',
      secDocUrl: filing.docUrl, secIndexUrl: filing.indexUrl,
    });
  });
  test('derives BMO for unknown timing and marks the source as sec', async () => {
    const ctx = makeCtx({
      secTickers: async () => tickers,
      secEarningsFilings: async () => [filing],
      secAcceptance: async () => '2026-10-13T06:30:38',
    });
    upsertCalendarRow(ctx.db, cal({ symbol: 'JPM', reportDate: '2026-10-13', timing: 'UNKNOWN' }), NOW, '2026-10-12');
    await secSync(ctx);
    expect(all(ctx)[0]).toMatchObject({ timing: 'BMO', timingSource: 'sec', secCheck: 'derived' });
  });
  test('sets exchange for class-share ticker', async () => {
    const ctx = makeCtx({ secTickers: async () => tickers });
    upsertCalendarRow(ctx.db, cal({ symbol: 'BRK/B', reportDate: '2026-10-20' }), NOW, TODAY);
    await secSync(ctx);
    expect(all(ctx)[0]!.exchange).toBe('NYSE');
  });
  test('a failed header fetch leaves the report pending for the next run', async () => {
    const ctx = makeCtx({
      secTickers: async () => tickers,
      secEarningsFilings: async () => [filing],
      secAcceptance: async () => { throw new Error('HTTP 503'); },
    });
    upsertCalendarRow(ctx.db, cal({ symbol: 'JPM', reportDate: '2026-10-13', timing: 'BMO' }), NOW, '2026-10-12');
    await secSync(ctx);
    expect(all(ctx)[0]!.secCheck).toBeNull();
  });
  test('ticker unknown to SEC -> unverifiable', async () => {
    const ctx = makeCtx({ secTickers: async () => new Map() });
    upsertCalendarRow(ctx.db, cal({ symbol: 'ZZZZ', reportDate: '2026-10-13' }), NOW, '2026-10-12');
    await secSync(ctx);
    expect(all(ctx)[0]!.secCheck).toBe('unverifiable');
  });
});

describe('backfill', () => {
  test('is resumable: completed days are not fetched again', async () => {
    const calendar = vi.fn(async (date: string) => [cal({ symbol: `S${date.slice(8)}`, reportDate: date, fiscalQuarter: `q${date}` })]);
    const ctx = makeCtx({ calendar });
    await backfill(ctx, '2026-10-12', () => {});
    const first = calendar.mock.calls.length;
    expect(first).toBe(3); // Mon 12, Tue 13, Wed 14 (today excluded)
    await backfill(ctx, '2026-10-12', () => {});
    expect(calendar.mock.calls.length).toBe(first);
    expect(all(ctx)).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w server -- jobs`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement config and context**

`server/src/config.ts`:
```ts
import { fileURLToPath } from 'node:url';

try {
  process.loadEnvFile(fileURLToPath(new URL('../../.env', import.meta.url)));
} catch {
  // No .env file: rely on the real environment.
}

export const config = {
  port: Number(process.env.PORT ?? 3001),
  dbPath: process.env.DB_PATH ?? fileURLToPath(new URL('../../data/earnings.db', import.meta.url)),
  finnhubToken: process.env.FINNHUB_TOKEN ?? '',
  secUserAgent: process.env.SEC_USER_AGENT ?? '',
};

export type Config = typeof config;
```

`server/src/jobs/context.ts`:
```ts
import type { Db } from '../db/repo.js';
import { recordSourceError, recordSourceSuccess } from '../db/repo.js';
import type { SecTicker } from '../sources/sec.js';
import type { CalendarRow, Filing, OptionChain, RevenueRow } from '../types.js';

/** Every external data source the jobs use. Paid sources later implement the same interface. */
export interface Sources {
  calendar(date: string): Promise<CalendarRow[]>;
  earningsDetails(from: string, to: string): Promise<RevenueRow[]>;
  optionChain(symbol: string): Promise<OptionChain | null>;
  secTickers(): Promise<Map<string, SecTicker>>;
  secEarningsFilings(cik: number): Promise<Filing[]>;
  secAcceptance(cik: number, accession: string): Promise<string>;
}

export interface JobContext {
  db: Db;
  sources: Sources;
  now(): string;   // ISO UTC instant
  today(): string; // YYYY-MM-DD in America/New_York
}

/** Runs one source call; records success/error in source_status; never throws. */
export async function track<T>(ctx: JobContext, source: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    const result = await fn();
    recordSourceSuccess(ctx.db, source, ctx.now());
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordSourceError(ctx.db, source, message, ctx.now());
    console.error(`[${source}] ${message}`);
    return undefined;
  }
}
```

- [ ] **Step 4: Implement the jobs**

`server/src/jobs/refreshCalendar.ts`:
```ts
import { inTransaction, upsertCalendarRow } from '../db/repo.js';
import { addDays, isWeekend } from '../domain/marketCalendar.js';
import type { CalendarRow } from '../types.js';
import { type JobContext, track } from './context.js';

export function storeCalendarRows(ctx: JobContext, rows: CalendarRow[]): void {
  const now = ctx.now();
  const today = ctx.today();
  inTransaction(ctx.db, () => {
    for (const row of rows) upsertCalendarRow(ctx.db, row, now, today);
  });
}

/** Today through today+days (spec 7: every 2 hours). */
export async function refreshCalendar(ctx: JobContext, days = 90): Promise<void> {
  const today = ctx.today();
  for (let i = 0; i <= days; i++) {
    const date = addDays(today, i);
    if (isWeekend(date)) continue;
    const rows = await track(ctx, 'nasdaq', () => ctx.sources.calendar(date));
    if (rows) storeCalendarRows(ctx, rows);
  }
}
```

`server/src/jobs/refreshResults.ts`:
```ts
import { inTransaction, mergeFinnhubRow } from '../db/repo.js';
import { prevTradingDay } from '../domain/marketCalendar.js';
import { type JobContext, track } from './context.js';
import { storeCalendarRows } from './refreshCalendar.js';

/** Previous trading day + today: picks up EPS actuals (Nasdaq) and revenue (Finnhub). */
export async function refreshResults(ctx: JobContext): Promise<void> {
  const today = ctx.today();
  const from = prevTradingDay(today);
  for (const date of [from, today]) {
    const rows = await track(ctx, 'nasdaq', () => ctx.sources.calendar(date));
    if (rows) storeCalendarRows(ctx, rows);
  }
  const details = await track(ctx, 'finnhub', () => ctx.sources.earningsDetails(from, today));
  if (details) {
    const now = ctx.now();
    inTransaction(ctx.db, () => {
      for (const d of details) mergeFinnhubRow(ctx.db, d, now);
    });
  }
}
```

`server/src/jobs/snapshotMoves.ts`:
```ts
import { reportsForSnapshot, saveExpectedMove } from '../db/repo.js';
import { computeExpectedMove } from '../domain/expectedMove.js';
import { isTradingDay, nextTradingDay } from '../domain/marketCalendar.js';
import { type JobContext, track } from './context.js';

/** Runs after the close (spec 7: 4:20 PM ET): today's AMC + next session's BMO/DMH/unknown. */
export async function snapshotMoves(ctx: JobContext): Promise<void> {
  const today = ctx.today();
  if (!isTradingDay(today)) return;
  for (const t of reportsForSnapshot(ctx.db, today, nextTradingDay(today))) {
    const chain = await track(ctx, 'cboe', () => ctx.sources.optionChain(t.symbol));
    if (!chain) continue;
    const em = computeExpectedMove(chain, t.reportDate, t.timing);
    if (em) saveExpectedMove(ctx.db, t.id, em, ctx.now());
  }
}
```

`server/src/jobs/secSync.ts`:
```ts
import { distinctSymbolKeys, reportsNeedingSec, setExchange, setSecResult } from '../db/repo.js';
import { addDays } from '../domain/marketCalendar.js';
import { checkTiming, deriveFromAcceptance } from '../domain/secTiming.js';
import type { Filing } from '../types.js';
import { type JobContext, track } from './context.js';

/** Nightly: primary exchange for every symbol, then SEC timing check for past reports (spec 6.6). */
export async function secSync(ctx: JobContext): Promise<void> {
  const tickers = await track(ctx, 'sec', () => ctx.sources.secTickers());
  if (!tickers) return;
  for (const key of distinctSymbolKeys(ctx.db)) setExchange(ctx.db, key, tickers.get(key)?.exchange ?? null);

  const today = ctx.today();
  const filingsByCik = new Map<number, Filing[]>();

  for (const p of reportsNeedingSec(ctx.db, today, addDays(today, -5))) {
    const t = tickers.get(p.symbolKey);
    if (!t) {
      setSecResult(ctx.db, p.id, { check: 'unverifiable', timing: p.timing, timingSource: p.timingSource, acceptedAt: null, docUrl: null, indexUrl: null }, ctx.now());
      continue;
    }

    let filings = filingsByCik.get(t.cik);
    if (!filings) {
      filings = await track(ctx, 'sec', () => ctx.sources.secEarningsFilings(t.cik));
      if (!filings) continue;
      filingsByCik.set(t.cik, filings);
    }

    const candidates = filings.filter((f) => f.filingDate >= p.reportDate && f.filingDate <= addDays(p.reportDate, 4));
    let best: { acceptedAt: string; filing: Filing } | null = null;
    let fetchFailed = false;
    for (const f of candidates) {
      const acceptedAt = await track(ctx, 'sec', () => ctx.sources.secAcceptance(t.cik, f.accession));
      if (acceptedAt === undefined) { fetchFailed = true; continue; }
      if (acceptedAt.slice(0, 10) !== p.reportDate) continue;
      if (!best || acceptedAt < best.acceptedAt) best = { acceptedAt, filing: f };
    }
    if (fetchFailed && !best) continue; // retry next run rather than record a false "unverifiable"

    const derived = best ? deriveFromAcceptance(p.reportDate, best.acceptedAt) : null;
    const result = checkTiming(p.timing, derived);
    setSecResult(ctx.db, p.id, {
      check: result.check,
      timing: result.timing,
      timingSource: result.timing !== p.timing ? 'sec' : p.timingSource,
      acceptedAt: best?.acceptedAt ?? null,
      docUrl: best?.filing.docUrl ?? null,
      indexUrl: best?.filing.indexUrl ?? null,
    }, ctx.now());
  }
}
```

`server/src/jobs/backfill.ts`:
```ts
import { inTransaction, isBackfilled, markBackfilled, mergeFinnhubRow } from '../db/repo.js';
import { addDays, prevTradingDay, tradingDaysBetween } from '../domain/marketCalendar.js';
import { type JobContext, track } from './context.js';
import { storeCalendarRows } from './refreshCalendar.js';
import { secSync } from './secSync.js';

/** One-time, resumable history load from `start` to the previous trading day. */
export async function backfill(ctx: JobContext, start: string, log: (msg: string) => void = console.log): Promise<void> {
  const end = prevTradingDay(ctx.today());
  const days = tradingDaysBetween(start, end);
  log(`Nasdaq: ${days.length} trading days ${start}..${end}`);
  let done = 0;
  for (const day of days) {
    const key = `nasdaq:${day}`;
    if (!isBackfilled(ctx.db, key)) {
      const rows = await track(ctx, 'nasdaq', () => ctx.sources.calendar(day));
      if (rows) {
        storeCalendarRows(ctx, rows);
        markBackfilled(ctx.db, key, ctx.now());
      }
    }
    if (++done % 20 === 0) log(`Nasdaq: ${done}/${days.length}`);
  }

  for (let from = start; from <= end; from = addDays(from, 7)) {
    const key = `finnhub:${from}`;
    if (isBackfilled(ctx.db, key)) continue;
    const to = addDays(from, 6) < end ? addDays(from, 6) : end;
    const details = await track(ctx, 'finnhub', () => ctx.sources.earningsDetails(from, to));
    if (!details) continue;
    const now = ctx.now();
    inTransaction(ctx.db, () => {
      for (const d of details) mergeFinnhubRow(ctx.db, d, now);
    });
    markBackfilled(ctx.db, key, now);
  }
  log('Finnhub: done');

  await secSync(ctx);
  log('SEC: done');
}
```

`server/src/sources/index.ts`:
```ts
import type { Config } from '../config.js';
import type { Sources } from '../jobs/context.js';
import { fetchCboeChain } from './cboe.js';
import { fetchFinnhubEarnings } from './finnhub.js';
import { BROWSER_UA, makeHttp } from './http.js';
import { fetchNasdaqCalendar } from './nasdaq.js';
import { fetchAcceptance, fetchEarningsFilings, fetchSecTickers } from './sec.js';

export function createSources(cfg: Config): Sources {
  const nasdaq = makeHttp({ minIntervalMs: 1000, headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' } });
  const cboe = makeHttp({ minIntervalMs: 1000, headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' } });
  const finnhub = makeHttp({ minIntervalMs: 1100, headers: { 'X-Finnhub-Token': cfg.finnhubToken } });
  const sec = makeHttp({ minIntervalMs: 150, headers: { 'User-Agent': cfg.secUserAgent } });

  const requireSecUa = () => {
    if (!cfg.secUserAgent) throw new Error('SEC_USER_AGENT is not set (see .env.example)');
  };

  return {
    calendar: (date) => fetchNasdaqCalendar(nasdaq, date),
    earningsDetails: async (from, to) => {
      if (!cfg.finnhubToken) throw new Error('FINNHUB_TOKEN is not set (see .env.example)');
      return fetchFinnhubEarnings(finnhub, from, to);
    },
    optionChain: (symbol) => fetchCboeChain(cboe, symbol),
    secTickers: async () => { requireSecUa(); return fetchSecTickers(sec); },
    secEarningsFilings: async (cik) => { requireSecUa(); return fetchEarningsFilings(sec, cik); },
    secAcceptance: async (cik, accession) => { requireSecUa(); return fetchAcceptance(sec, cik, accession); },
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -w server -- jobs`
Expected: PASS. (Console error lines from `track()` in the failure tests are expected.)

- [ ] **Step 6: Run the full server suite and typecheck**

Run: `npm test -w server && npm run typecheck -w server`
Expected: all PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add server/src/config.ts server/src/jobs server/src/sources/index.ts server/test/jobs
git commit -m "feat: add data jobs, backfill and source wiring" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: API, scheduler and entrypoints

**Files:**
- Create: `server/src/api/dto.ts`, `server/src/api/server.ts`, `server/src/jobs/scheduler.ts`, `server/src/index.ts`, `server/src/cli/backfill.ts`
- Test: `server/test/api/api.test.ts`

**Interfaces:**
- Consumes: repo (Task 8), jobs (Task 9), `surprisePct`/`beatMiss` (Task 3), `sessionClose`/`ET` (Task 2).
- Produces: `toDto(r: ReportRecord): ReportDto`; `buildServer(db: Db): FastifyInstance`; `startScheduler(ctx: JobContext): void`. HTTP: `GET /api/earnings?from&to&minCap&q` → `EarningsResponse`; `GET /api/earnings/:id` → `ReportDto` | 404; `GET /api/status` → `StatusResponse`.

- [ ] **Step 1: Write the failing test**

`server/test/api/api.test.ts`:
```ts
import { beforeEach, describe, expect, test } from 'vitest';
import { toDto } from '../../src/api/dto.js';
import { buildServer } from '../../src/api/server.js';
import {
  type Db, listRange, mergeFinnhubRow, openDb, recordSourceSuccess, saveExpectedMove, setSecResult, upsertCalendarRow,
} from '../../src/db/repo.js';
import type { CalendarRow } from '../../src/types.js';

const NOW = '2026-10-15T20:00:00.000Z';
const cal = (over: Partial<CalendarRow> = {}): CalendarRow => ({
  symbol: 'SCHW', name: 'Charles Schwab', reportDate: '2026-10-15', fiscalQuarter: 'Sep/2026', timing: 'BMO',
  marketCap: 1.659e11, epsEstimate: 1.66, noOfEsts: 10, epsActual: 1.71, epsSurprisePct: 3, ...over,
});

let db: Db;
beforeEach(() => { db = openDb(':memory:'); });

describe('toDto', () => {
  test('maps results with beat/miss and revenue surprise', () => {
    upsertCalendarRow(db, cal(), NOW, '2026-10-15');
    mergeFinnhubRow(db, { symbol: 'SCHW', reportDate: '2026-10-15', timing: 'BMO', revenueEstimate: 6e9, revenueActual: 5.7e9 }, NOW);
    const dto = toDto(listRange(db, { from: '2026-10-15', to: '2026-10-15', minCap: null, q: null })[0]!);
    expect(dto.eps).toEqual({ estimate: 1.66, actual: 1.71, surprisePct: 3, result: 'beat', noOfEsts: 10 });
    expect(dto.revenue).toEqual({ estimate: 6e9, actual: 5.7e9, surprisePct: -5, result: 'miss' });
    expect(dto.sessionClose).toBe('16:00');
    expect(dto.flags).toEqual([]);
  });
  test('flags: unknown time, backfilled market cap, illiquid, SEC contradiction, timing conflict', () => {
    upsertCalendarRow(db, cal({ timing: 'UNKNOWN', reportDate: '2026-10-13' }), NOW, '2026-10-15');
    const r0 = listRange(db, { from: '2026-10-13', to: '2026-10-13', minCap: null, q: null })[0]!;
    saveExpectedMove(db, r0.id, { expiry: '2026-10-16', strike: 100, callMid: 3, putMid: 3, underlying: 100, movePct: 6, illiquid: true }, NOW);
    const messages = toDto(listRange(db, { from: '2026-10-13', to: '2026-10-13', minCap: null, q: null })[0]!).flags.map((f) => f.message);
    expect(messages).toEqual([
      'Time not announced',
      'Market cap is current, not at report time',
      'Illiquid options: zero bid or spread over 30% of mid',
    ]);

    setSecResult(db, r0.id, { check: 'contradicted', timing: 'AMC', timingSource: 'nasdaq', acceptedAt: '2026-10-13T06:30:38', docUrl: null, indexUrl: null }, NOW);
    const flags = toDto(listRange(db, { from: '2026-10-13', to: '2026-10-13', minCap: null, q: null })[0]!).flags;
    expect(flags[0]).toEqual({ field: 'timing', message: 'SEC 8-K accepted 6:30 AM ET, which contradicts AMC' });
  });
});

describe('routes', () => {
  test('GET /api/earnings returns rows and source status', async () => {
    upsertCalendarRow(db, cal(), NOW, '2026-10-15');
    recordSourceSuccess(db, 'nasdaq', NOW);
    const app = buildServer(db);
    const res = await app.inject({ method: 'GET', url: '/api/earnings?from=2026-10-15&to=2026-10-15&minCap=2000000000' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.rows.map((r: { symbol: string }) => r.symbol)).toEqual(['SCHW']);
    expect(body.sources[0]).toMatchObject({ source: 'nasdaq', lastSuccessAt: NOW });
  });
  test.each([
    'from=2026-10-15',
    'from=2026-10-16&to=2026-10-15',
    'from=2026-02-31&to=2026-03-01',
    'from=2024-01-01&to=2026-01-01',
    'from=2026-10-15&to=2026-10-15&minCap=abc',
  ])('400 for bad query %s', async (qs) => {
    const res = await buildServer(db).inject({ method: 'GET', url: `/api/earnings?${qs}` });
    expect(res.statusCode).toBe(400);
  });
  test('GET /api/earnings/:id 404 for unknown id', async () => {
    const res = await buildServer(db).inject({ method: 'GET', url: '/api/earnings/999' });
    expect(res.statusCode).toBe(404);
  });
  test('GET /api/status returns counts', async () => {
    upsertCalendarRow(db, cal(), NOW, '2026-10-15');
    const res = await buildServer(db).inject({ method: 'GET', url: '/api/status' });
    expect(res.json().counts).toEqual({ reports: 1, withExpectedMove: 0, secVerified: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w server -- api`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement DTO mapping and server**

`server/src/api/dto.ts`:
```ts
import { DateTime } from 'luxon';
import { ET, sessionClose } from '../domain/marketCalendar.js';
import { beatMiss, surprisePct } from '../domain/surprise.js';
import type { ReportRecord } from '../types.js';
import type { Flag, ReportDto } from './types.js';

function closeFor(date: string): { close: '16:00' | '13:00'; flag?: Flag } {
  try {
    return { close: sessionClose(date) };
  } catch {
    return { close: '16:00', flag: { field: 'timing', message: 'Market-hours calendar missing for this year; close assumed 4:00 PM ET' } };
  }
}

const etClock = (wallClock: string) => DateTime.fromISO(wallClock, { zone: ET }).setLocale('en-US').toFormat('h:mm a');

export function toDto(r: ReportRecord): ReportDto {
  const flags: Flag[] = [];
  const { close, flag: closeFlag } = closeFor(r.reportDate);

  if (r.secCheck === 'contradicted' && r.secAcceptedAt) {
    flags.push({ field: 'timing', message: `SEC 8-K accepted ${etClock(r.secAcceptedAt)} ET, which contradicts ${r.timing}` });
  }
  if (r.timing === 'UNKNOWN') flags.push({ field: 'timing', message: 'Time not announced' });
  if (r.timingConflict) flags.push({ field: 'timing', message: r.timingConflict });
  if (closeFlag) flags.push(closeFlag);
  if (r.marketCapAsOf && r.marketCapAsOf > r.reportDate) {
    flags.push({ field: 'marketCap', message: 'Market cap is current, not at report time' });
  }
  if (r.expectedMove?.illiquid) {
    flags.push({ field: 'expectedMove', message: 'Illiquid options: zero bid or spread over 30% of mid' });
  }

  return {
    id: r.id,
    symbol: r.symbol,
    name: r.name,
    reportDate: r.reportDate,
    fiscalQuarter: r.fiscalQuarter.startsWith('date:') ? null : r.fiscalQuarter,
    timing: r.timing,
    timingSource: r.timingSource,
    sessionClose: close,
    rescheduledFrom: r.rescheduledFrom,
    exchange: r.exchange,
    marketCap: r.marketCap,
    marketCapAsOf: r.marketCapAsOf,
    eps: {
      estimate: r.epsEstimate,
      actual: r.epsActual,
      surprisePct: r.epsSurprisePct ?? surprisePct(r.epsActual, r.epsEstimate),
      result: beatMiss(r.epsActual, r.epsEstimate),
      noOfEsts: r.noOfEsts,
    },
    revenue: {
      estimate: r.revenueEstimate,
      actual: r.revenueActual,
      surprisePct: surprisePct(r.revenueActual, r.revenueEstimate),
      result: beatMiss(r.revenueActual, r.revenueEstimate),
    },
    expectedMove: r.expectedMove,
    sec: { check: r.secCheck, acceptedAt: r.secAcceptedAt, docUrl: r.secDocUrl, indexUrl: r.secIndexUrl },
    fetched: { calendar: r.calendarFetchedAt, revenue: r.revenueFetchedAt, sec: r.secCheckedAt },
    flags,
  };
}
```

`server/src/api/server.ts`:
```ts
import Fastify, { type FastifyInstance } from 'fastify';
import { DateTime } from 'luxon';
import { counts, type Db, getReport, listRange, listSourceStatus } from '../db/repo.js';
import { toDto } from './dto.js';
import type { EarningsResponse, StatusResponse } from './types.js';

const MAX_RANGE_DAYS = 400;

function validDate(s: string | undefined): s is string {
  return !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && DateTime.fromISO(s).isValid;
}

export function buildServer(db: Db): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get('/api/earnings', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    if (!validDate(q.from) || !validDate(q.to) || q.from > q.to) {
      return reply.code(400).send({ error: 'from and to must be valid YYYY-MM-DD dates with from <= to' });
    }
    const days = DateTime.fromISO(q.to).diff(DateTime.fromISO(q.from), 'days').days;
    if (days > MAX_RANGE_DAYS) return reply.code(400).send({ error: `Range too large (max ${MAX_RANGE_DAYS} days)` });
    const minCap = q.minCap ? Number(q.minCap) : null;
    if (minCap != null && !Number.isFinite(minCap)) return reply.code(400).send({ error: 'minCap must be a number' });

    const rows = listRange(db, { from: q.from, to: q.to, minCap, q: q.q?.trim() || null }).map(toDto);
    const body: EarningsResponse = { rows, sources: listSourceStatus(db) };
    return body;
  });

  app.get('/api/earnings/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const r = Number.isInteger(id) ? getReport(db, id) : undefined;
    if (!r) return reply.code(404).send({ error: 'Not found' });
    return toDto(r);
  });

  app.get('/api/status', async () => {
    const body: StatusResponse = { sources: listSourceStatus(db), counts: counts(db) };
    return body;
  });

  return app;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w server -- api`
Expected: PASS.

- [ ] **Step 5: Implement scheduler and entrypoints**

`server/src/jobs/scheduler.ts`:
```ts
import { schedule } from 'node-cron';
import { ET } from '../domain/marketCalendar.js';
import type { JobContext } from './context.js';
import { refreshCalendar } from './refreshCalendar.js';
import { refreshResults } from './refreshResults.js';
import { secSync } from './secSync.js';
import { snapshotMoves } from './snapshotMoves.js';

/** Spec section 7. All cron expressions are evaluated in America/New_York. */
export function startScheduler(ctx: JobContext): void {
  const running = new Set<string>();
  const job = (name: string, fn: () => Promise<void>) => async () => {
    if (running.has(name)) return; // previous run still going
    running.add(name);
    const started = Date.now();
    try {
      await fn();
      console.log(`[job ${name}] done in ${Math.round((Date.now() - started) / 1000)}s`);
    } catch (err) {
      console.error(`[job ${name}]`, err);
    } finally {
      running.delete(name);
    }
  };
  const opts = { timezone: ET };
  const results = job('results', () => refreshResults(ctx));

  schedule('0 */2 * * *', job('calendar', () => refreshCalendar(ctx)), opts);
  schedule('*/30 6-10 * * 1-5', results, opts);
  schedule('*/30 16-19 * * 1-5', results, opts);
  schedule('0 20 * * 1-5', results, opts);
  schedule('20 16 * * 1-5', job('moves', () => snapshotMoves(ctx)), opts);
  schedule('0 23 * * *', job('sec', () => secSync(ctx)), opts);
}
```

`server/src/index.ts`:
```ts
import { buildServer } from './api/server.js';
import { config } from './config.js';
import { openDb } from './db/repo.js';
import type { JobContext } from './jobs/context.js';
import { refreshCalendar } from './jobs/refreshCalendar.js';
import { refreshResults } from './jobs/refreshResults.js';
import { startScheduler } from './jobs/scheduler.js';
import { todayET } from './domain/marketCalendar.js';
import { createSources } from './sources/index.js';

const db = openDb(config.dbPath);
const ctx: JobContext = { db, sources: createSources(config), now: () => new Date().toISOString(), today: () => todayET() };

const app = buildServer(db);
await app.listen({ port: config.port, host: '127.0.0.1' });
console.log(`API listening on http://127.0.0.1:${config.port}`);

startScheduler(ctx);
// Warm the cache on start; failures are recorded in /api/status.
void refreshResults(ctx).then(() => refreshCalendar(ctx));
```

`server/src/cli/backfill.ts`:
```ts
import { config } from '../config.js';
import { openDb } from '../db/repo.js';
import { backfill } from '../jobs/backfill.js';
import { addDays, todayET } from '../domain/marketCalendar.js';
import { createSources } from '../sources/index.js';

const today = todayET();
const start = process.argv[2] ?? addDays(today, -730);
const db = openDb(config.dbPath);
await backfill({ db, sources: createSources(config), now: () => new Date().toISOString(), today: () => today }, start);
console.log('Backfill complete');
```

- [ ] **Step 6: Typecheck and full suite**

Run: `npm run typecheck -w server && npm test -w server`
Expected: no type errors; all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add server/src/api server/src/jobs/scheduler.ts server/src/index.ts server/src/cli server/test/api
git commit -m "feat: add earnings API, scheduler and entrypoints" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Web scaffold and display logic

**Files:**
- Create: `web/package.json`, `web/tsconfig.json`, `web/vite.config.ts`, `web/index.html`, `web/src/test-setup.ts`
- Create: `web/src/lib/time.ts`, `web/src/lib/ranges.ts`, `web/src/lib/format.ts`, `web/src/lib/storage.ts`, `web/src/lib/stale.ts`
- Test: `web/test/time.test.ts`, `web/test/ranges.test.ts`, `web/test/format.test.ts`, `web/test/storage.test.ts`, `web/test/stale.test.ts`

**Interfaces:**
- Consumes: `Timing`, `SourceStatusDto` types from `server/src/api/types.ts` (type-only import).
- Produces:
  - time.ts: `ET`, `FALLBACK_ZONE = 'Asia/Kolkata'`, `detectZone(): string`, `zoneLabel(zone: string, date: string): string`, `describeTiming(reportDate, timing, sessionClose, zone): { et: string; local: string; nextDay: boolean }`, `todayEt(): string`
  - ranges.ts: `type View = 'day' | 'week' | 'month' | 'quarter' | 'custom'`, `rangeFor(view: Exclude<View,'custom'>, anchor): { from; to }`, `shiftAnchor(view, anchor, dir: 1 | -1): string`
  - format.ts: `formatUsd(n)`, `formatUsdFull(n)`, `formatEps(n)`, `formatPct(n)`, `formatDateHeading(date)`
  - storage.ts: `readJson<T>(key, fallback: T): T`, `writeJson(key, value): void`
  - stale.ts: `staleSources(sources: SourceStatusDto[], nowMs: number): { source: string; message: string }[]`

- [ ] **Step 1: Create web project files**

`web/package.json`:
```json
{
  "name": "web",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "test": "vitest run"
  },
  "dependencies": {
    "luxon": "3.7.2",
    "react": "19.2.9",
    "react-dom": "19.2.9"
  },
  "devDependencies": {
    "@testing-library/dom": "10.4.0",
    "@testing-library/react": "16.3.3",
    "@types/luxon": "3.7.6",
    "@types/react": "19.3.0",
    "@types/react-dom": "19.3.0",
    "@vitejs/plugin-react": "5.2.0",
    "jsdom": "26.1.0",
    "typescript": "5.9.3",
    "vite": "7.3.7",
    "vitest": "4.0.6"
  }
}
```

`web/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["vite/client"]
  },
  "include": ["src", "test", "vite.config.ts"]
}
```

`web/vite.config.ts`:
```ts
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:3001' } },
  test: { environment: 'jsdom', setupFiles: ['./src/test-setup.ts'] },
});
```

`web/index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>US Earnings Calendar</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`web/src/test-setup.ts`:
```ts
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
  localStorage.clear();
});
```

Update root `package.json` to add the web workspace (it was server-only until now so `npm install` didn't fail on a missing folder):
```json
  "workspaces": ["server", "web"],
  "scripts": {
    "dev": "concurrently -n server,web -c blue,green \"npm run dev -w server\" \"npm run dev -w web\"",
    "test": "npm test -w server && npm test -w web",
    "backfill": "npm run backfill -w server"
  },
```

Run: `npm install` (root). Expected: installs without errors.

- [ ] **Step 2: Write the failing tests**

`web/test/time.test.ts`:
```ts
import { describe, expect, test } from 'vitest';
import { describeTiming, zoneLabel } from '../src/lib/time';

describe('describeTiming', () => {
  test('BMO in IST during US daylight time', () => {
    expect(describeTiming('2026-10-15', 'BMO', '16:00', 'Asia/Kolkata'))
      .toEqual({ et: 'BMO · before 9:30 AM', local: 'before 7:00 PM', nextDay: false });
  });
  test('AMC in IST crosses midnight (+1), EDT vs EST', () => {
    expect(describeTiming('2026-10-15', 'AMC', '16:00', 'Asia/Kolkata'))
      .toEqual({ et: 'AMC · after 4:00 PM', local: 'after 1:30 AM', nextDay: true });
    expect(describeTiming('2026-12-10', 'AMC', '16:00', 'Asia/Kolkata'))
      .toEqual({ et: 'AMC · after 4:00 PM', local: 'after 2:30 AM', nextDay: true });
  });
  test('early close day', () => {
    expect(describeTiming('2026-11-27', 'AMC', '13:00', 'Asia/Kolkata'))
      .toEqual({ et: 'AMC · after 1:00 PM', local: 'after 11:30 PM', nextDay: false });
  });
  test('London in the week US is on EDT but UK is on GMT', () => {
    expect(describeTiming('2026-10-29', 'AMC', '16:00', 'Europe/London').local).toBe('after 8:00 PM');
    expect(describeTiming('2026-10-15', 'AMC', '16:00', 'Europe/London').local).toBe('after 9:00 PM');
  });
  test('user in New York sees the same clock', () => {
    expect(describeTiming('2026-10-15', 'AMC', '16:00', 'America/New_York').local).toBe('after 4:00 PM');
  });
  test('during market and unknown', () => {
    expect(describeTiming('2026-10-15', 'DMH', '16:00', 'Asia/Kolkata'))
      .toEqual({ et: 'During market · 9:30 AM–4:00 PM', local: '7:00 PM–1:30 AM', nextDay: true });
    expect(describeTiming('2026-10-15', 'UNKNOWN', '16:00', 'Asia/Kolkata'))
      .toEqual({ et: 'Time not announced', local: '—', nextDay: false });
  });
});

describe('zoneLabel', () => {
  test('IST is named; others use the short offset name', () => {
    expect(zoneLabel('Asia/Kolkata', '2026-10-15')).toBe('IST');
    expect(zoneLabel('America/New_York', '2026-10-15')).toBe('EDT');
    expect(zoneLabel('America/New_York', '2026-12-10')).toBe('EST');
  });
});
```

`web/test/ranges.test.ts`:
```ts
import { describe, expect, test } from 'vitest';
import { rangeFor, shiftAnchor } from '../src/lib/ranges';

describe('rangeFor', () => {
  test('day, week (Mon–Fri), month, quarter', () => {
    expect(rangeFor('day', '2026-10-15')).toEqual({ from: '2026-10-15', to: '2026-10-15' });
    expect(rangeFor('week', '2026-10-15')).toEqual({ from: '2026-10-12', to: '2026-10-16' });
    expect(rangeFor('month', '2026-10-15')).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(rangeFor('quarter', '2026-10-15')).toEqual({ from: '2026-10-01', to: '2026-12-31' });
  });
});

describe('shiftAnchor', () => {
  test('day skips weekends', () => {
    expect(shiftAnchor('day', '2026-10-16', 1)).toBe('2026-10-19');
    expect(shiftAnchor('day', '2026-10-19', -1)).toBe('2026-10-16');
  });
  test('week, month, quarter', () => {
    expect(shiftAnchor('week', '2026-10-15', 1)).toBe('2026-10-22');
    expect(shiftAnchor('month', '2026-10-15', -1)).toBe('2026-09-15');
    expect(shiftAnchor('quarter', '2026-10-15', 1)).toBe('2027-01-15');
  });
});
```

`web/test/format.test.ts`:
```ts
import { describe, expect, test } from 'vitest';
import { formatDateHeading, formatEps, formatPct, formatUsd, formatUsdFull } from '../src/lib/format';

describe('format', () => {
  test('formatUsd compact', () => {
    expect(formatUsd(2_308_617_010_000)).toBe('$2.31T');
    expect(formatUsd(165_912_461_000)).toBe('$165.9B');
    expect(formatUsd(512_300_000)).toBe('$512.3M');
    expect(formatUsd(-1_500_000_000)).toBe('-$1.5B');
    expect(formatUsd(null)).toBe('—');
  });
  test('formatUsdFull', () => {
    expect(formatUsdFull(47_100_000_000)).toBe('$47,100,000,000');
  });
  test('formatEps', () => {
    expect(formatEps(1.66)).toBe('$1.66');
    expect(formatEps(-0.76)).toBe('-$0.76');
    expect(formatEps(null)).toBe('—');
  });
  test('formatPct', () => {
    expect(formatPct(3)).toBe('+3.0%');
    expect(formatPct(-7.04)).toBe('-7.0%');
    expect(formatPct(null)).toBe('—');
  });
  test('formatDateHeading', () => {
    expect(formatDateHeading('2026-10-15')).toBe('Thu, Oct 15, 2026');
  });
});
```

`web/test/storage.test.ts`:
```ts
import { describe, expect, test, vi } from 'vitest';
import { readJson, writeJson } from '../src/lib/storage';

describe('storage', () => {
  test('round trip', () => {
    writeJson('k', ['A']);
    expect(readJson('k', [])).toEqual(['A']);
  });
  test('corrupt or blocked storage falls back silently', () => {
    localStorage.setItem('bad', '{not json');
    expect(readJson('bad', ['x'])).toEqual(['x']);
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    expect(() => writeJson('k', 1)).not.toThrow();
    spy.mockRestore();
  });
});
```

`web/test/stale.test.ts`:
```ts
import { describe, expect, test } from 'vitest';
import { staleSources } from '../src/lib/stale';

const now = Date.parse('2026-10-15T20:00:00Z');

describe('staleSources', () => {
  test('healthy source -> nothing', () => {
    expect(staleSources([{ source: 'nasdaq', lastSuccessAt: '2026-10-15T19:00:00Z', lastError: null, lastErrorAt: null }], now)).toEqual([]);
  });
  test('error newer than last success -> banner with age and error', () => {
    expect(staleSources([{ source: 'nasdaq', lastSuccessAt: '2026-10-15T17:00:00Z', lastError: 'HTTP 403', lastErrorAt: '2026-10-15T19:00:00Z' }], now))
      .toEqual([{ source: 'nasdaq', message: 'Nasdaq data last updated 3h ago (latest attempt failed: HTTP 403)' }]);
  });
  test('never succeeded', () => {
    expect(staleSources([{ source: 'finnhub', lastSuccessAt: null, lastError: 'FINNHUB_TOKEN is not set', lastErrorAt: '2026-10-15T19:00:00Z' }], now))
      .toEqual([{ source: 'finnhub', message: 'Finnhub data never loaded (FINNHUB_TOKEN is not set)' }]);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -w web`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement**

`web/src/lib/time.ts`:
```ts
import { DateTime, IANAZone } from 'luxon';
import type { Timing } from '../../../server/src/api/types';

export const ET = 'America/New_York';
export const FALLBACK_ZONE = 'Asia/Kolkata';

export function detectZone(): string {
  try {
    const z = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return z && IANAZone.isValidZone(z) ? z : FALLBACK_ZONE;
  } catch {
    return FALLBACK_ZONE;
  }
}

export function todayEt(): string {
  return DateTime.now().setZone(ET).toISODate()!;
}

/** "IST" for India (en-US would say GMT+5:30); otherwise the en-US short name, e.g. EDT, GMT+4. */
export function zoneLabel(zone: string, date: string): string {
  if (zone === 'Asia/Kolkata' || zone === 'Asia/Calcutta') return 'IST';
  return DateTime.fromISO(`${date}T12:00`, { zone }).setLocale('en-US').offsetNameShort ?? zone;
}

const clock = (d: DateTime) => d.setLocale('en-US').toFormat('h:mm a');

export function describeTiming(
  reportDate: string, timing: Timing, sessionClose: string, zone: string,
): { et: string; local: string; nextDay: boolean } {
  const at = (hhmm: string) => DateTime.fromISO(`${reportDate}T${hhmm}`, { zone: ET });
  const open = at('09:30');
  const close = at(sessionClose);
  const local = (d: DateTime) => d.setZone(zone);
  const shifted = (d: DateTime) => local(d).toISODate()! > reportDate;

  switch (timing) {
    case 'BMO':
      return { et: 'BMO · before 9:30 AM', local: `before ${clock(local(open))}`, nextDay: shifted(open) };
    case 'AMC':
      return { et: `AMC · after ${clock(close)}`, local: `after ${clock(local(close))}`, nextDay: shifted(close) };
    case 'DMH':
      return {
        et: `During market · 9:30 AM–${clock(close)}`,
        local: `${clock(local(open))}–${clock(local(close))}`,
        nextDay: shifted(close),
      };
    default:
      return { et: 'Time not announced', local: '—', nextDay: false };
  }
}
```

`web/src/lib/ranges.ts`:
```ts
import { DateTime } from 'luxon';

export type View = 'day' | 'week' | 'month' | 'quarter' | 'custom';

const iso = (d: DateTime) => d.toISODate()!;

export function rangeFor(view: Exclude<View, 'custom'>, anchor: string): { from: string; to: string } {
  const a = DateTime.fromISO(anchor);
  switch (view) {
    case 'day':
      return { from: anchor, to: anchor };
    case 'week': {
      const monday = a.startOf('week');
      return { from: iso(monday), to: iso(monday.plus({ days: 4 })) };
    }
    case 'month':
      return { from: iso(a.startOf('month')), to: iso(a.endOf('month')) };
    case 'quarter':
      return { from: iso(a.startOf('quarter')), to: iso(a.endOf('quarter')) };
  }
}

export function shiftAnchor(view: View, anchor: string, dir: 1 | -1): string {
  const a = DateTime.fromISO(anchor);
  switch (view) {
    case 'day': {
      let n = a.plus({ days: dir });
      while (n.weekday > 5) n = n.plus({ days: dir });
      return iso(n);
    }
    case 'week':
      return iso(a.plus({ weeks: dir }));
    case 'month':
      return iso(a.plus({ months: dir }));
    case 'quarter':
      return iso(a.plus({ months: 3 * dir }));
    case 'custom':
      return anchor;
  }
}
```

`web/src/lib/format.ts`:
```ts
import { DateTime } from 'luxon';

export function formatUsd(n: number | null): string {
  if (n == null) return '—';
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (abs >= 1e12) return `${sign}$${(abs / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  return `${sign}$${abs.toLocaleString('en-US')}`;
}

export function formatUsdFull(n: number | null): string {
  if (n == null) return '—';
  return `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US')}`;
}

export function formatEps(n: number | null): string {
  if (n == null) return '—';
  return `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`;
}

export function formatPct(n: number | null): string {
  if (n == null) return '—';
  return `${n > 0 ? '+' : ''}${n.toFixed(1)}%`;
}

export function formatDateHeading(date: string): string {
  return DateTime.fromISO(date).setLocale('en-US').toFormat('ccc, LLL d, yyyy');
}
```

`web/src/lib/storage.ts`:
```ts
export function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable (private mode, blocked): keep state in memory only.
  }
}
```

`web/src/lib/stale.ts`:
```ts
import type { SourceStatusDto } from '../../../server/src/api/types';

const NAMES: Record<string, string> = { nasdaq: 'Nasdaq', finnhub: 'Finnhub', sec: 'SEC EDGAR', cboe: 'Cboe options' };

export function staleSources(sources: SourceStatusDto[], nowMs: number): { source: string; message: string }[] {
  const out: { source: string; message: string }[] = [];
  for (const s of sources) {
    const name = NAMES[s.source] ?? s.source;
    const ok = s.lastSuccessAt ? Date.parse(s.lastSuccessAt) : null;
    const err = s.lastErrorAt ? Date.parse(s.lastErrorAt) : null;
    if (err == null || (ok != null && ok >= err)) continue;
    if (ok == null) {
      out.push({ source: s.source, message: `${name} data never loaded (${s.lastError})` });
    } else {
      const hours = Math.max(1, Math.round((nowMs - ok) / 3_600_000));
      out.push({ source: s.source, message: `${name} data last updated ${hours}h ago (latest attempt failed: ${s.lastError})` });
    }
  }
  return out;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -w web`
Expected: PASS. If `zoneLabel('America/New_York', …)` returns something other than `EDT`/`EST` in this Node build's ICU, stop and report — do not loosen the test.

- [ ] **Step 6: Commit**

```bash
git add web package.json package-lock.json
git commit -m "feat: add web scaffold with ET/local time, range and format logic" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Web UI

**Files:**
- Create: `web/src/main.tsx`, `web/src/App.tsx`, `web/src/styles.css`, `web/src/api.ts`
- Create: `web/src/hooks/useHidden.ts`, `web/src/hooks/useZone.ts`
- Create: `web/src/components/Calendar.tsx`, `Header.tsx`, `EarningsTable.tsx`, `DetailPanel.tsx`, `StaleBanner.tsx`, `StatusPage.tsx`
- Test: `web/test/EarningsTable.test.tsx`, `web/test/useHidden.test.tsx`

**Interfaces:**
- Consumes: Task 11 libs; `ReportDto`, `EarningsResponse`, `StatusResponse` types.
- Produces: `useHidden(): { hidden: Set<string>; toggle(symbol: string): void }` (localStorage key `hiddenTickers`); `useZone(): { zone: string; isOverride: boolean; setZone(z: string | null): void }` (key `tzOverride`); `<EarningsTable rows zone hidden showHidden onToggleHidden onSelect />`.

- [ ] **Step 1: Write the failing tests**

`web/test/useHidden.test.tsx`:
```tsx
import { act, renderHook } from '@testing-library/react';
import { expect, test } from 'vitest';
import { useHidden } from '../src/hooks/useHidden';

test('toggle hides and unhides, and persists', () => {
  const { result } = renderHook(() => useHidden());
  act(() => result.current.toggle('TSM'));
  expect(result.current.hidden.has('TSM')).toBe(true);
  expect(JSON.parse(localStorage.getItem('hiddenTickers')!)).toEqual(['TSM']);
  const again = renderHook(() => useHidden());
  expect(again.result.current.hidden.has('TSM')).toBe(true);
  act(() => result.current.toggle('TSM'));
  expect(result.current.hidden.has('TSM')).toBe(false);
});
```

`web/test/EarningsTable.test.tsx`:
```tsx
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import type { ReportDto } from '../../server/src/api/types';
import { EarningsTable } from '../src/components/EarningsTable';

const dto = (over: Partial<ReportDto>): ReportDto => ({
  id: 1, symbol: 'TSM', name: 'Taiwan Semiconductor', reportDate: '2026-10-15', fiscalQuarter: 'Sep/2026',
  timing: 'BMO', timingSource: 'nasdaq', sessionClose: '16:00', rescheduledFrom: null, exchange: 'NYSE',
  marketCap: 2.31e12, marketCapAsOf: '2026-10-15',
  eps: { estimate: 4.45, actual: null, surprisePct: null, result: null, noOfEsts: 6 },
  revenue: { estimate: null, actual: null, surprisePct: null, result: null },
  expectedMove: null, sec: { check: null, acceptedAt: null, docUrl: null, indexUrl: null },
  fetched: { calendar: null, revenue: null, sec: null }, flags: [], ...over,
});

const rows = [
  dto({ id: 1, symbol: 'AMCCO', name: 'After Co', timing: 'AMC' }),
  dto({ id: 2, symbol: 'TSM' }),
  dto({ id: 3, symbol: 'SCHW', name: 'Schwab', eps: { estimate: 1.66, actual: 1.71, surprisePct: 3, result: 'beat', noOfEsts: 10 } }),
];

function renderTable(over: Partial<Parameters<typeof EarningsTable>[0]> = {}) {
  const props = {
    rows, zone: 'Asia/Kolkata', hidden: new Set<string>(), showHidden: false,
    onToggleHidden: vi.fn(), onSelect: vi.fn(), ...over,
  };
  render(<EarningsTable {...props} />);
  return props;
}

describe('EarningsTable', () => {
  test('groups BMO before AMC and shows ET and local time side by side', () => {
    renderTable();
    const groups = screen.getAllByRole('rowheader').map((h) => h.textContent);
    expect(groups).toEqual(['Before open', 'After close']);
    const tsm = screen.getByText('TSM').closest('tr')!;
    expect(within(tsm).getByText('BMO · before 9:30 AM')).toBeTruthy();
    expect(within(tsm).getByText('before 7:00 PM')).toBeTruthy();
  });
  test('hidden rows are omitted unless showHidden, then shown greyed', () => {
    renderTable({ hidden: new Set(['TSM']) });
    expect(screen.queryByText('TSM')).toBeNull();
  });
  test('showHidden reveals hidden rows with is-hidden class', () => {
    renderTable({ hidden: new Set(['TSM']), showHidden: true });
    expect(screen.getByText('TSM').closest('tr')!.className).toContain('is-hidden');
  });
  test('checkbox toggles hidden without opening the detail panel', () => {
    const props = renderTable();
    fireEvent.click(screen.getByLabelText('Hide TSM'));
    expect(props.onToggleHidden).toHaveBeenCalledWith('TSM');
    expect(props.onSelect).not.toHaveBeenCalled();
  });
  test('beat shows ▲ and clicking a row selects it', () => {
    const props = renderTable();
    const schw = screen.getByText('SCHW').closest('tr')!;
    expect(within(schw).getByText(/\$1\.71 ▲/)).toBeTruthy();
    fireEvent.click(schw);
    expect(props.onSelect).toHaveBeenCalledWith(expect.objectContaining({ symbol: 'SCHW' }));
  });
  test('flags render a ⚠ with the reason', () => {
    render(<EarningsTable rows={[dto({ timing: 'UNKNOWN', flags: [{ field: 'timing', message: 'Time not announced' }] })]}
      zone="Asia/Kolkata" hidden={new Set()} showHidden={false} onToggleHidden={vi.fn()} onSelect={vi.fn()} />);
    expect(screen.getByLabelText('Time not announced').textContent).toBe('⚠');
  });
  test('empty state', () => {
    renderTable({ rows: [] });
    expect(screen.getByText('No earnings reports match this range and filter.')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w web`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement hooks and API client**

`web/src/hooks/useHidden.ts`:
```ts
import { useCallback, useState } from 'react';
import { readJson, writeJson } from '../lib/storage';

const KEY = 'hiddenTickers';

export function useHidden(): { hidden: Set<string>; toggle: (symbol: string) => void } {
  const [hidden, setHidden] = useState<Set<string>>(() => new Set(readJson<string[]>(KEY, [])));
  const toggle = useCallback((symbol: string) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(symbol)) next.delete(symbol);
      else next.add(symbol);
      writeJson(KEY, [...next]);
      return next;
    });
  }, []);
  return { hidden, toggle };
}
```

`web/src/hooks/useZone.ts`:
```ts
import { IANAZone } from 'luxon';
import { useState } from 'react';
import { detectZone } from '../lib/time';
import { readJson, writeJson } from '../lib/storage';

const KEY = 'tzOverride';

export function useZone(): { zone: string; isOverride: boolean; setZone: (z: string | null) => void } {
  const [override, setOverride] = useState<string | null>(() => readJson<string | null>(KEY, null));
  const valid = override != null && IANAZone.isValidZone(override);
  return {
    zone: valid ? override : detectZone(),
    isOverride: valid,
    setZone: (z) => {
      setOverride(z);
      writeJson(KEY, z);
    },
  };
}
```

`web/src/api.ts`:
```ts
import type { EarningsResponse, StatusResponse } from '../../server/src/api/types';

export async function fetchEarnings(
  p: { from: string; to: string; minCap: number | null; q: string },
  signal: AbortSignal,
): Promise<EarningsResponse> {
  const qs = new URLSearchParams({ from: p.from, to: p.to });
  if (p.minCap != null) qs.set('minCap', String(p.minCap));
  if (p.q.trim()) qs.set('q', p.q.trim());
  const res = await fetch(`/api/earnings?${qs}`, { signal });
  if (!res.ok) throw new Error(`Server returned ${res.status}`);
  return res.json() as Promise<EarningsResponse>;
}

export async function fetchStatus(): Promise<StatusResponse> {
  const res = await fetch('/api/status');
  if (!res.ok) throw new Error(`Server returned ${res.status}`);
  return res.json() as Promise<StatusResponse>;
}
```

- [ ] **Step 4: Implement the table**

`web/src/components/EarningsTable.tsx`:
```tsx
import { Fragment, type KeyboardEvent } from 'react';
import type { Flag, ReportDto, ResultPart, Timing } from '../../../server/src/api/types';
import { formatDateHeading, formatEps, formatPct, formatUsd } from '../lib/format';
import { describeTiming, zoneLabel } from '../lib/time';

interface Props {
  rows: ReportDto[];
  zone: string;
  hidden: Set<string>;
  showHidden: boolean;
  onToggleHidden: (symbol: string) => void;
  onSelect: (row: ReportDto) => void;
}

const ORDER: Timing[] = ['BMO', 'DMH', 'AMC', 'UNKNOWN'];
const GROUP_LABEL: Record<Timing, string> = {
  BMO: 'Before open', DMH: 'During market', AMC: 'After close', UNKNOWN: 'Time not announced',
};
const COLS = 9;

function group(rows: ReportDto[]): [string, [Timing, ReportDto[]][]][] {
  const byDate = new Map<string, Map<Timing, ReportDto[]>>();
  for (const r of rows) {
    const d = byDate.get(r.reportDate) ?? new Map<Timing, ReportDto[]>();
    d.set(r.timing, [...(d.get(r.timing) ?? []), r]);
    byDate.set(r.reportDate, d);
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, m]) => [date, ORDER.filter((t) => m.has(t)).map((t) => [t, m.get(t)!] as [Timing, ReportDto[]])]);
}

export function Warn({ flags }: { flags: Flag[] }) {
  if (flags.length === 0) return null;
  const text = flags.map((f) => f.message).join('\n');
  return <span className="warn" title={text} aria-label={text} role="img">⚠</span>;
}

function Result({ part, format }: { part: ResultPart; format: (n: number | null) => string }) {
  const arrow = part.result === 'beat' ? ' ▲' : part.result === 'miss' ? ' ▼' : '';
  return (
    <>
      <span className="est">{format(part.estimate)}</span>
      <span className="sep"> / </span>
      <span className={`act ${part.result ?? ''}`} title={part.surprisePct == null ? undefined : `Surprise ${formatPct(part.surprisePct)}`}>
        {part.actual == null ? '—' : `${format(part.actual)}${arrow}`}
      </span>
    </>
  );
}

export function EarningsTable({ rows, zone, hidden, showHidden, onToggleHidden, onSelect }: Props) {
  const visible = rows.filter((r) => showHidden || !hidden.has(r.symbol));
  if (visible.length === 0) return <p className="empty">No earnings reports match this range and filter.</p>;
  const tz = zoneLabel(zone, visible[0]!.reportDate);

  return (
    <table className="earnings">
      <thead>
        <tr>
          <th scope="col" className="c-hide">Hide</th>
          <th scope="col">Release (ET)</th>
          <th scope="col">Your time ({tz})</th>
          <th scope="col">Company</th>
          <th scope="col">Exchange</th>
          <th scope="col" className="num">Market cap</th>
          <th scope="col" className="num">EPS est / act</th>
          <th scope="col" className="num">Revenue est / act</th>
          <th scope="col" className="num">Exp. move</th>
        </tr>
      </thead>
      {group(visible).map(([date, timings]) => (
        <tbody key={date}>
          <tr className="date-row"><th colSpan={COLS} scope="colgroup">{formatDateHeading(date)}</th></tr>
          {timings.map(([timing, list]) => (
            <Fragment key={timing}>
              <tr className="group-row"><th colSpan={COLS} scope="row">{GROUP_LABEL[timing]}</th></tr>
              {list.map((r) => (
                <Row key={r.id} r={r} zone={zone} isHidden={hidden.has(r.symbol)} onToggleHidden={onToggleHidden} onSelect={onSelect} />
              ))}
            </Fragment>
          ))}
        </tbody>
      ))}
    </table>
  );
}

function Row({ r, zone, isHidden, onToggleHidden, onSelect }: {
  r: ReportDto; zone: string; isHidden: boolean; onToggleHidden: (s: string) => void; onSelect: (r: ReportDto) => void;
}) {
  const t = describeTiming(r.reportDate, r.timing, r.sessionClose, zone);
  const flags = (field: Flag['field']) => r.flags.filter((f) => f.field === field);
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Enter') onSelect(r); };

  return (
    <tr className={isHidden ? 'row is-hidden' : 'row'} onClick={() => onSelect(r)} onKeyDown={onKey} tabIndex={0}>
      <td data-label="Hide" className="c-hide" onClick={(e) => e.stopPropagation()}>
        <input type="checkbox" aria-label={`Hide ${r.symbol}`} checked={isHidden} onChange={() => onToggleHidden(r.symbol)} />
      </td>
      <td data-label="Release (ET)">{t.et} <Warn flags={flags('timing')} /></td>
      <td data-label="Your time">
        {t.local}{t.nextDay && <sup className="plus1" title="Next day in your time zone">+1</sup>}
      </td>
      <td data-label="Company"><strong>{r.symbol}</strong> <span className="name">{r.name}</span></td>
      <td data-label="Exchange">{r.exchange ?? '—'}</td>
      <td data-label="Market cap" className="num">{formatUsd(r.marketCap)} <Warn flags={flags('marketCap')} /></td>
      <td data-label="EPS est / act" className="num"><Result part={r.eps} format={formatEps} /></td>
      <td data-label="Revenue est / act" className="num"><Result part={r.revenue} format={formatUsd} /></td>
      <td data-label="Exp. move" className="num">
        {r.expectedMove ? `±${r.expectedMove.movePct.toFixed(1)}%` : '—'} <Warn flags={flags('expectedMove')} />
      </td>
    </tr>
  );
}
```

Note: group rows use `<th scope="row">`, which Testing Library exposes as role `rowheader` — the test relies on that.

- [ ] **Step 5: Run table tests to verify they pass**

Run: `npm test -w web`
Expected: PASS.

- [ ] **Step 6: Implement the remaining components, styles and entry**

`web/src/components/StaleBanner.tsx`:
```tsx
import type { SourceStatusDto } from '../../../server/src/api/types';
import { staleSources } from '../lib/stale';

export function StaleBanner({ sources }: { sources: SourceStatusDto[] }) {
  const stale = staleSources(sources, Date.now());
  if (stale.length === 0) return null;
  return (
    <div className="banner" role="status">
      {stale.map((s) => <p key={s.source}>⚠ {s.message}. Showing the last good data.</p>)}
    </div>
  );
}
```

`web/src/components/Header.tsx`:
```tsx
import type { View } from '../lib/ranges';
import { formatDateHeading } from '../lib/format';

export const CAP_OPTIONS: { label: string; value: number | null }[] = [
  { label: 'All', value: null },
  { label: '$300M+', value: 3e8 },
  { label: '$2B+', value: 2e9 },
  { label: '$10B+', value: 1e10 },
  { label: '$200B+', value: 2e11 },
];

const VIEWS: { id: View; label: string }[] = [
  { id: 'day', label: 'Day' }, { id: 'week', label: 'Week' }, { id: 'month', label: 'Month' },
  { id: 'quarter', label: 'Quarter' }, { id: 'custom', label: 'Custom' },
];

interface Props {
  view: View; onView: (v: View) => void;
  range: { from: string; to: string };
  custom: { from: string; to: string }; onCustom: (r: { from: string; to: string }) => void;
  onShift: (dir: 1 | -1) => void; onToday: () => void;
  minCap: number | null; onMinCap: (v: number | null) => void;
  query: string; onQuery: (q: string) => void;
  showHidden: boolean; hiddenCount: number; onShowHidden: (v: boolean) => void;
  zone: string; zoneText: string; isOverride: boolean; onZone: (z: string | null) => void;
}

const ZONES: string[] = (() => {
  try { return Intl.supportedValuesOf('timeZone'); } catch { return ['Asia/Kolkata', 'America/New_York', 'Europe/London', 'UTC']; }
})();

export function Header(p: Props) {
  const label = p.range.from === p.range.to
    ? formatDateHeading(p.range.from)
    : `${formatDateHeading(p.range.from)} – ${formatDateHeading(p.range.to)}`;
  return (
    <header className="header">
      <div className="title-row">
        <h1>US Earnings Calendar</h1>
        <label className="zone">
          Your time zone: <strong>{p.zoneText}</strong>{' '}
          <select value={p.isOverride ? p.zone : ''} onChange={(e) => p.onZone(e.target.value || null)} aria-label="Time zone">
            <option value="">Detected ({p.isOverride ? 'auto' : p.zone})</option>
            {ZONES.map((z) => <option key={z} value={z}>{z}</option>)}
          </select>
        </label>
      </div>
      <div className="controls">
        <div className="seg" role="tablist">
          {VIEWS.map((v) => (
            <button key={v.id} role="tab" aria-selected={p.view === v.id} className={p.view === v.id ? 'on' : ''} onClick={() => p.onView(v.id)}>
              {v.label}
            </button>
          ))}
        </div>
        {p.view === 'custom' ? (
          <div className="custom">
            <input type="date" aria-label="From" value={p.custom.from} onChange={(e) => p.onCustom({ ...p.custom, from: e.target.value })} />
            <span>to</span>
            <input type="date" aria-label="To" value={p.custom.to} onChange={(e) => p.onCustom({ ...p.custom, to: e.target.value })} />
          </div>
        ) : (
          <div className="nav">
            <button aria-label="Previous" onClick={() => p.onShift(-1)}>◀</button>
            <span className="range">{label}</span>
            <button aria-label="Next" onClick={() => p.onShift(1)}>▶</button>
            <button onClick={p.onToday}>Today</button>
          </div>
        )}
      </div>
      <div className="filters">
        <label>Market cap{' '}
          <select value={p.minCap ?? ''} onChange={(e) => p.onMinCap(e.target.value === '' ? null : Number(e.target.value))}>
            {CAP_OPTIONS.map((o) => <option key={o.label} value={o.value ?? ''}>{o.label}</option>)}
          </select>
        </label>
        <input type="search" placeholder="Search ticker or company" value={p.query} onChange={(e) => p.onQuery(e.target.value)} aria-label="Search" />
        <label className="check">
          <input type="checkbox" checked={p.showHidden} onChange={(e) => p.onShowHidden(e.target.checked)} /> Show hidden ({p.hiddenCount})
        </label>
      </div>
    </header>
  );
}
```

`web/src/components/DetailPanel.tsx`:
```tsx
import type { ReportDto } from '../../../server/src/api/types';
import { formatDateHeading, formatEps, formatPct, formatUsd, formatUsdFull } from '../lib/format';
import { describeTiming } from '../lib/time';
import { Warn } from './EarningsTable';

const SEC_TEXT: Record<string, string> = {
  verified: '✓ Verified: 8-K filed before the open',
  consistent: '≈ Consistent with the 8-K filing time',
  derived: '✓ Timing taken from the 8-K filing time',
  contradicted: '⚠ Contradicted by the 8-K filing time',
  unverifiable: 'Not verifiable from the 8-K filing time',
};

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');

export function DetailPanel({ r, zone, onClose }: { r: ReportDto; zone: string; onClose: () => void }) {
  const t = describeTiming(r.reportDate, r.timing, r.sessionClose, zone);
  const em = r.expectedMove;
  return (
    <aside className="panel" aria-label={`${r.symbol} details`}>
      <button className="close" onClick={onClose} aria-label="Close">×</button>
      <h2>{r.symbol} <span className="name">{r.name}</span></h2>
      <p className="muted">{r.fiscalQuarter ? `Quarter ending ${r.fiscalQuarter} · ` : ''}{formatDateHeading(r.reportDate)}</p>
      {r.rescheduledFrom && <p className="warn-text">Rescheduled from {formatDateHeading(r.rescheduledFrom)}</p>}

      <section>
        <h3>Release time</h3>
        <p>{t.et} ET · {t.local}{t.nextDay ? ' (+1 day)' : ''} your time</p>
        <p className="muted">Timing source: {r.timingSource ?? 'none'}</p>
        {r.sec.check && <p>{SEC_TEXT[r.sec.check]}{r.sec.acceptedAt ? ` (accepted ${r.sec.acceptedAt.replace('T', ' ')} ET)` : ''}</p>}
        <Warn flags={r.flags.filter((f) => f.field === 'timing')} />
      </section>

      <section>
        <h3>Results</h3>
        <dl>
          <dt>EPS</dt>
          <dd>Est {formatEps(r.eps.estimate)} · Actual {formatEps(r.eps.actual)} · Surprise {formatPct(r.eps.surprisePct)}
            {r.eps.noOfEsts != null && ` · ${r.eps.noOfEsts} estimates`}</dd>
          <dt>Revenue</dt>
          <dd>Est {formatUsdFull(r.revenue.estimate)} · Actual {formatUsdFull(r.revenue.actual)} · Surprise {formatPct(r.revenue.surprisePct)}</dd>
          <dt>Market cap</dt>
          <dd>{formatUsd(r.marketCap)}{r.marketCapAsOf && ` (as of ${r.marketCapAsOf})`}</dd>
          <dt>Exchange</dt>
          <dd>{r.exchange ?? '—'} (primary listing)</dd>
        </dl>
      </section>

      <section>
        <h3>Options-implied move</h3>
        {em ? (
          <p>±{em.movePct.toFixed(2)}% — straddle at strike {em.strike} expiring {em.expiry}: call mid {em.callMid.toFixed(2)} + put mid {em.putMid.toFixed(2)}, stock {em.underlying.toFixed(2)}. Snapshot {when(em.snapshotAt)}.</p>
        ) : <p>—</p>}
        <p className="muted">Our calculation from Cboe delayed quotes; includes some non-earnings time value, so it may read slightly above vendor figures.</p>
      </section>

      <section>
        <h3>Official release</h3>
        {r.sec.docUrl ? (
          <p><a href={r.sec.docUrl} target="_blank" rel="noreferrer">8-K on SEC EDGAR</a> · <a href={r.sec.indexUrl ?? undefined} target="_blank" rel="noreferrer">Filing index (Exhibit 99.1)</a></p>
        ) : <p>—</p>}
      </section>

      <section>
        <h3>Sources</h3>
        <ul className="muted">
          <li>Calendar, EPS, market cap: Nasdaq, fetched {when(r.fetched.calendar)}</li>
          <li>Revenue: Finnhub, fetched {when(r.fetched.revenue)}</li>
          <li>Exchange, filing check: SEC EDGAR, checked {when(r.fetched.sec)}</li>
        </ul>
      </section>
    </aside>
  );
}
```

`web/src/components/StatusPage.tsx`:
```tsx
import { useEffect, useState } from 'react';
import type { StatusResponse } from '../../../server/src/api/types';
import { fetchStatus } from '../api';

export function StatusPage() {
  const [data, setData] = useState<StatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { fetchStatus().then(setData).catch((e: Error) => setError(e.message)); }, []);
  if (error) return <main className="page"><p className="warn-text">Could not load status: {error}</p></main>;
  if (!data) return <main className="page"><p>Loading…</p></main>;
  return (
    <main className="page">
      <h1>Data source status</h1>
      <p>{data.counts.reports} reports · {data.counts.withExpectedMove} with expected move · {data.counts.secVerified} timing-checked against SEC</p>
      <table className="status">
        <thead><tr><th>Source</th><th>Last success</th><th>Last error</th><th>Error at</th></tr></thead>
        <tbody>
          {data.sources.map((s) => (
            <tr key={s.source}>
              <td>{s.source}</td>
              <td>{s.lastSuccessAt ? new Date(s.lastSuccessAt).toLocaleString() : '—'}</td>
              <td>{s.lastError ?? '—'}</td>
              <td>{s.lastErrorAt ? new Date(s.lastErrorAt).toLocaleString() : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p><a href="/">← Back to calendar</a></p>
    </main>
  );
}
```

`web/src/components/Calendar.tsx`:
```tsx
import { useEffect, useMemo, useState } from 'react';
import type { EarningsResponse, ReportDto } from '../../../server/src/api/types';
import { fetchEarnings } from '../api';
import { useHidden } from '../hooks/useHidden';
import { useZone } from '../hooks/useZone';
import { rangeFor, shiftAnchor, type View } from '../lib/ranges';
import { todayEt, zoneLabel } from '../lib/time';
import { DetailPanel } from './DetailPanel';
import { EarningsTable } from './EarningsTable';
import { Header } from './Header';
import { StaleBanner } from './StaleBanner';

type Load = { status: 'loading' } | { status: 'ok'; data: EarningsResponse } | { status: 'error'; error: string };

export function Calendar() {
  const today = todayEt();
  const [view, setView] = useState<View>('day');
  const [anchor, setAnchor] = useState(today);
  const [custom, setCustom] = useState({ from: today, to: today });
  const [minCap, setMinCap] = useState<number | null>(2e9);
  const [query, setQuery] = useState('');
  const [showHidden, setShowHidden] = useState(false);
  const [selected, setSelected] = useState<ReportDto | null>(null);
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const { hidden, toggle } = useHidden();
  const { zone, isOverride, setZone } = useZone();

  const range = useMemo(() => (view === 'custom' ? custom : rangeFor(view, anchor)), [view, anchor, custom]);
  const customInvalid = view === 'custom' && (!custom.from || !custom.to || custom.from > custom.to);

  useEffect(() => {
    if (customInvalid) return;
    const ac = new AbortController();
    setLoad({ status: 'loading' });
    fetchEarnings({ ...range, minCap, q: query }, ac.signal)
      .then((data) => setLoad({ status: 'ok', data }))
      .catch((e: Error) => { if (!ac.signal.aborted) setLoad({ status: 'error', error: e.message }); });
    return () => ac.abort();
  }, [range.from, range.to, minCap, query, customInvalid]);

  return (
    <div className="app">
      <Header
        view={view} onView={setView} range={range} custom={custom} onCustom={setCustom}
        onShift={(dir) => setAnchor((a) => shiftAnchor(view, a, dir))} onToday={() => setAnchor(today)}
        minCap={minCap} onMinCap={setMinCap} query={query} onQuery={setQuery}
        showHidden={showHidden} hiddenCount={hidden.size} onShowHidden={setShowHidden}
        zone={zone} zoneText={`${zoneLabel(zone, range.from)} (${zone})`} isOverride={isOverride} onZone={setZone}
      />
      {load.status === 'ok' && <StaleBanner sources={load.data.sources} />}
      <main className="content">
        {customInvalid && <p className="warn-text">Pick a valid From and To date.</p>}
        {!customInvalid && load.status === 'loading' && <p className="muted">Loading…</p>}
        {load.status === 'error' && <p className="warn-text">Could not load data: {load.error}</p>}
        {load.status === 'ok' && (
          <EarningsTable rows={load.data.rows} zone={zone} hidden={hidden} showHidden={showHidden}
            onToggleHidden={toggle} onSelect={setSelected} />
        )}
      </main>
      {selected && <DetailPanel r={selected} zone={zone} onClose={() => setSelected(null)} />}
      <footer className="footer muted">
        Data: Nasdaq, Finnhub, SEC EDGAR, Cboe (delayed). Prototype — not for trading decisions. <a href="/status">Data status</a>
      </footer>
    </div>
  );
}
```

`web/src/App.tsx`:
```tsx
import { Calendar } from './components/Calendar';
import { StatusPage } from './components/StatusPage';

export default function App() {
  return window.location.pathname === '/status' ? <StatusPage /> : <Calendar />;
}
```

`web/src/main.tsx`:
```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
```

`web/src/styles.css`:
```css
:root {
  --bg: #f7f7f5; --surface: #ffffff; --text: #1b1d21; --muted: #646a73; --border: #e2e3e0;
  --accent: #2456d6; --beat: #13804a; --miss: #c2362f; --warn: #b26a00; --group: #eef1f6;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #111316; --surface: #1a1d21; --text: #e8e9eb; --muted: #9aa1ab; --border: #2c3036;
    --accent: #7ea2ff; --beat: #4cc38a; --miss: #ff7b72; --warn: #f0b44c; --group: #20252c;
    color-scheme: dark;
  }
}
:root[data-theme="dark"] {
  --bg: #111316; --surface: #1a1d21; --text: #e8e9eb; --muted: #9aa1ab; --border: #2c3036;
  --accent: #7ea2ff; --beat: #4cc38a; --miss: #ff7b72; --warn: #f0b44c; --group: #20252c;
  color-scheme: dark;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
a { color: var(--accent); }
.app { max-width: 1280px; margin: 0 auto; padding: 16px; }
.header { display: grid; gap: 12px; margin-bottom: 12px; }
.title-row { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 8px; }
h1 { font-size: 20px; margin: 0; }
.zone select { max-width: 220px; }
.controls, .filters { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; }
.seg { display: inline-flex; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
.seg button { border: 0; background: var(--surface); color: var(--text); padding: 6px 12px; cursor: pointer; }
.seg button.on { background: var(--accent); color: #fff; }
.nav { display: flex; align-items: center; gap: 6px; }
.range { min-width: 160px; text-align: center; font-weight: 600; }
button, select, input { font: inherit; color: var(--text); background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 5px 8px; }
.check { display: inline-flex; gap: 6px; align-items: center; }
.banner { background: color-mix(in srgb, var(--warn) 15%, var(--surface)); border: 1px solid var(--warn); border-radius: 8px; padding: 4px 12px; margin-bottom: 12px; }
.banner p { margin: 6px 0; }
table.earnings { width: 100%; border-collapse: collapse; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; }
.earnings th, .earnings td { padding: 8px 10px; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; }
.earnings thead th { font-size: 12px; color: var(--muted); font-weight: 600; position: sticky; top: 0; background: var(--surface); z-index: 1; }
.date-row th { background: var(--bg); font-size: 15px; padding-top: 14px; }
.group-row th { background: var(--group); font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
.row { cursor: pointer; }
.row:hover, .row:focus { background: color-mix(in srgb, var(--accent) 7%, var(--surface)); outline: none; }
.row.is-hidden { opacity: .45; }
.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.name { color: var(--muted); }
.act.beat { color: var(--beat); font-weight: 600; }
.act.miss { color: var(--miss); font-weight: 600; }
.warn { color: var(--warn); cursor: help; }
.warn-text { color: var(--warn); }
.plus1 { color: var(--warn); margin-left: 2px; }
.muted { color: var(--muted); }
.empty { padding: 32px; text-align: center; color: var(--muted); }
.panel { position: fixed; top: 0; right: 0; bottom: 0; width: min(440px, 100%); background: var(--surface); border-left: 1px solid var(--border); padding: 20px; overflow-y: auto; box-shadow: -8px 0 24px rgb(0 0 0 / .12); z-index: 10; }
.panel h2 { margin-top: 0; font-size: 18px; }
.panel h3 { font-size: 13px; text-transform: uppercase; color: var(--muted); margin: 18px 0 6px; }
.panel dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; margin: 0; }
.panel dd { margin: 0; }
.close { position: absolute; top: 12px; right: 12px; font-size: 18px; line-height: 1; }
.footer { margin-top: 16px; font-size: 12px; }
.page { max-width: 960px; margin: 0 auto; padding: 16px; }
table.status { border-collapse: collapse; width: 100%; }
.status th, .status td { border-bottom: 1px solid var(--border); padding: 6px 8px; text-align: left; }

@media (max-width: 760px) {
  .earnings thead { display: none; }
  .earnings, .earnings tbody, .earnings tr, .earnings td, .earnings th { display: block; width: 100%; }
  .earnings tr.row { border-bottom: 1px solid var(--border); padding: 8px 0; }
  .earnings td { border: 0; padding: 3px 12px; text-align: left; }
  .earnings td::before { content: attr(data-label); display: inline-block; min-width: 130px; color: var(--muted); font-size: 12px; }
  .earnings td.num { text-align: left; }
  .range { min-width: 0; }
}
```

- [ ] **Step 7: Run tests and build**

Run: `npm test -w web && npm run build -w web`
Expected: tests PASS; `tsc` reports no errors; Vite build succeeds.

- [ ] **Step 8: Commit**

```bash
git add web
git commit -m "feat: add calendar UI with hide, detail panel and status page" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Live run, accuracy spot-check, README

**Files:**
- Create: `README.md`

- [ ] **Step 1: Configure secrets**

Copy `.env.example` to `.env`. Fill `SEC_USER_AGENT` (e.g. `EarningsCalendar/0.1 <owner email>`). Fill `FINNHUB_TOKEN` if the owner has registered one; if not, leave blank and confirm `/status` shows `FINNHUB_TOKEN is not set` for finnhub while everything else works.

- [ ] **Step 2: Start the app and check live data**

Run: `npm run dev` (root). Wait ~2 minutes for the warm-up refresh.
Then: `curl "http://127.0.0.1:3001/api/earnings?from=<today>&to=<today>&minCap=2000000000"`
Expected: JSON with today's reporters; `sources` includes `nasdaq` with a recent `lastSuccessAt`.
Open http://localhost:5173 — verify the table renders, ET and local columns differ by the expected offset, hide checkbox persists across reload, detail panel opens, `/status` page loads.

- [ ] **Step 3: Backfill a short window first**

Run: `npm run backfill -- <date 10 trading days ago>`
Expected: logs Nasdaq progress, `Finnhub: done`, `SEC: done`. Then query that window via the API and confirm rows have `exchange` set and many have `sec.check` populated.

- [ ] **Step 4: Accuracy spot-check (spec section 11 acceptance)**

Pick 10 reports from the backfilled window and current week, mixing BMO and AMC and at least one class-share ticker. For each, open the company's press release (8-K link in the detail panel) and compare:

| Check | Pass condition |
|---|---|
| Report date | Matches the press release date |
| BMO/AMC | Matches the release time in the press release / wire timestamp |
| EPS actual | Matches the release's reported EPS basis that Nasdaq uses (note GAAP vs adjusted if different) |
| Revenue actual | Matches total revenue in the release (when Finnhub key present) |
| Exchange | Matches the company's listing on nasdaq.com / nyse.com |
| Your time | Equals ET + correct offset for the date |

Record results in the commit message body. Any mismatch: stop, open a bug, do not ship — investigate with superpowers:systematic-debugging.

- [ ] **Step 5: Write README**

`README.md`:
```markdown
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
- Expected move is our straddle calculation, available only from launch onward.
- Market cap on backfilled rows is current, not at report time (flagged).

## Health
`/status` page (or `GET /api/status`) shows each source's last success and last error.

## Tests
`npm test`
```

- [ ] **Step 6: Final verification**

Run: `npm test && npm run typecheck -w server && npm run build -w web`
Expected: everything passes.

- [ ] **Step 7: Commit**

```bash
git add README.md
git commit -m "docs: add README and record accuracy spot-check" -m "<paste spot-check table results here>" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Out of scope (tracked for later phases)

- Passkey login and server-side hide list (spec section 9) — separate plan.
- Paid data sources and true highest-volume venue (spec section 10) — separate plan.
- Mobile app.
- Hosting/deployment — decide before client demo.
