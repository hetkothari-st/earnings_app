import { Readable } from 'node:stream';
import { createInflateRaw, inflateRawSync } from 'node:zlib';
import { SourceFormatError } from './http.js';

interface ZipEntry {
  name: string;
  flags: number;
  method: number;
  compSize: number;
  size: number;
  localOffset: number;
}

/** The central directory's entries (directories included), after the archive-level checks. */
function centralDirectory(buf: Uint8Array): ZipEntry[] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const u16 = (o: number) => dv.getUint16(o, true);
  const u32 = (o: number) => dv.getUint32(o, true);

  // End of central directory: 22 bytes plus an optional comment of up to 65535 bytes.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 0xffff; i--) {
    if (u32(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new SourceFormatError('zip: no end-of-central-directory record');
  if (eocd >= 20 && u32(eocd - 20) === 0x07064b50) throw new SourceFormatError('zip: zip64 is not supported');

  const count = u16(eocd + 10);
  const cdSize = u32(eocd + 12);
  const cdOffset = u32(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new SourceFormatError('zip: zip64 is not supported');
  }
  if (cdOffset + cdSize > eocd) throw new SourceFormatError('zip: central directory out of range');

  const entries: ZipEntry[] = [];
  const utf8 = new TextDecoder('utf-8');
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > eocd || u32(p) !== 0x02014b50) throw new SourceFormatError('zip: bad central directory entry');
    const nameLen = u16(p + 28);
    entries.push({
      name: utf8.decode(buf.subarray(p + 46, p + 46 + nameLen)),
      flags: u16(p + 8),
      method: u16(p + 10),
      compSize: u32(p + 20),
      size: u32(p + 24),
      localOffset: u32(p + 42),
    });
    p += 46 + nameLen + u16(p + 30) + u16(p + 32);
  }
  return entries;
}

/** The entry's compressed bytes, after the per-entry checks (zip64, encryption, method, local header, range). */
function rawEntry(buf: Uint8Array, e: ZipEntry): Uint8Array {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const { name } = e;
  if (e.compSize === 0xffffffff || e.size === 0xffffffff || e.localOffset === 0xffffffff) {
    throw new SourceFormatError(`zip: zip64 entry ${name} is not supported`);
  }
  if (e.flags & 0x1) throw new SourceFormatError(`zip: encrypted entry ${name}`);
  if (e.method !== 0 && e.method !== 8) throw new SourceFormatError(`zip: compression method ${e.method} of ${name} is not supported`);
  if (e.localOffset + 30 > buf.length || dv.getUint32(e.localOffset, true) !== 0x04034b50) {
    throw new SourceFormatError(`zip: bad local header for ${name}`);
  }
  const start = e.localOffset + 30 + dv.getUint16(e.localOffset + 26, true) + dv.getUint16(e.localOffset + 28, true);
  if (start + e.compSize > buf.length) throw new SourceFormatError(`zip: entry ${name} out of range`);
  return buf.subarray(start, start + e.compSize);
}

/**
 * A small zip reader for the archives EDINET serves (document ZIPs and the code list). It reads the
 * central directory and supports only stored (0) and deflated (8) entries. Zip64, encrypted entries
 * and any other compression method throw `SourceFormatError`, as does anything that is not a zip.
 *
 * Returns the entries whose name passes `want`, keyed by their full path inside the archive.
 */
export function unzipEntries(buf: Uint8Array, want: (name: string) => boolean): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  for (const e of centralDirectory(buf)) {
    if (e.name.endsWith('/') || !want(e.name)) continue;
    const raw = rawEntry(buf, e);
    let data: Uint8Array;
    try {
      // maxOutputLength: a hostile entry cannot inflate past its declared size (zlib throws instead).
      data = e.method === 0 ? raw.slice() : new Uint8Array(inflateRawSync(raw, { maxOutputLength: Math.max(e.size, 1) }));
    } catch {
      throw new SourceFormatError(`zip: entry ${e.name} does not inflate`);
    }
    if (data.length !== e.size) throw new SourceFormatError(`zip: entry ${e.name} has the wrong size`);
    out.set(e.name, data);
  }
  return out;
}

/**
 * Streams the wanted entries' text (UTF-8) in chunks, one entry after another, without holding an inflated entry
 * in memory: FIRDS parts are ~40 MB zipped but ~0.9 GB of XML (Task 1). The zip itself is held in memory (it is
 * small enough); only the inflated text is streamed. Deflated (8) entries go through `zlib.createInflateRaw`;
 * stored (0) entries are decoded in slices. The same checks as `unzipEntries` apply; an entry that does not inflate,
 * or inflates to a size other than the declared one, throws `SourceFormatError` (chunks already yielded stand).
 */
export async function* streamZipEntryText(buf: Uint8Array, want: (name: string) => boolean): AsyncIterable<string> {
  const CHUNK = 256 * 1024;
  for (const e of centralDirectory(buf)) {
    if (e.name.endsWith('/') || !want(e.name)) continue;
    const raw = rawEntry(buf, e);
    const decoder = new TextDecoder('utf-8');
    let total = 0;
    if (e.method === 0) {
      for (let o = 0; o < raw.length; o += CHUNK) {
        const text = decoder.decode(raw.subarray(o, o + CHUNK), { stream: true });
        if (text) yield text;
      }
      total = raw.length;
    } else {
      const inflater = createInflateRaw({ chunkSize: CHUNK });
      Readable.from([Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)]).pipe(inflater);
      try {
        for await (const chunk of inflater as AsyncIterable<Buffer>) {
          total += chunk.length;
          if (total > e.size) throw new SourceFormatError(`zip: entry ${e.name} has the wrong size`);
          const text = decoder.decode(chunk, { stream: true });
          if (text) yield text;
        }
      } catch (err) {
        inflater.destroy();
        if (err instanceof SourceFormatError) throw err;
        throw new SourceFormatError(`zip: entry ${e.name} does not inflate`);
      }
    }
    if (total !== e.size) throw new SourceFormatError(`zip: entry ${e.name} has the wrong size`);
    const tail = decoder.decode();
    if (tail) yield tail;
  }
}
