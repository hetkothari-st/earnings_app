import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { parseFilingDocs } from '../../src/sources/secFeed.js';
import { classifySixK, pickReleaseDoc, type SixKExhibit } from '../../src/sources/sixKClassify.js';

/**
 * Real 6-Ks of the 8 full-level Japanese filers (EDGAR, saved by the Task 2 review on 2026-10-27, gzipped as
 * fetched). Every results release they filed from 2026-03-01 is here, plus date notices and non-results filings that
 * look like results (statutory statements, forecast revisions, "difference in results" notices, appendices).
 * `filedOn` is the EDGAR filing date. `picked: false` marks a document the release-doc picker does not choose
 * (Takeda files its tanshin as the 6-K itself and a financial appendix as EX-99.1); it is classified directly.
 */
interface Entry {
  co: string; cik: number; acc: string; doc: string; filedOn: string; title: string; picked?: false; expect: SixKExhibit;
}

const dir = new URL('../fixtures/jp/corpus/', import.meta.url);
const gz = (name: string) => gunzipSync(readFileSync(new URL(name, dir))).toString('utf8');
const manifest = JSON.parse(readFileSync(new URL('manifest.json', dir), 'utf8')) as Entry[];

describe("classifySixK 'jp' over the real corpus", () => {
  it('covers all 8 filers and at least 20 filings', () => {
    expect(new Set(manifest.map((e) => e.co)).size).toBe(8);
    expect(manifest.length).toBeGreaterThanOrEqual(20);
  });

  it.each(manifest.map((e) => [`${e.co} ${e.acc} ${e.doc}: ${e.title}`, e] as const))('%s', (_, e) => {
    const base = `https://www.sec.gov/Archives/edgar/data/${e.cik}/${e.acc.replace(/-/g, '')}/`;
    if (e.picked !== false) {
      const docs = parseFilingDocs(gz(`${e.acc}_index.htm.gz`), `${base}${e.acc}-index.htm`);
      expect(pickReleaseDoc(docs)).toBe(base + e.doc);
    }
    expect(classifySixK(gz(`${e.acc}_${e.doc}.gz`), { filedOn: e.filedOn, profile: 'jp' })).toEqual(e.expect);
  });
});
