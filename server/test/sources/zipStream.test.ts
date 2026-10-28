import { describe, expect, it } from 'vitest';
import { SourceFormatError } from '../../src/sources/http.js';
import { streamZipEntryText } from '../../src/sources/zip.js';
import { makeZip } from './zipBuilder.js';

async function collect(it: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const c of it) out.push(c);
  return out;
}

describe('streamZipEntryText', () => {
  it('streams a deflated entry in chunks equal to the whole', async () => {
    // Multi-byte characters (ü, €) make chunk edges fall inside UTF-8 sequences.
    const lines: string[] = [];
    for (let i = 0; i < 40_000; i++) lines.push(`<RefData><Id>DE${String(i).padStart(10, '0')}</Id><FullNm>Müller € ${i * 7919}</FullNm></RefData>`);
    const whole = lines.join('\n');
    const zip = makeZip([
      { name: 'other.txt', data: Buffer.from('not wanted', 'utf8') },
      { name: 'FULINS_E_20261024_01of01.xml', data: Buffer.from(whole, 'utf8') },
    ]);
    const chunks = await collect(streamZipEntryText(zip, (n) => n.endsWith('.xml')));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('')).toBe(whole);
  });

  it('a corrupt deflate stream throws SourceFormatError', async () => {
    const zip = makeZip([{ name: 'a.xml', data: Buffer.from('x'.repeat(5000), 'utf8') }]);
    const copy = new Uint8Array(zip);
    // Overwrite the start of the deflated data (after the 30-byte local header and the 5-byte name).
    copy.fill(0xff, 35, 45);
    await expect(collect(streamZipEntryText(copy, () => true))).rejects.toThrow(SourceFormatError);
  });

  it('not a zip throws SourceFormatError', async () => {
    await expect(collect(streamZipEntryText(new Uint8Array(100), () => true))).rejects.toThrow(SourceFormatError);
  });
  it('truncated deflate data with an intact central directory throws SourceFormatError', async () => {
    const zip = makeZip([{ name: 'a.xml', data: Buffer.from('Müller '.repeat(20_000), 'utf8') }]);
    const copy = new Uint8Array(zip);
    const dv = new DataView(copy.buffer);
    // Halve the compressed size in the local header (+18) and the central directory (+20); the data stays in place.
    const comp = dv.getUint32(18, true);
    dv.setUint32(18, Math.floor(comp / 2), true);
    for (let i = 0; i + 4 <= copy.length; i++) if (dv.getUint32(i, true) === 0x02014b50) dv.setUint32(i + 20, Math.floor(comp / 2), true);
    await expect(collect(streamZipEntryText(copy, () => true))).rejects.toThrow(SourceFormatError);
  });
});
