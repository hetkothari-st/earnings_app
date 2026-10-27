import { readFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { HttpError, SourceFormatError } from '../../src/sources/http.js';
import { codeFromSec, fetchEdinetCodeList, isResultsFiling, makeEdinetClient } from '../../src/jp/sources/edinet.js';

const fxPath = (n: string) => new URL(`../fixtures/jp/edinet/${n}`, import.meta.url);
const fxBytes = (n: string) => new Uint8Array(readFileSync(fxPath(n)));

const KEY = 'sekrit-123';

/** A stub fetch that records URLs and answers from `answer`. */
function stub(answer: (url: string) => Response | Promise<Response>) {
  const urls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    return answer(url);
  }) as typeof fetch;
  return { urls, fetchImpl };
}

/** A minimal deflate zip built in the test (test input, not a fixture). */
function makeZip(files: Record<string, string>): Uint8Array<ArrayBuffer> {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, body] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, 'utf8');
    const raw = Buffer.from(body, 'utf8');
    const comp = deflateRawSync(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, comp);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Uint8Array.from(Buffer.concat([...locals, cd, end]));
}

describe('EDINET client', () => {
  it('doc list parsed and filtered to 120/160 listed, unwithdrawn, with XBRL', async () => {
    const body = readFileSync(fxPath('doclist_sample.json'), 'utf8');
    const { urls, fetchImpl } = stub(() => new Response(body, { status: 200 }));
    const client = makeEdinetClient({ key: KEY, fetchImpl, minIntervalMs: 0 });
    const docs = await client.docList('2026-06-25');
    expect(urls).toHaveLength(1);
    expect(urls[0]).toBe(`https://api.edinet-fsa.go.jp/api/v2/documents.json?date=2026-06-25&type=2&Subscription-Key=${KEY}`);
    expect(docs).toHaveLength(7);
    expect(docs[0]).toEqual({
      docID: 'S100Y9NX', edinetCode: 'E02367', secCode: '79740', filerName: '任天堂株式会社', docTypeCode: '120',
      ordinanceCode: '010', periodStart: '2025-04-01', periodEnd: '2026-03-31', submitDateTime: '2026-06-25 15:30',
      withdrawalStatus: '0', xbrlFlag: '1',
    });
    expect(docs[5]!.secCode).toBeNull();
    // Kept: the 有報 (Nintendo) and the alphanumeric-code 半期報告書. Dropped: ordinance 030, amendment 130,
    // withdrawn, no securities code, no XBRL.
    expect(docs.filter(isResultsFiling).map((d) => d.docID)).toEqual(['S100Y9NX', 'S100ZZA1']);
  });

  it('doc list with metadata.status other than 200 throws', async () => {
    const body = JSON.stringify({ metadata: { status: '400', message: 'Bad Request' } });
    const { fetchImpl } = stub(() => new Response(body, { status: 200 }));
    const client = makeEdinetClient({ key: KEY, fetchImpl, minIntervalMs: 0 });
    await expect(client.docList('2026-06-25')).rejects.toBeInstanceOf(SourceFormatError);
  });

  it('secCode 72030 → 7203, 285A0 → 285A, 72031 → null', () => {
    expect(codeFromSec('72030')).toBe('7203');
    expect(codeFromSec('285A0')).toBe('285A');
    expect(codeFromSec('72031')).toBeNull();
    expect(codeFromSec(null)).toBeNull();
    expect(codeFromSec('')).toBeNull();
    expect(codeFromSec('7203')).toBeNull();
    expect(codeFromSec('A2030')).toBeNull();
  });

  it('401 error never contains the key', async () => {
    const body = JSON.stringify({ StatusCode: 401, message: 'Access denied due to invalid subscription key. Make sure to provide a valid key for an active subscription.' });
    const { fetchImpl } = stub(() => new Response(body, { status: 401 }));
    const client = makeEdinetClient({ key: KEY, fetchImpl, minIntervalMs: 0 });
    for (const call of [() => client.docList('2026-06-25'), () => client.xbrlInstance('S100Y9NX')]) {
      const err = await call().then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(HttpError);
      const msg = (err as Error).message;
      expect(msg).toContain('Subscription-Key=***');
      expect(msg).not.toContain(KEY);
      expect(String((err as Error).stack)).not.toContain(KEY);
    }
  });

  it('a network error never contains the key', async () => {
    const { fetchImpl } = stub((url) => { throw new TypeError(`fetch failed for ${url}`); });
    const client = makeEdinetClient({ key: KEY, fetchImpl, minIntervalMs: 0 });
    const err = await client.docList('2026-06-25').then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('Subscription-Key=***');
    expect((err as Error).message).not.toContain(KEY);
    expect(String((err as Error).stack)).not.toContain(KEY);
    expect((err as Error).cause).toBeUndefined();
  });

  it('a 200 answer that is JSON instead of a zip throws without the key', async () => {
    // EDINET answers type=1 errors as JSON with HTTP 200 in some cases.
    const { fetchImpl } = stub(() => new Response(JSON.stringify({ metadata: { status: '404', message: 'Not Found' } }), { status: 200 }));
    const client = makeEdinetClient({ key: KEY, fetchImpl, minIntervalMs: 0 });
    const err = await client.xbrlInstance('S100Y9NX').then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(SourceFormatError);
    expect((err as Error).message).not.toContain(KEY);
  });

  it('zip without a PublicDoc instance throws', async () => {
    const zip = fxBytes('small.zip');
    const { urls, fetchImpl } = stub(() => new Response(zip, { status: 200 }));
    const client = makeEdinetClient({ key: KEY, fetchImpl, minIntervalMs: 0 });
    await expect(client.xbrlInstance('S100Y9NX')).rejects.toBeInstanceOf(SourceFormatError);
    expect(urls[0]).toBe(`https://api.edinet-fsa.go.jp/api/v2/documents/S100Y9NX?type=1&Subscription-Key=${KEY}`);
  });

  it('zip with two PublicDoc instances throws; one instance is decoded, audit files ignored', async () => {
    const two = makeZip({ 'XBRL/PublicDoc/a.xbrl': '<a/>', 'XBRL/PublicDoc/b.xbrl': '<b/>' });
    const c2 = makeEdinetClient({ key: KEY, fetchImpl: stub(() => new Response(two)).fetchImpl, minIntervalMs: 0 });
    await expect(c2.xbrlInstance('S1')).rejects.toBeInstanceOf(SourceFormatError);

    const one = makeZip({
      'XBRL/AuditDoc/jpaud-aar-cn-001_E02367-000_2026-03-31_01_2026-06-25.xbrl': '<audit/>',
      'XBRL/PublicDoc/jpcrp030000-asr-001_E02367-000_2026-03-31_01_2026-06-25.xbrl': '<xbrli:xbrl>任天堂</xbrli:xbrl>',
      'XBRL/PublicDoc/0101010_honbun.htm': '<html/>',
    });
    const c1 = makeEdinetClient({ key: KEY, fetchImpl: stub(() => new Response(one)).fetchImpl, minIntervalMs: 0 });
    expect(await c1.xbrlInstance('S1')).toBe('<xbrli:xbrl>任天堂</xbrli:xbrl>');
  });

  it('code list is decoded from Shift_JIS', async () => {
    const zip = fxBytes('codelist_sjis.zip');
    const { urls, fetchImpl } = stub(() => new Response(zip, { status: 200 }));
    const csv = await fetchEdinetCodeList(fetchImpl);
    expect(urls).toEqual(['https://disclosure2dl.edinet-fsa.go.jp/searchdocument/codelist/Edinetcode.zip']);
    const lines = csv.split(/\r?\n/);
    expect(lines[0]).toMatch(/^ダウンロード実行日,/);
    expect(lines[1]!.startsWith('ＥＤＩＮＥＴコード')).toBe(true);
    expect(lines[1]).toContain('証券コード');
    expect(lines.filter((l) => l.length > 0)).toHaveLength(22);
  });
});
