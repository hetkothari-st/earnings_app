import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SourceFormatError } from '../../src/sources/http.js';
import { unzipEntries } from '../../src/sources/zip.js';

const fx = (n: string) => new Uint8Array(readFileSync(new URL(`../fixtures/jp/edinet/${n}`, import.meta.url)));
const text = (b: Uint8Array | undefined) => new TextDecoder().decode(b);

describe('unzipEntries', () => {
  it('reads deflated entries', () => {
    const all = unzipEntries(fx('small.zip'), () => true);
    expect([...all.keys()].sort()).toEqual(['a.txt', 'b.txt']);
    expect(text(all.get('a.txt'))).toBe('hello edinet\n');
    expect(text(all.get('b.txt'))).toBe('second file, deflated by Compress-Archive. second file, deflated by Compress-Archive.\n');
    // Only the wanted entries are inflated and returned.
    const one = unzipEntries(fx('small.zip'), (n) => n === 'b.txt');
    expect([...one.keys()]).toEqual(['b.txt']);
  });

  it('unsupported method throws', () => {
    const buf = fx('small.zip');
    // Flip the compression method of every central-directory entry (signature PK\1\2, method at +10) to 12 (bzip2).
    const copy = new Uint8Array(buf);
    const dv = new DataView(copy.buffer);
    for (let i = 0; i + 4 <= copy.length; i++) {
      if (dv.getUint32(i, true) === 0x02014b50) dv.setUint16(i + 10, 12, true);
    }
    expect(() => unzipEntries(copy, () => true)).toThrow(SourceFormatError);
  });

  it('a buffer that is not a zip throws', () => {
    expect(() => unzipEntries(new TextEncoder().encode('<html>not a zip</html>'), () => true)).toThrow(SourceFormatError);
  });
});
