/**
 * Corpus harness for the US press-release reader.
 *   npm run reader-corpus -w server
 * Reads every test/fixtures/us/releases/*.htm, compares accepted values with
 * expected.json (EPS ±0.01, revenue ±0.5%) and writes report.json next to them.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readUsRelease } from '../sources/releaseReader.js';

const dir = fileURLToPath(new URL('../../test/fixtures/us/releases/', import.meta.url));

interface Expected {
  symbol: string;
  quarterEnd: string;
  epsAdjusted: number | null;
  epsGaap: number | null;
  revenue: number | null;
  note?: string;
}

const FIELDS = ['epsAdjusted', 'epsGaap', 'revenue'] as const;
type Field = (typeof FIELDS)[number];

const matches = (f: Field, got: number, want: number) =>
  f === 'revenue' ? Math.abs(got - want) <= 0.005 * Math.abs(want) : Math.abs(got - want) <= 0.01 + 1e-9;

const expected: Record<string, Expected> = JSON.parse(readFileSync(`${dir}expected.json`, 'utf8'));
const files = readdirSync(dir).filter((f) => f.endsWith('.htm')).sort();

const stats = Object.fromEntries(FIELDS.map((f) => [f, { accepted: 0, compared: 0, matched: 0, unverified: 0, rate: null as number | null }])) as Record<
  Field,
  { accepted: number; compared: number; matched: number; unverified: number; rate: number | null }
>;
const mismatches: Array<{ file: string; field: Field; got: number; expected: number; note?: string }> = [];
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
    const want = e[f];
    if (want === null) { s.unverified++; continue; }
    s.compared++;
    if (matches(f, got, want)) s.matched++;
    else mismatches.push({ file, field: f, got, expected: want, ...(e.note ? { note: e.note } : {}) });
  }
}
for (const f of FIELDS) {
  const s = stats[f];
  s.rate = s.compared ? Math.round((s.matched / s.compared) * 1000) / 10 : null;
}

console.log(`Corpus: ${files.length} releases`);
console.log('field        accepted  compared  matched  rate');
for (const f of FIELDS) {
  const s = stats[f];
  console.log(`${f.padEnd(12)} ${String(s.accepted).padStart(8)}  ${String(s.compared).padStart(8)}  ${String(s.matched).padStart(7)}  ${s.rate === null ? '—' : `${s.rate}%`}`);
}
for (const m of mismatches) console.log(`  mismatch ${m.file} ${m.field}: got ${m.got}, expected ${m.expected}${m.note ? ` (${m.note})` : ''}`);

writeFileSync(
  `${dir}report.json`,
  JSON.stringify({ files: files.length, tolerance: { eps: 0.01, revenuePct: 0.5 }, fields: stats, mismatches, perFile }, null, 2) + '\n',
);
console.log(`Wrote ${dir}report.json`);
