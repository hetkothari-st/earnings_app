import { gunzipSync, createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { SourceFormatError } from './http.js';

/**
 * A small tar reader for the archives DILA serves (amf-gz_*.tar.gz). It understands ustar headers, GNU long
 * names ('L') and pax 'path' records ('x'); it returns regular files only. Gzip is detected by the magic bytes
 * 1f 8b, so a plain tar works too.
 *
 * Entries whose name fails `want` are skipped as their bytes pass: they are never buffered. A DILA results-season
 * batch is 200-660 MB of gzip, almost all PDFs, so the network path uses `untarStream`, which never holds more
 * than one wanted entry plus one chunk. `untarEntries` takes a whole buffer (fixtures, small batches).
 *
 * An archive that ends before its end-of-archive block (truncated download), a bad header checksum, or gzip that
 * does not inflate throws `SourceFormatError`.
 */
export function untarEntries(buf: Uint8Array, want: (name: string) => boolean): Map<string, Uint8Array> {
  let tar = buf;
  if (isGzip(buf)) {
    try {
      tar = new Uint8Array(gunzipSync(buf));
    } catch {
      throw new SourceFormatError('tar: gzip does not inflate (truncated?)');
    }
  }
  const r = new TarReader(want);
  r.push(tar);
  return r.finish();
}

/** The streaming form of `untarEntries`: `source` is any byte stream (a fetch body, a file stream, chunks). */
export async function untarStream(
  source: AsyncIterable<Uint8Array>,
  want: (name: string) => boolean,
): Promise<Map<string, Uint8Array>> {
  const it = source[Symbol.asyncIterator]();
  const state = { exhausted: false };
  try {
    return await readAll(it, new TarReader(want), state);
  } finally {
    // After a parse or zlib error the body is not read to the end: close it, so a fetch body is cancelled.
    if (!state.exhausted) await it.return?.().catch(() => undefined);
  }
}

async function readAll(
  it: AsyncIterator<Uint8Array>,
  r: TarReader,
  state: { exhausted: boolean },
): Promise<Map<string, Uint8Array>> {
  // Peek enough bytes to see the gzip magic.
  const head: Uint8Array[] = [];
  let headLen = 0;
  let done = false;
  while (headLen < 2) {
    const n = await it.next();
    if (n.done) { done = state.exhausted = true; break; }
    head.push(n.value);
    headLen += n.value.length;
  }
  async function* all(): AsyncGenerator<Uint8Array> {
    yield* head;
    if (done) return;
    for (let n = await it.next(); !n.done; n = await it.next()) yield n.value;
    state.exhausted = true;
  }
  const first = concat(head);
  if (isGzip(first)) {
    try {
      await pipeline(all(), createGunzip(), async (out: AsyncIterable<Buffer>) => {
        for await (const c of out) r.push(c);
      });
    } catch (e) {
      // zlib errors (Z_BUF_ERROR for a cut stream, Z_DATA_ERROR for garbage) are format errors; others propagate.
      const code = (e as { code?: unknown }).code;
      if (typeof code === 'string' && code.startsWith('Z_')) throw new SourceFormatError('tar: gzip does not inflate (truncated?)');
      throw e;
    }
  } else {
    for await (const c of all()) r.push(c);
  }
  return r.finish();
}

const isGzip = (b: Uint8Array): boolean => b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b;

function concat(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0]!;
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

const BLOCK = 512;
/** A wanted entry or a long-name/pax record larger than this is not a DILA archive. */
const MAX_WANTED = 64 * 1024 * 1024;
const MAX_META = 1024 * 1024;

type EntryKind = 'file' | 'longname' | 'pax' | 'skip';

/** Incremental ustar parser: feed it bytes in any chunking, then call finish(). */
class TarReader {
  private readonly out = new Map<string, Uint8Array>();
  private readonly header = new Uint8Array(BLOCK);
  private headerFill = 0;
  private state: 'header' | 'data' | 'pad' | 'end' = 'header';
  private remaining = 0;
  private padRemaining = 0;
  private kind: EntryKind = 'skip';
  private name = '';
  private collect: Uint8Array | null = null;
  private collected = 0;
  private nextName: string | null = null; // from a GNU 'L' or pax 'x' record, applies to the next entry

  constructor(private readonly want: (name: string) => boolean) {}

  push(chunk: Uint8Array): void {
    let p = 0;
    while (p < chunk.length && this.state !== 'end') {
      if (this.state === 'header') {
        const n = Math.min(BLOCK - this.headerFill, chunk.length - p);
        this.header.set(chunk.subarray(p, p + n), this.headerFill);
        this.headerFill += n;
        p += n;
        if (this.headerFill === BLOCK) {
          this.headerFill = 0;
          this.onHeader();
        }
      } else if (this.state === 'data') {
        const n = Math.min(this.remaining, chunk.length - p);
        if (this.collect) this.collect.set(chunk.subarray(p, p + n), this.collected);
        this.collected += n;
        this.remaining -= n;
        p += n;
        if (this.remaining === 0) this.onEntryEnd();
      } else {
        const n = Math.min(this.padRemaining, chunk.length - p);
        this.padRemaining -= n;
        p += n;
        if (this.padRemaining === 0) this.state = 'header';
      }
    }
  }

  finish(): Map<string, Uint8Array> {
    // Only an end-of-archive (zero) block proves the archive is whole: a cut between entries looks clean otherwise.
    if (this.state !== 'end') throw new SourceFormatError('tar: archive is truncated');
    return this.out;
  }

  private onHeader(): void {
    const h = this.header;
    if (h.every((b) => b === 0)) {
      this.state = 'end'; // what follows is the second zero block and record padding
      return;
    }
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i]!;
    if (sum !== octal(h, 148, 8)) throw new SourceFormatError('tar: bad header checksum (not a tar?)');

    const size = sizeField(h);
    const type = String.fromCharCode(h[156]!);
    const ustarPosix = ascii(h, 257, 6) === 'ustar\0';
    let name = cstr(h, 0, 100);
    if (ustarPosix) {
      const prefix = cstr(h, 345, 155);
      if (prefix) name = `${prefix}/${name}`;
    }
    if (this.nextName !== null && type !== 'L' && type !== 'x') {
      name = this.nextName;
      this.nextName = null;
    }

    let kind: EntryKind = 'skip';
    if (type === 'L') kind = 'longname';
    else if (type === 'x') kind = 'pax';
    else if ((type === '0' || type === '\0' || type === '7') && !name.endsWith('/') && this.want(name)) kind = 'file';

    const cap = kind === 'file' ? MAX_WANTED : MAX_META;
    if (kind !== 'skip' && size > cap) throw new SourceFormatError(`tar: entry ${name} is too large (${size} bytes)`);
    this.kind = kind;
    this.name = name;
    this.collect = kind === 'skip' ? null : new Uint8Array(size);
    this.collected = 0;
    this.remaining = size;
    this.padRemaining = (BLOCK - (size % BLOCK)) % BLOCK;
    if (size === 0) this.onEntryEnd();
    else this.state = 'data';
  }

  private onEntryEnd(): void {
    const data = this.collect;
    if (data && this.kind === 'file') this.out.set(this.name, data);
    else if (data && this.kind === 'longname') this.nextName = cstr(data, 0, data.length);
    else if (data && this.kind === 'pax') {
      const path = paxPath(new TextDecoder('utf-8').decode(data));
      if (path !== null) this.nextName = path;
    }
    this.collect = null;
    this.state = this.padRemaining > 0 ? 'pad' : 'header';
  }
}

function ascii(b: Uint8Array, off: number, len: number): string {
  return String.fromCharCode(...b.subarray(off, off + len));
}

/** A NUL-terminated UTF-8 string field. */
function cstr(b: Uint8Array, off: number, len: number): string {
  const f = b.subarray(off, off + len);
  const z = f.indexOf(0);
  return new TextDecoder('utf-8').decode(z < 0 ? f : f.subarray(0, z));
}

function octal(b: Uint8Array, off: number, len: number): number {
  const s = ascii(b, off, len).replace(/\0.*$/s, '').trim();
  if (!/^[0-7]+$/.test(s)) throw new SourceFormatError('tar: bad numeric header field (not a tar?)');
  return parseInt(s, 8);
}

/** The size field: octal, or GNU base-256 when the high bit of its first byte is set. */
function sizeField(h: Uint8Array): number {
  if (h[124]! & 0x80) {
    let v = h[124]! & 0x7f;
    for (let i = 125; i < 136; i++) v = v * 256 + h[i]!;
    return v;
  }
  return octal(h, 124, 12);
}

/** The "path" key of a pax extended header ("<len> path=<value>\n" records). */
function paxPath(s: string): string | null {
  for (const m of s.matchAll(/^\d+ ([^=\n]+)=(.*)$/gm)) if (m[1] === 'path') return m[2]!;
  return null;
}
