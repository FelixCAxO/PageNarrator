import { describe, expect, it } from 'vitest';
import * as reference from 'pdfjs-dist/legacy/build/pdf.mjs';
import { parseCffFont } from '../../src/pdf/cff-font.js';
import { createPdfDocumentCore } from '../../src/pdf/document-core.js';
import { readTrueTypeMetrics } from '../../src/pdf/font-metrics.js';
import { privateGlyphCode } from '../../src/pdf/font-container.js';
import { simplePdf, stream, options } from './fixtures.js';

// Original geometric Type2 programs and CFF writer, against Adobe TN5176/5177.
const join = parts => new Uint8Array(Buffer.concat(parts.map(part => Buffer.from(part))));
const integer = n => Uint8Array.of(29, n >>> 24 & 255, n >>> 16 & 255, n >>> 8 & 255, n & 255);
const charNumber = n => Uint8Array.of(28, n >> 8 & 255, n & 255);
const dict = (values, op) => join([...values.map(integer), Uint8Array.of(op)]);
function index(parts) {
  if (!parts.length) return Uint8Array.of(0, 0);
  const offsets = [1]; for (const part of parts) offsets.push(offsets.at(-1) + part.length);
  const size = offsets.at(-1) > 255 ? 2 : 1;
  return join([Uint8Array.of(parts.length >> 8, parts.length & 255, size),
    Uint8Array.from(offsets.flatMap(value => size === 2 ? [value >> 8, value & 255] : [value])), ...parts]);
}
function miniatureExpert({ sids = [378, 229, 109, 1], encoding = [1], charsetOffset = null, cutCharset = false } = {}) {
  const header = Uint8Array.of(1, 0, 4, 4), name = index([Buffer.from('OriginalExpert')]);
  const empty = index([]), charset = Uint8Array.of(0, ...sids.flatMap(sid => [sid >> 8, sid & 255]));
  // Each GID is a distinguishable rectangle: x=10*gid, width=20*gid, height=100.
  const glyphs = index([Uint8Array.of(14), ...sids.map((_, i) => {
    const gid = i + 1;
    return join([charNumber(10 * gid), charNumber(0), Uint8Array.of(21), charNumber(20 * gid), charNumber(0),
      charNumber(0), charNumber(100), charNumber(-20 * gid), charNumber(0), Uint8Array.of(5, 14)]);
  })]);
  const top = (charsetAt, glyphsAt) => join([dict([charsetOffset ?? charsetAt], 15), dict(encoding, 16), dict([glyphsAt], 17)]);
  const start = header.length + name.length + index([top(0, 0)]).length + 2 * empty.length;
  return join([header, name, index([top(start, start + charset.length)]), empty, empty,
    cutCharset ? charset.subarray(0, 1) : charset, glyphs]);
}
function embedded(font, { codes = [33, 87, 255], differences = '', unicode = '' } = {}) {
  return simplePdf(`BT /F1 12 Tf 1 Tr <${Buffer.from(codes).toString('hex')}> Tj ET`, {
    font: `/Type /Font /Subtype /Type1 /BaseFont /OriginalExpert /FontDescriptor 6 0 R ${differences ? `/Encoding << /Differences ${differences} >>` : ''} ${unicode ? '/ToUnicode 8 0 R' : ''}`,
    extra: ['<< /Type /FontDescriptor /FontName /OriginalExpert /Flags 4 /FontBBox [0 0 1000 1000] /Ascent 900 /Descent 0 /StemV 80 /FontFile3 7 0 R >>',
      stream(font, '/Subtype /Type1C'), stream(unicode)],
  });
}
async function payload(data) { const core = await createPdfDocumentCore(data, options); try { return await core.pagePayload(1); } finally { core.destroy(); } }
async function referenceGids(data) {
  const task = reference.getDocument({ data: data.slice(), disableFontFace: true, fontExtraProperties: true, verbosity: 0 });
  try {
    const page = await (await task.promise).getPage(1), operators = await page.getOperatorList(), gids = [];
    let metrics;
    for (let i = 0; i < operators.fnArray.length; i++) {
      if (operators.fnArray[i] === reference.OPS.setFont) metrics = readTrueTypeMetrics(page.commonObjs.get(operators.argsArray[i][0]).data);
      if (operators.fnArray[i] === reference.OPS.showText) for (const glyph of operators.argsArray[i][0]) if (glyph && typeof glyph === 'object') gids.push(glyph.isInFont ? metrics.glyphId(glyph.fontChar.codePointAt(0)) : 0);
    }
    return gids;
  } finally { await task.destroy(); }
}

describe('CFF predefined ExpertEncoding', () => {
  it('maps codes through standard SIDs to the actual reordered charset, with missing SIDs unencoded', () => {
    const font = parseCffFont(miniatureExpert());
    expect([...font.encoding]).toEqual([[32, 4], [33, 2], [87, 3], [255, 1]]);
    expect(font.byName.get('exclamsmall')).toBe(2);
    expect(font.byName.get('Ydieresissmall')).toBe(1);
    expect(font.encoding.has(35)).toBe(false); // .notdef is never encoded.
    expect(font.encoding.has(34)).toBe(false); // Absent Hungarumlautsmall is not guessed.
  });

  it('agrees with independent reference glyph selection for all 256 codes and all standard SIDs', async () => {
    const font = miniatureExpert({ sids: Array.from({ length: 390 }, (_, i) => 390 - i) });
    const parsed = parseCffFont(font), codes = Array.from({ length: 256 }, (_, i) => i);
    expect(parsed.byName.size).toBe(391);
    expect(parsed.byName.get('Semibold')).toBe(1);
    expect(parsed.byName.get('exclamsmall')).toBe(162);
    const actual = await referenceGids(embedded(font, { codes }));
    expect(actual).toHaveLength(256);
    // PDF.js duplicates the .notdef program at its final GID when repairing CFF.
    expect(codes.flatMap(code => { const observed = actual[code] === 391 ? 0 : actual[code], expected = parsed.encoding.get(code) ?? 0; return observed === expected ? [] : [{ code, observed, expected }]; })).toEqual([]);
  });

  it('paints native outlines for the encoded GIDs while ToUnicode supplies different semantic text', async () => {
    const data = embedded(miniatureExpert(), { unicode: 'begincmap 3 beginbfchar <21> <0058> <57> <0059> <ff> <005a> endbfchar endcmap' });
    const actual = await payload(data), glyphs = actual.commands.find(command => command.op === 'text').glyphs;
    expect(actual.items.map(item => item.str).join('')).toBe('XYZ');
    expect(glyphs.map(glyph => glyph.renderText)).toEqual([2, 3, 1].map(gid => String.fromCodePoint(privateGlyphCode(gid))));
    expect(glyphs.map(glyph => glyph.outline)).toEqual([2, 3, 1].map(gid => [
      { op: 1, points: [10 * gid, 0] }, { op: 2, points: [30 * gid, 0] },
      { op: 2, points: [30 * gid, 100] }, { op: 2, points: [10 * gid, 100] }, { op: 4, points: [] },
    ]));
    expect(await referenceGids(data)).toEqual([2, 3, 1]);
  });

  it('keeps explicit PDF Differences authoritative over the built-in encoding', async () => {
    const data = embedded(miniatureExpert(), { codes: [33], differences: '[33 /fi]', unicode: 'begincmap 1 beginbfchar <21> <0058> endbfchar endcmap' });
    const actual = await payload(data), glyph = actual.commands.find(command => command.op === 'text').glyphs[0];
    expect(actual.items[0].str).toBe('X');
    expect(glyph.renderText).toBe(String.fromCodePoint(privateGlyphCode(3)));
    expect(await referenceGids(data)).toEqual([3]);
  });

  it.each([{ encoding: [] }, { encoding: [1, 2] }, { encoding: [-1] }, { encoding: [0x7fffffff] }])('rejects malformed or out-of-range encoding operands $encoding', ({ encoding }) => {
    expect(() => parseCffFont(miniatureExpert({ encoding }))).toThrow(expect.objectContaining({ code: 'pdf_corrupt' }));
  });

  it('retains bounds checks for the custom charset and distinguishes unsupported predefined charsets', () => {
    expect(() => parseCffFont(miniatureExpert({ cutCharset: true }))).toThrow(expect.objectContaining({ code: 'pdf_corrupt' }));
    for (const charsetOffset of [1, 2]) expect(() => parseCffFont(miniatureExpert({ charsetOffset }))).toThrow(/expert charsets/);
  });
});
