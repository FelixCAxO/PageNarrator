import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import * as reference from 'pdfjs-dist/legacy/build/pdf.mjs';
import { NativePdfReader } from '../../src/pdf/native-reader.js';
import { decodeLzw, decodeFax } from '../../src/pdf/streams.js';
import { createPdfDocumentCore } from '../../src/pdf/document-core.js';
import { openPdfDocument } from '../../src/pdf/browser-pdf.js';
import { simplePdf, bytes, stream, options } from './fixtures.js';
function pack(codes, widths = codes.map(() => 9)) {
  const bits = codes.map((code, i) => code.toString(2).padStart(widths[i], '0')).join('');
  return Uint8Array.from({ length: Math.ceil(bits.length / 8) }, (_, i) => parseInt(bits.slice(i * 8, i * 8 + 8).padEnd(8, '0'), 2));
}
function literalCodes(data, early) {
  const width = i => i < 255 - early ? 9 : i < 767 - early ? 10 : i < 1791 - early ? 11 : 12;
  return pack([256, ...data, 257], [9, ...Array.from(data, (_, i) => width(i)), width(data.length)]);
}
describe('original bounded C++ PDF LZW codec', () => {
  it('decodes a known dictionary example and the undefined-next-code special case', async () => {
    const reader = await NativePdfReader.create(simplePdf(''), options);
    try {
      const encoded = pack([256, 84, 79, 66, 69, 79, 82, 78, 79, 84, 258, 260, 262, 267, 261, 263, 265, 257]);
      expect(new TextDecoder().decode(decodeLzw(reader, encoded))).toBe('TOBEORNOTTOBEORTOBEORNOT');
      expect(new TextDecoder().decode(decodeLzw(reader, pack([256, 65, 258, 257])))).toBe('AAA');
      expect(new TextDecoder().decode(decodeLzw(reader, pack([256, 65, 256, 66, 257])))).toBe('AB');
    } finally { reader.destroy(); }
  });
  it.each([0, 1])('handles all code-width boundaries and full dictionaries with EarlyChange %i', async early => {
    const reader = await NativePdfReader.create(simplePdf(''), options), data = Uint8Array.from({ length: 5000 }, (_, i) => i * 73 + 17 & 255);
    try { expect(decodeLzw(reader, literalCodes(data, early), early)).toEqual(data); } finally { reader.destroy(); }
  });
  it('rejects impossible codes, missing EOD and bounded output overflow', async () => {
    const reader = await NativePdfReader.create(simplePdf(''), options);
    try {
      expect(() => decodeLzw(reader, pack([256, 258, 257]))).toThrow(/Invalid/);
      expect(() => decodeLzw(reader, pack([256, 65]))).toThrow(/unterminated/);
      expect(() => decodeLzw(reader, pack([256, 65, 258, 257]), 1, 2)).toThrow(/limit/);
      expect(new TextDecoder().decode(decodeLzw(reader, pack([256, 66, 257])))).toBe('B');
    } finally { reader.destroy(); }
  });
  it.each([0, 1])('reads real LZW PDF page bytes matching the independent oracle with EarlyChange %i', async early => {
    const lines = Array.from({ length: 40 }, (_, i) => `Original LZW execution ${early}, line ${i}: ab cd ef gh.`), content = lines.map((text, i) => `BT /F1 10 Tf 1 0 0 1 54 ${760 - 16 * i} Tm (${text}) Tj ET`).join('\n');
    const data = simplePdf('', { contents: stream(literalCodes(bytes(content), early), `/Filter /LZWDecode /DecodeParms << /EarlyChange ${early} >>`) });
    const own = await openPdfDocument(data, options), task = reference.getDocument({ data: data.slice(), useSystemFonts: true });
    try { const expected = (await (await (await task.promise).getPage(1)).getTextContent()).items.filter(i => i.str).map(i => i.str); const actual = (await (await own.getPage(1)).getTextContent()).items.map(i => i.str); expect(actual).toEqual(lines); expect(actual).toEqual(expected); } finally { own.destroy(); await task.destroy(); }
  });
});

const faxBits = bits => Uint8Array.from({ length: Math.ceil(bits.length / 8) }, (_, i) => parseInt(bits.slice(i * 8, i * 8 + 8).padEnd(8, '0'), 2));
const eol = '000000000001', eofb = eol + eol, white8 = '10011', black8 = '00110101' + '000101';
describe('original C++ T.4/T.6 fax execution', () => {
  it.each([false, true])('decodes Group3 white/black rows with BlackIs1 %s', async blackIs1 => {
    const reader = await NativePdfReader.create(simplePdf(''), options);
    try { expect([...decodeFax(reader, faxBits(white8 + black8), { columns: 8, rows: 2, k: 0, endOfBlock: false, blackIs1 })]).toEqual(blackIs1 ? [0, 255] : [255, 0]); } finally { reader.destroy(); }
  });
  it('accepts required or optional EOL and Group3 RTC while enforcing terminators', async () => {
    const reader = await NativePdfReader.create(simplePdf(''), options);
    try {
      expect([...decodeFax(reader, faxBits(eol + white8 + eol.repeat(6)), { columns: 8, endOfLine: true })]).toEqual([255]);
      expect([...decodeFax(reader, faxBits(eol + white8 + eol.repeat(6)), { columns: 8 })]).toEqual([255]);
      expect(() => decodeFax(reader, faxBits(white8), { columns: 8 })).toThrow(/unterminated/);
      expect(() => decodeFax(reader, faxBits(white8), { columns: 8, rows: 1, endOfLine: true, endOfBlock: false })).toThrow(/Invalid/);
    } finally { reader.destroy(); }
  });
  it('decodes Group4 horizontal, every vertical displacement, and end-of-facsimile-block', async () => {
    const reader = await NativePdfReader.create(simplePdf(''), options), changes = [4, 1, 3, 2, 4, 7, 6, 5, 8], vertical = { '-3': '0000010', '-2': '000010', '-1': '010', 0: '1', 1: '011', 2: '000011', 3: '0000011' };
    const bits = '0011011011' + changes.slice(1).map((white, i) => vertical[white - changes[i]] + (white === 8 ? '' : '1')).join('') + eofb;
    try { expect([...decodeFax(reader, faxBits(bits), { columns: 8, k: -1, rows: 1 })]).toEqual(changes.map(white => 255 << (8 - white) & 255)); } finally { reader.destroy(); }
  });
  it('decodes Group4 pass and Group3 mixed one/two-dimensional lines', async () => {
    const reader = await NativePdfReader.create(simplePdf(''), options);
    try {
      expect([...decodeFax(reader, faxBits('00110110110011011011' + '0001' + '001' + white8 + '0000110111' + eofb), { columns: 16, k: -1 })]).toEqual([240, 240, 255, 255]);
      expect([...decodeFax(reader, faxBits(eol + '1' + '1011011' + eol + '0' + '11' + (eol + '1').repeat(6)), { columns: 8, k: 2, endOfLine: true })]).toEqual([240, 240]);
    } finally { reader.destroy(); }
  });
  it('decodes dense 1024-column changing-element rows within the bounded native path', async () => {
    const reader = await NativePdfReader.create(simplePdf(''), options), bits = '001000111010'.repeat(512) + '1'.repeat(1024 * 31) + eofb;
    try { const output = decodeFax(reader, faxBits(bits), { columns: 1024, k: -1 }); expect(output.length).toBe(4096); expect(output.every(byte => byte === 170)).toBe(true); } finally { reader.destroy(); }
  });
  it('honors encoded byte alignment and padded output scan lines', async () => {
    const reader = await NativePdfReader.create(simplePdf(''), options);
    try {
      expect([...decodeFax(reader, faxBits((white8 + '000').repeat(2)), { columns: 8, rows: 2, encodedByteAlign: true, endOfBlock: false })]).toEqual([255, 255]);
      expect([...decodeFax(reader, faxBits('00011111'), { columns: 3, rows: 1, endOfBlock: false })]).toEqual([128 + 31]);
    } finally { reader.destroy(); }
  });
  it('performs only explicitly requested damaged-row recovery and reports it', async () => {
    const reader = await NativePdfReader.create(simplePdf(''), options), invalid = '000000000010', encoded = faxBits(eol + black8 + eol + invalid + eol + invalid + eol + white8 + eol.repeat(6));
    try {
      expect(() => decodeFax(reader, encoded, { columns: 8, endOfLine: true })).toThrow(/Invalid/);
      expect([...decodeFax(reader, encoded, { columns: 8, endOfLine: true, damagedRowsBeforeError: 2 })]).toEqual([0, 0, 255, 255]);
      expect(reader.codecWarnings).toEqual([{ filter: 'CCITTFaxDecode', damagedRows: 2 }]);
    } finally { reader.destroy(); }
  });
  it('executes Group3/4 uncompressed extensions and zero-suffix exits', async () => {
    const reader = await NativePdfReader.create(simplePdf(''), options);
    try {
      expect([...decodeFax(reader, faxBits('0000001111' + '00001' + '111' + '00000010' + eofb), { columns: 8, k: -1 })]).toEqual([240]);
      expect([...decodeFax(reader, faxBits('000000001111' + '000001' + '111' + '00000010' + eol.repeat(6)), { columns: 8, k: 0 })]).toEqual([248]);
      expect([...decodeFax(reader, faxBits('0000001111' + '001' + '111' + '0000000010' + eofb), { columns: 8, k: -1 })]).toEqual([195]);
    } finally { reader.destroy(); }
  });
  it('rejects malformed modes and reports unknown future extension selectors explicitly', async () => {
    const reader = await NativePdfReader.create(simplePdf(''), options);
    try {
      expect(() => decodeFax(reader, faxBits('0000000'), { columns: 8, k: -1 })).toThrow(/Invalid/);
      expect(() => decodeFax(reader, faxBits('0000001000'), { columns: 8, k: -1 })).toThrow(/extension selector/);
      expect(() => decodeFax(reader, faxBits('001' + white8 + '000101'), { columns: 8, k: -1 })).toThrow(/Invalid/);
    } finally { reader.destroy(); }
  });
  it.each([{ k: 0, encoded: white8 + black8 }, { k: -1, encoded: '0011011011' + '11' }])('decodes actual fax-filtered PDF images independently for K $k', async ({ k, encoded }) => {
    const data = simplePdf('q 80 0 0 40 0 0 cm /I Do Q', { page: '/Resources << /XObject << /I 6 0 R >> >>', extra: [stream(faxBits(encoded), `/Type /XObject /Subtype /Image /Width 8 /Height 2 /BitsPerComponent 1 /ColorSpace /DeviceGray /Filter /CCITTFaxDecode /DecodeParms << /K ${k} /Columns 8 /Rows 2 /EndOfBlock false >>`)] });
    const core = await createPdfDocumentCore(data, options), task = reference.getDocument({ data: data.slice(), wasmUrl: fileURLToPath(new URL('../../node_modules/pdfjs-dist/wasm/', import.meta.url)).replaceAll('\\', '/') });
    try {
      const payload = await core.pagePayload(1), image = payload.commands.find(c => c.op === 'image'); expect(image.pixels.length).toBe(8 * 2 * 4);
      const page = await (await task.promise).getPage(1), list = await page.getOperatorList(), position = list.fnArray.findIndex(fn => fn === reference.OPS.paintImageXObject || fn === reference.OPS.paintInlineImageXObject);
      expect(position).toBeGreaterThanOrEqual(0); const args = list.argsArray[position], oracle = list.fnArray[position] === reference.OPS.paintInlineImageXObject ? args[0] : await new Promise(resolve => page.objs.get(args[0], resolve));
      expect(oracle.width).toBe(8); expect(oracle.height).toBe(2);
      const expected = k === 0 ? [255, 0] : [240, 240];
      for (let row = 0; row < 2; row++) for (let x = 0; x < 8; x++) { const value = expected[row] & 128 >> x ? 255 : 0; expect(image.pixels[(row * 8 + x) * 4]).toBe(value); if (oracle.kind === 1) expect(oracle.data[row] & 128 >> x ? 255 : 0).toBe(value); else expect(oracle.data[(row * 8 + x) * (oracle.kind === 3 ? 4 : 3)]).toBe(value); }
    } finally { core.destroy(); await task.destroy(); }
  });
});
