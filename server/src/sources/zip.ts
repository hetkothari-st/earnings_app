import { inflateRawSync } from 'node:zlib';
import { SourceFormatError } from './http.js';

/**
 * A small zip reader for the archives EDINET serves (document ZIPs and the code list). It reads the
 * central directory and supports only stored (0) and deflated (8) entries. Zip64, encrypted entries
 * and any other compression method throw `SourceFormatError`, as does anything that is not a zip.
 *
 * Returns the entries whose name passes `want`, keyed by their full path inside the archive.
 */
export function unzipEntries(buf: Uint8Array, want: (name: string) => boolean): Map<string, Uint8Array> {
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

  const out = new Map<string, Uint8Array>();
  const utf8 = new TextDecoder('utf-8');
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > eocd || u32(p) !== 0x02014b50) throw new SourceFormatError('zip: bad central directory entry');
    const flags = u16(p + 8);
    const method = u16(p + 10);
    const compSize = u32(p + 20);
    const size = u32(p + 24);
    const nameLen = u16(p + 28);
    const extraLen = u16(p + 30);
    const commentLen = u16(p + 32);
    const localOffset = u32(p + 42);
    const name = utf8.decode(buf.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/') || !want(name)) continue;
    if (compSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) {
      throw new SourceFormatError(`zip: zip64 entry ${name} is not supported`);
    }
    if (flags & 0x1) throw new SourceFormatError(`zip: encrypted entry ${name}`);
    if (method !== 0 && method !== 8) throw new SourceFormatError(`zip: compression method ${method} of ${name} is not supported`);

    if (localOffset + 30 > buf.length || u32(localOffset) !== 0x04034b50) {
      throw new SourceFormatError(`zip: bad local header for ${name}`);
    }
    const start = localOffset + 30 + u16(localOffset + 26) + u16(localOffset + 28);
    if (start + compSize > buf.length) throw new SourceFormatError(`zip: entry ${name} out of range`);
    const raw = buf.subarray(start, start + compSize);
    let data: Uint8Array;
    try {
      data = method === 0 ? raw.slice() : new Uint8Array(inflateRawSync(raw));
    } catch {
      throw new SourceFormatError(`zip: entry ${name} does not inflate`);
    }
    if (data.length !== size) throw new SourceFormatError(`zip: entry ${name} has the wrong size`);
    out.set(name, data);
  }
  return out;
}
