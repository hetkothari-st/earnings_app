/**
 * Corpus harness for the US press-release reader.
 *   npm run reader-corpus -w server            (print only)
 *   npm run reader-corpus -w server -- --write (also write test/fixtures/us/releases/report.json)
 * Reads every test/fixtures/us/releases/*.htm and compares accepted values with
 * expected.json (EPS ±0.01, revenue ±0.5%). Adjusted EPS is gated against Nasdaq;
 * GAAP EPS against the release (hand-read); revenue against Finnhub or the release.
 * An accepted value whose expected figure is null counts as a miss.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { readUsRelease } from '../sources/releaseReader.js';

const dir = fileURLToPath(new URL('../../test/fixtures/us/releases/', import.meta.url));
const write = process.argv.includes('--write');

interface Expected {
  symbol: string;
  quarterEnd: string;
  epsAdjusted: number | null;
  epsGaap: number | null;
  revenue: number | null;
  releaseEpsAdjusted?: number;
  note?: string;
}

const FIELDS = ['epsAdjusted', 'epsGaap', 'revenue'] as const;
type Field = (typeof FIELDS)[number];
const GATE: Record<Field, keyof typeof config.fastFields> = { epsAdjusted: 'usEpsAdjusted', epsGaap: 'usEpsGaap', revenue: 'usRevenue' };
const MIN_RATE = 95;
const MIN_COMPARED = 20;

const matches = (f: Field, got: number, want: number) =>
  f === 'revenue' ? Math.abs(got - want) <= 0.005 * Math.abs(want) : Math.abs(got - want) <= 0.01 + 1e-9;

const expected: Record<string, Expected> = JSON.parse(readFileSync(`${dir}expected.json`, 'utf8'));
const files = readdirSync(dir).filter((f) => f.endsWith('.htm')).sort();

interface Stat { accepted: number; compared: number; matched: number; unverified: number; rate: number | null; gatePasses: boolean }
const stats = Object.fromEntries(FIELDS.map((f) => [f, { accepted: 0, compared: 0, matched: 0, unverified: 0, rate: null, gatePasses: false }])) as Record<Field, Stat>;
const mismatches: Array<{ file: string; field: Field; got: number; expected: number | null; matchesRelease?: boolean; note?: string }> = [];
const perFile: Array<Record<string, unknown>> = [];

for (const file of files) {
  const e = expected[file];
  if (!e) throw new Error(`expected.json has no entry for ${file}`);
  const v = readUsRelease(readFileSync(`${dir}${file}`, 'utf8'), e.quarterEnd);
  perFile.push({ file, symbol: e.symbol, epsAdjusted: v.epsAdjusted, epsGaap: v.epsGaap, revenue: v.revenue, unit: v.unit, notes: v.notes });
  for (const f of FIELDS) {
    const got = v[f];
    if (got === null) continue;
    const s = stats[f];
    s.accepted++;
    s.compared++;
    const want = e[f];
    const note = e.note ? { note: e.note } : {};
    if (want === null) {
      s.unverified++;
      mismatches.push({ file, field: f, got, expected: null, ...note });
    } else if (matches(f, got, want)) {
      s.matched++;
    } else {
      const rel = f === 'epsAdjusted' && e.releaseEpsAdjusted !== undefined ? { matchesRelease: matches(f, got, e.releaseEpsAdjusted) } : {};
      mismatches.push({ file, field: f, got, expected: want, ...rel, ...note });
    }
  }
}
for (const f of FIELDS) {
  const s = stats[f];
  s.rate = s.compared ? Math.round((s.matched / s.compared) * 1000) / 10 : null;
  s.gatePasses = s.rate !== null && s.rate >= MIN_RATE && s.compared >= MIN_COMPARED;
}

console.log(`Corpus: ${files.length} releases (gate: rate >= ${MIN_RATE}% over >= ${MIN_COMPARED} accepted values)`);
console.log('field        accepted  matched  rate    gate            config');
for (const f of FIELDS) {
  const s = stats[f];
  const cfg = config.fastFields[GATE[f]];
  const flag = cfg === s.gatePasses ? '' : '  <-- config disagrees with corpus';
  console.log(`${f.padEnd(12)} ${String(s.accepted).padStart(8)}  ${String(s.matched).padStart(7)}  ${(s.rate === null ? '—' : `${s.rate}%`).padEnd(6)}  ${`${GATE[f]}=${s.gatePasses}`.padEnd(18)} ${cfg}${flag}`);
}
for (const m of mismatches) {
  const rel = m.matchesRelease === undefined ? '' : m.matchesRelease ? ' [matches the release]' : ' [does not match the release either]';
  console.log(`  miss ${m.file} ${m.field}: got ${m.got}, expected ${m.expected}${rel}${m.note ? ` (${m.note})` : ''}`);
}

if (write) {
  writeFileSync(
    `${dir}report.json`,
    JSON.stringify({ files: files.length, tolerance: { eps: 0.01, revenuePct: 0.5 }, gate: { minRate: MIN_RATE, minCompared: MIN_COMPARED }, fields: stats, mismatches, perFile }, null, 2) + '\n',
  );
  console.log(`Wrote ${dir}report.json`);
}
