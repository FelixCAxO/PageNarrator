import { describe, expect, it } from 'vitest';
import { NativePdfReader } from '../../src/pdf/native-reader.js';
import { parseCffFont, readCffWidths } from '../../src/pdf/cff-font.js';
import { buildCffOpenType, privateGlyphCode } from '../../src/pdf/font-container.js';
import { readTrueTypeMetrics } from '../../src/pdf/font-metrics.js';
import { createPdfDocumentCore } from '../../src/pdf/document-core.js';
import { simplePdf, stream, options } from './fixtures.js';

const join = parts => new Uint8Array(Buffer.concat(parts.map(part => Buffer.from(part))));
const number = n => [28, n >> 8 & 255, n & 255];
function index(parts) {
  const offsets = [1]; for (const part of parts) offsets.push(offsets.at(-1) + part.length);
  return join([[0, parts.length, 1, ...offsets], ...parts]);
}
function authoredCff(width, fontName = 'SignedAdvance') {
  const name = index([Buffer.from(fontName)]), empty = Uint8Array.of(0, 0), charset = Uint8Array.of(0, 0, 34);
  const glyphs = index([Uint8Array.of(14), Uint8Array.from([...number(width), ...number(0), ...number(0), 21,
    ...number(200), ...number(0), ...number(0), ...number(100), ...number(-200), ...number(0), 5, 14])]);
  const dict = (charsetAt, glyphsAt) => Uint8Array.from([29, 0, 0, 0, charsetAt, 15, 29, 0, 0, 0, glyphsAt, 17]);
  const start = 4 + name.length + index([dict(0, 0)]).length + 2 * empty.length;
  return join([[1, 0, 4, 4], name, index([dict(start, start + charset.length)]), empty, empty, charset, glyphs]);
}

describe('signed CFF advances in an unsigned browser metric table', () => {
  it.each([-139, -8, 0, 601])('retains native advance %i and writes a valid browser width without wrapping', async width => {
    const reader = await NativePdfReader.create(simplePdf(''), options);
    try {
      const font = parseCffFont(authoredCff(width)), advances = readCffWidths(reader, font), original = [...advances];
      expect(advances).toEqual([0, width]);
      const converted = buildCffOpenType(font, advances), metrics = readTrueTypeMetrics(converted);
      expect(metrics.widthByGlyph(1)).toBe(Math.max(0, width)); expect(metrics.glyphId(privateGlyphCode(1))).toBe(1);
      expect(advances).toEqual(original);
    } finally { reader.destroy(); }
  });

  it('keeps PDF widths and glyph positions while reporting the browser metric repair', async () => {
    const data = simplePdf('BT /F1 10 Tf (AA) Tj ET', {
      font: '/Type /Font /Subtype /Type1 /BaseFont /SignedAdvance /FirstChar 65 /LastChar 65 /Widths [700] /FontDescriptor 6 0 R',
      extra: ['<< /Type /FontDescriptor /FontFile3 7 0 R >>', stream(authoredCff(-139), '/Subtype /Type1C')],
    });
    const core = await createPdfDocumentCore(data, options);
    try {
      const payload = await core.pagePayload(1), text = payload.commands.find(command => command.op === 'text');
      expect(payload.items[0].str).toBe('AA'); expect(payload.items[0].width).toBe(14);
      expect(text.glyphs.map(glyph => glyph.x)).toEqual([0, 0.7]);
      expect(payload.inspection.decodingWarnings).toContainEqual({ filter: 'CFF', clampedBrowserAdvanceWidths: 1 });
      expect(readTrueTypeMetrics(payload.fonts[0].bytes).widthByGlyph(1)).toBe(0);
    } finally { core.destroy(); }
  });

  it('rejects nonfinite and out-of-range metric values at the browser boundary', () => {
    const font = parseCffFont(authoredCff(0));
    for (const value of [NaN, Infinity, -Infinity, -65536, 65536]) expect(() => buildCffOpenType(font, [0, value])).toThrow(expect.objectContaining({ code: 'pdf_corrupt' }));
  });

  it('repairs only invalid Name INDEX metadata bytes, preserving source, offsets and glyph programs', () => {
    const bytes = authoredCff(0, '*Own Font[Name]'), original = bytes.slice(), font = parseCffFont(bytes);
    const converted = buildCffOpenType(font, [0, 0]), view = new DataView(converted.buffer);
    let retained;
    for (let i = 0; i < view.getUint16(4); i++) if (new TextDecoder().decode(converted.subarray(12 + i * 16, 16 + i * 16)) === 'CFF ') {
      const offset = view.getUint32(20 + i * 16), length = view.getUint32(24 + i * 16); retained = converted.subarray(offset, offset + length);
    }
    expect(font.nameRepairs).toHaveLength(3); expect(bytes).toEqual(original); expect(retained.length).toBe(bytes.length);
    expect(parseCffFont(retained).name).toBe('*Own-Font-Name-');
    expect(parseCffFont(retained).glyphs).toEqual(font.glyphs);
    expect([...retained.keys()].filter(i => retained[i] !== bytes[i])).toEqual(font.nameRepairs);
  });

  it('does not revive a font marked deleted by a leading NUL name byte', () => {
    expect(() => parseCffFont(authoredCff(0, '\0OwnFont'))).toThrow(expect.objectContaining({ code: 'pdf_corrupt', message: expect.stringContaining('deleted') }));
  });
});
