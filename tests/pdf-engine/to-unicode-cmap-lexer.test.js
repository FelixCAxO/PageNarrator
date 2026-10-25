import { describe, expect, it, vi } from 'vitest';
import { NativePdfReader } from '../../src/pdf/native-reader.js';
import { readToUnicode, unicodeText } from '../../src/pdf/fonts.js';
import { parseCmapData } from '../../src/pdf/cmap-data.js';
import { readToUnicodeValues } from '../../src/pdf/cmap-lexer.js';
import { bytes, simplePdf, stream, options } from './fixtures.js';

async function mapping(source, inspect) {
  const reader = await NativePdfReader.create(simplePdf('', { extra: [stream(source)] }), options);
  const nativeContent = vi.spyOn(reader, 'content');
  try {
    const result = await readToUnicode(reader, reader.checked(reader.api.pn_pdf_resolve(6, 0)));
    expect(nativeContent).not.toHaveBeenCalled(); expect(reader.temporary.size).toBe(0);
    if (inspect) inspect(result);
    return result;
  } finally { reader.destroy(); }
}
const body = rows => `begincmap ${rows} endcmap`;

describe('inert ToUnicode CMap lexical values', () => {
  it.each([
    '/CIDSystemInfo 3 dict dup begin /Registry (Original) def /Ordering (Test) def /Supplement 0 def end def',
    '/CIDSystemInfo << /Registry (Original) /Ordering (Test) /Supplement 0 >> def',
    '/CIDSystemInfo << /Registry (Original) def /Ordering (Test) def /Supplement 0 def >> def',
  ])('reads declared mappings independently of inert metadata: %s', async metadata => {
    const result = await mapping(body(`${metadata} 1 beginbfrange <20> <23> <0020> endbfrange`));
    expect([...result]).toEqual([['20', ' '], ['21', '!'], ['22', '"'], ['23', '#']]);
  });

  it('isolates mapping-like comments, literal names, escaped strings, arrays and dictionaries', async () => {
    const decoy = '1 beginbfchar <41> <0058> endbfchar';
    const source = body(`% ${decoy}\n /beginbfchar /endbfchar /Header (nested \\( ${decoy} \\) (still inert)) def /Array [${decoy}] def /Dictionary << /Value [${decoy}] /Other (${decoy}) >> def 1 beginbfchar <41> <0041> endbfchar`);
    expect([...(await mapping(source))]).toEqual([['41', 'A']]);
  });

  it('accepts an empty CMapName without changing explicit mappings or executing literal names', async () => {
    const result = await mapping(body('/CMapName / def /Other /beginbfchar def /Escaped /begin#62fchar def 1 beginbfchar <41> <03a9> endbfchar'));
    expect([...result]).toEqual([['41', 'Ω']]);
    const tokens = readToUnicodeValues(bytes('/ /\n/\u0000/% comment\n/[] /<<>> /<0041> /(inert) /'));
    expect(tokens.filter(token => token.kind === 'name').map(token => token.value)).toEqual(Array(9).fill(''));
    expect(readToUnicodeValues(bytes('/9999999999999999')).map(token => [token.kind, token.value])).toEqual([['name', '9999999999999999']]);
    expect(() => parseCmapData(bytes(body('/CMapName / def')))).toThrow(/Invalid CMap token/);
  });

  it('preserves raw high bytes and escaped octets without Windows-1252 re-encoding', async () => {
    const raw = String.fromCharCode(0, 0x80, 0, 0x9f);
    const result = await mapping(body(`4 beginbfchar <41> (${raw}) <42> (\\000\\200\\000\\237) <43> (\u0000\\${String.fromCharCode(0x80)}) <44> <0080009f> endbfchar`));
    expect([...result.values()]).toEqual(['\u0080\u009f', '\u0080\u009f', '\u0080', '\u0080\u009f']);
  });

  it('matches native literal escapes, nested delimiters, line endings and continuation bytes', async () => {
    const result = await mapping(body('5 beginbfchar <41> (\\000\\n) <42> (\u0000\r\n) <43> (\u0000\r) <44> (\\000\\\r\nA) <45> (\\000\\(\\000\\)) endbfchar'));
    expect([...result.values()]).toEqual(['\n', '\n', '\n', 'A', '()']);
    const values = readToUnicodeValues(bytes('(a(b)c) (a\\)b)'));
    expect(values.map(value => [...value.bytes])).toEqual([[97, 40, 98, 41, 99], [97, 41, 98]]);
  });

  it('keeps empty mappings, BOM removal, surrogate pairs and hexadecimal odd nibbles', async () => {
    const result = await mapping(body('4 beginbfchar <41> <> <42> <feff00660069> <43> <d83dde00> <44> <004> endbfchar'));
    expect([...result.values()]).toEqual(['', 'fi', '😀', '@']);
  });

  it('recognizes NUL whitespace without treating high-byte whitespace as a separator', async () => {
    expect([...(await mapping(body('1\u0000beginbfchar\u0000<41>\u0000<0041>\u0000endbfchar')))]).toEqual([['41', 'A']]);
    await expect(mapping(body('1\u00a0beginbfchar <41> <0041> endbfchar'))).rejects.toMatchObject({ code: 'pdf_corrupt' });
  });

  it('keeps range arrays and used-only errors for nonstring, odd-byte and invalid-surrogate targets', async () => {
    await mapping(body('1 beginbfrange <41> <45> [<0058> 42 <41> <d800> << /Value <0045> >>] endbfrange'), result => {
      expect(unicodeText(result, '41')).toBe('X');
      for (const code of ['42', '43', '44', '45']) expect(() => unicodeText(result, code)).toThrow();
    });
  });

  it('preserves multi-unit increment carries, overflow errors and later valid overwrites', async () => {
    await mapping(body('1 beginbfrange <41> <42> <006600ff> endbfrange 1 beginbfrange <43> <44> <ffff> endbfrange 1 beginbfchar <44> <0044> endbfchar'), result => {
      expect(unicodeText(result, '41')).toBe('fÿ'); expect(unicodeText(result, '42')).toBe('fĀ');
      expect(unicodeText(result, '43')).toBe('\uffff'); expect(unicodeText(result, '44')).toBe('D');
      expect(result.invalidCodes.size).toBe(0);
    });
    await mapping(body('1 beginbfrange <41> <42> <ffff> endbfrange'), result => expect(() => unicodeText(result, '42')).toThrow(/overflows/));
  });

  it.each([
    '1 beginbfchar <41> <0041> endbfrange',
    '2 beginbfchar <41> <0041> endbfchar',
    '-1 beginbfchar endbfchar',
    '.5 beginbfchar endbfchar',
    '1 beginbfchar <41> << /Target <0041> >> endbfchar',
    '1 beginbfrange <41> <42> [<0041>] endbfrange',
    '1 beginbfrange <42> <41> <0041> endbfrange',
    '1 beginbfchar <41> <00xz> endbfchar',
    '/Header (unterminated', '/Header (truncated\\',
    '/Header << /Value [1 2 >> ]', '/Header [1 2',
    '{ 1 beginbfchar <41> <0041> endbfchar }',
  ])('rejects malformed or executable syntax without native recovery: %s', async source => {
    await expect(mapping(body(source))).rejects.toMatchObject({ code: expect.stringMatching(/^pdf_(corrupt|limit)$/) });
  });

  it('retains explicit bounded source, token, container and literal admission', () => {
    expect(() => readToUnicodeValues(new Uint8Array(32 * 1024 * 1024 + 1))).toThrow(/32 MiB/);
    expect(() => readToUnicodeValues(bytes('x '.repeat(1000001)))).toThrow(/token budget/);
    expect(() => readToUnicodeValues(bytes(`[${'x '.repeat(100001)}]`))).toThrow(/container entry/);
    expect(() => readToUnicodeValues(bytes('['.repeat(65) + ']'.repeat(65)))).toThrow(/container depth/);
    expect(() => readToUnicodeValues(bytes('('.repeat(65) + ')'.repeat(65)))).toThrow(/literal exceeds/);
    expect(() => readToUnicodeValues(bytes(`(${'x'.repeat(16 * 1024 * 1024 + 1)})`))).toThrow(/16 MiB/);
    expect(() => readToUnicodeValues(bytes('1'.repeat(100000) + 'x'))).toThrow(/Invalid CMap number/);
    expect(() => readToUnicodeValues(bytes('1000000000000001'))).toThrow(/number exceeds/);
    expect(readToUnicodeValues(bytes('1. +1.0 -.5')).map(value => value.value)).toEqual([1, 1, -.5]);
    expect(readToUnicodeValues(bytes('['.repeat(64) + ']'.repeat(64)))).toHaveLength(1);
  });

  it('preserves the smaller predefined/CID CMap defaults', () => {
    expect(() => parseCmapData(new Uint8Array(2 * 1024 * 1024 + 1))).toThrow(/2 MiB/);
    expect(() => parseCmapData(bytes(body(`/Header (${'a'.repeat(4097)}) def`)))).toThrow(/literal exceeds/);
    expect(() => parseCmapData(bytes(body(`1 beginbfchar <41> <${'0041'.repeat(33)}> endbfchar`)))).toThrow(/hexadecimal/);
  });
});
