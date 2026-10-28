import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { SourceFormatError } from '../../src/sources/http.js';
import { untarEntries, untarStream } from '../../src/sources/tar.js';

const fx = (n: string) => new Uint8Array(readFileSync(new URL(`../fixtures/europe/feeds/${n}`, import.meta.url)));
const text = (b: Uint8Array | undefined) => new TextDecoder().decode(b);
const isXml = (n: string) => n.startsWith('xml/') && n.endsWith('.xml');

async function* chunks(buf: Uint8Array, size: number): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, i + size);
}

describe('untarEntries', () => {
  it('reads the DILA sample', () => {
    const gz = fx('dila_sample.tar.gz');
    const xml = untarEntries(gz, isXml);
    expect([...xml.keys()].sort()).toEqual([
      'xml/149/2026/03/MD149622088_20260331.xml',
      'xml/149/2026/03/MD149622089_20260331.xml',
      'xml/MKW/2026/03/MDMKW111969_20260331.xml',
      'xml/MKW/2026/03/MDMKW131969_20260331.xml',
    ]);
    expect(text(xml.get('xml/MKW/2026/03/MDMKW111969_20260331.xml'))).toMatch(/^<\?xml[\s\S]*NANOBIOTIX[\s\S]*<\/UniteInformation>\s*$/);
    // The same reader takes a plain (not gzipped) tar.
    const plain = untarEntries(new Uint8Array(gunzipSync(gz)), isXml);
    expect([...plain.keys()].sort()).toEqual([...xml.keys()].sort());
    // Every regular file is returned when wanted, with its exact size.
    const all = untarEntries(gz, () => true);
    expect(all.size).toBe(8);
    expect(all.get('pdf/149/2026/03/FC149622088_20260331.pdf')!.length).toBe(112359);
  });

  it('streams in small chunks and returns the same entries', async () => {
    const gz = fx('dila_sample_press.tar.gz');
    const seen: string[] = [];
    const streamed = await untarStream(chunks(gz, 997), (n) => (seen.push(n), isXml(n)));
    const whole = untarEntries(gz, isXml);
    expect(streamed.size).toBe(7);
    expect([...streamed.keys()].sort()).toEqual([...whole.keys()].sort());
    for (const [k, v] of whole) expect(text(streamed.get(k))).toBe(text(v));
    // `want` saw the pdf/ entries too (and skipped them).
    expect(seen.filter((n) => n.startsWith('pdf/')).length).toBe(7);
  });

  it('truncated archive throws', async () => {
    const gz = fx('dila_sample.tar.gz');
    const tar = new Uint8Array(gunzipSync(gz));
    expect(() => untarEntries(gz.subarray(0, gz.length >> 1), isXml)).toThrow(SourceFormatError);
    // Cut inside an entry's data, and cut cleanly between entries (no end-of-archive blocks).
    expect(() => untarEntries(tar.subarray(0, 1500), isXml)).toThrow(SourceFormatError);
    expect(() => untarEntries(tar.subarray(0, 512 + 2048), isXml)).toThrow(SourceFormatError);
    await expect(untarStream(chunks(gz.subarray(0, gz.length >> 1), 4096), isXml)).rejects.toThrow(SourceFormatError);
    await expect(untarStream(chunks(tar.subarray(0, 1500), 300), isXml)).rejects.toThrow(SourceFormatError);
    // Garbage is not a tar.
    expect(() => untarEntries(new TextEncoder().encode('<html>not found</html>'.padEnd(1024, ' ')), isXml)).toThrow(SourceFormatError);
  });

  it('a parse or zlib error closes the source (a fetch body is cancelled, not left open)', async () => {
    /** An endless body that records whether it was closed, as a fetch ReadableStream would be cancelled. */
    const body = (first: Uint8Array, filler: Uint8Array) => {
      const s = { pulled: 0, returned: false };
      const iter: AsyncIterableIterator<Uint8Array> = {
        [Symbol.asyncIterator]() { return iter; },
        async next() {
          if (s.returned) return { done: true, value: undefined };
          return { done: false, value: s.pulled++ === 0 ? first : filler };
        },
        async return() { s.returned = true; return { done: true, value: undefined }; },
      };
      return { s, iter };
    };
    // Plain tar path: the first header fails its checksum.
    const html = body(new TextEncoder().encode('<html>not found</html>'.padEnd(1024, ' ')), new Uint8Array(4096));
    await expect(untarStream(html.iter, isXml)).rejects.toThrow(SourceFormatError);
    expect(html.s.returned).toBe(true);
    // Gzip path: a valid gzip header followed by bytes that do not inflate.
    const gz = fx('dila_sample.tar.gz');
    const bad = new Uint8Array(gz.subarray(0, 2000));
    bad.fill(0xff, 20);
    const zl = body(bad, new Uint8Array(4096).fill(0xff));
    await expect(untarStream(zl.iter, isXml)).rejects.toThrow(SourceFormatError);
    expect(zl.s.returned).toBe(true);
    expect(zl.s.pulled).toBeLessThan(1000);
  });
});
