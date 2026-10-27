import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { SourceFormatError } from '../../src/sources/http.js';
import { JP_FULL, JP_INDICES, buildJpUniverse, jpLevel, parseEdinetCodeList, yahooJpSymbol } from '../../src/jp/universe.js';

const csv = readFileSync(new URL('../fixtures/jp/codelist_rows.csv', import.meta.url), 'utf8');
const lines = csv.split('\n').filter(Boolean);
const rowOf = (code5: string) => lines.slice(2).find((l) => l.includes(`"${code5}"`))!;
const withExtra = (...rows: string[]) => [lines[0], lines[1], ...rows].join('\n') + '\n';

describe('parseEdinetCodeList', () => {
  const all = parseEdinetCodeList(csv);
  const by = (code: string) => all.find((e) => e.code === code);

  it('listed rows with codes only; codes 4 chars; alphanumeric kept; non-0 fifth char dropped', () => {
    expect(by('7203')).toBeTruthy();
    expect(by('8306')).toBeTruthy();
    expect(by('8604')).toBeTruthy();
    expect(by('409A')).toBeTruthy(); // 409A0
    expect(by('250A')).toBeTruthy();
    expect(all.every((e) => /^[0-9][0-9A-Z]{3}$/.test(e.code))).toBe(true);
    // 非上場 rows (72400 NOK, 37870) and the listed row without a securities code are skipped.
    expect(by('7240')).toBeUndefined();
    expect(by('3787')).toBeUndefined();
    expect(all.length).toBe(lines.length - 2 - 3);
    const base = rowOf('72030');
    const odd = base.replace('"72030"', '"72031"');
    expect(parseEdinetCodeList(withExtra(base, odd)).map((e) => e.code)).toEqual(['7203']);
  });

  it('English name preferred, Japanese when empty; quoted comma survives', () => {
    expect(by('7203')).toMatchObject({ name: 'TOYOTA MOTOR CORPORATION', nameJa: 'トヨタ自動車株式会社', edinetCode: 'E02144', industryJa: '輸送用機器' });
    expect(by('1333')).toMatchObject({ name: 'Ｕｍｉｏｓ株式会社', nameJa: 'Ｕｍｉｏｓ株式会社' });
    expect(by('1376')!.name).toBe('KANEKO SEEDS CO., LTD.');
    expect(by('8604')!.name).toBe('Nomura Holdings, Inc.');
  });

  it('fyEndMonth from 決算日; unparseable → null', () => {
    expect(by('7203')!.fyEndMonth).toBe(3);
    expect(by('1376')!.fyEndMonth).toBe(5);
    expect(by('2292')!.fyEndMonth).toBe(2); // "2月末日"
    const bad = rowOf('72030').replace('"3月31日"', '"不明"');
    expect(parseEdinetCodeList(withExtra(bad))[0]).toMatchObject({ code: '7203', fyEndMonth: null });
    const blank = rowOf('72030').replace('"3月31日"', '""');
    expect(parseEdinetCodeList(withExtra(blank))[0]!.fyEndMonth).toBeNull();
  });

  it('header mismatch throws', () => {
    const changed = csv.replace('提出者業種', '業種');
    expect(() => parseEdinetCodeList(changed)).toThrow(SourceFormatError);
    expect(() => parseEdinetCodeList('')).toThrow(SourceFormatError);
  });

  it('new listed entries start basic', () => {
    expect(by('7203')).toMatchObject({ adr: null, adrRatio: null, cik: null });
  });
});

describe('buildJpUniverse', () => {
  it('full level overrides: 7203 is full with TM, ratio 10', () => {
    const u = buildJpUniverse(parseEdinetCodeList(csv));
    const toyota = u.find((e) => e.code === '7203')!;
    expect(toyota).toMatchObject({ adr: 'TM', adrRatio: 10, name: 'TOYOTA MOTOR CORPORATION', fyEndMonth: 3 });
    expect(toyota.cik).toBeGreaterThan(0);
    expect(jpLevel(toyota)).toBe('full');
    expect(jpLevel(u.find((e) => e.code === '409A')!)).toBe('basic');
  });

  it('a full code missing from the code list is appended with name = adr', () => {
    const u = buildJpUniverse([], [{ code: '9999', adr: 'ZZ', adrRatio: 2, cik: 5 }]);
    expect(u).toEqual([expect.objectContaining({ code: '9999', name: 'ZZ', adr: 'ZZ', adrRatio: 2, cik: 5, fyEndMonth: null })]);
  });

  it('exactly 8 full-level entries, codes unique', () => {
    expect(JP_FULL).toHaveLength(8);
    expect(new Set(JP_FULL.map((e) => e.code)).size).toBe(8);
    expect(new Set(JP_FULL.map((e) => e.adr)).size).toBe(8);
    const u = buildJpUniverse([]);
    expect(u.filter((e) => jpLevel(e) === 'full')).toHaveLength(8);
  });
});

describe('symbols', () => {
  it('yahooJpSymbol(285A) === 285A.T', () => {
    expect(yahooJpSymbol('285A')).toBe('285A.T');
    expect(yahooJpSymbol('7203')).toBe('7203.T');
  });
  it('indices', () => {
    expect(JP_INDICES.map((i) => i.yahoo)).toEqual(['^N225', '1306.T']);
  });
});
