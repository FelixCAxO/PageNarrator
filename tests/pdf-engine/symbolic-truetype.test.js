import { describe, expect, it } from 'vitest';
import { createPdfDocumentCore } from '../../src/pdf/document-core.js';
import { readTrueTypeMetrics } from '../../src/pdf/font-metrics.js';
import { privateGlyphCode } from '../../src/pdf/font-container.js';
import { createPdfPageModel } from '../../src/lib/pdf-page-model.js';
import { stripPrivateUseCharacters } from '../../src/lib/core/text-noise-filter.js';
import { simplePdf, stream, loadAsset, options } from './fixtures.js';

async function payload(data) {
  const core = await createPdfDocumentCore(data, options);
  try { return await core.pagePayload(1); } finally { core.destroy(); }
}
// Authored cmap facts select independently known licensed A/B outlines. No
// Wingdings name or glyph geometry is used to manufacture semantic Unicode.
async function symbolicFont(pairs = [[0xf0a7, 65]]) {
  const font = (await loadAsset('standard_fonts/LiberationSans-Regular.ttf')).slice(), metrics = readTrueTypeMetrics(font.slice());
  const view = new DataView(font.buffer, font.byteOffset, font.byteLength);
  let cmap;
  for (let i = 0; i < view.getUint16(4); i++) {
    const row = 12 + i * 16;
    if (String.fromCharCode(...font.subarray(row, row + 4)) === 'cmap') cmap = view.getUint32(row + 8);
  }
  const mappings = pairs.map(([code, unicode]) => [code, metrics.glyphId(unicode)]).sort((a, b) => a[0] - b[0]);
  mappings.push([65535, 0]);
  const count = mappings.length, subtable = cmap + 12, length = 16 + count * 8, power = 2 ** Math.floor(Math.log2(count));
  font.fill(0, cmap, subtable + length);
  view.setUint16(cmap + 2, 1); view.setUint16(cmap + 4, 3); view.setUint16(cmap + 6, 0); view.setUint32(cmap + 8, 12);
  view.setUint16(subtable, 4); view.setUint16(subtable + 2, length); view.setUint16(subtable + 6, count * 2);
  view.setUint16(subtable + 8, power * 2); view.setUint16(subtable + 10, Math.log2(power)); view.setUint16(subtable + 12, count * 2 - power * 2);
  mappings.forEach(([code, gid], i) => {
    view.setUint16(subtable + 14 + i * 2, code);
    view.setUint16(subtable + 16 + count * 2 + i * 2, code);
    view.setUint16(subtable + 16 + count * 4 + i * 2, gid - code & 65535);
  });
  return { font, originalMetrics: metrics };
}
function document(font, { content = '<a7>', unicode = null, flags = 4, outline = false } = {}) {
  return simplePdf(`BT /F1 20 Tf ${outline ? '1 Tr' : ''} 1 0 0 1 50 700 Tm ${content} Tj ET`, {
    font: `/Type /Font /Subtype /TrueType /BaseFont /AuthoredSymbolic /FirstChar 167 /Widths [321 654] /FontDescriptor 6 0 R ${unicode === null ? '' : '/ToUnicode 8 0 R'}`,
    extra: [`<< /Type /FontDescriptor /Flags ${flags} /FontFile2 7 0 R >>`, stream(font), stream(unicode ?? 'begincmap endcmap')],
  });
}
const mapping = value => `begincmap 1 beginbfchar <a7> <${value}> endbfchar endcmap`;

describe('embedded symbolic TrueType built-in encodings', () => {
  it.each([0, 0xf000, 0xf100, 0xf200])('selects the actual glyph in the ISO byte range %i without inventing Latin text', async prefix => {
    const { font, originalMetrics } = await symbolicFont([[prefix + 167, 65]]), unchanged = font.slice();
    const actual = await payload(document(font)), glyph = actual.commands.find(command => command.op === 'text').glyphs[0];
    expect(glyph.renderText).toBe(String.fromCodePoint(privateGlyphCode(originalMetrics.glyphId(65))));
    expect(actual.items[0].str).toBe('\ue0a7'); expect(actual.items[0].str).not.toBe('§');
    expect(actual.items[0].width).toBeCloseTo(6.42, 8);
    expect(actual.inspection.unmappedGlyphs).toBe(1);
    expect(actual.inspection.decodingWarnings).toContainEqual({ filter: 'TrueType', unmappedSymbolicText: true });
    expect(createPdfPageModel(actual.items).speech).toBe(''); expect(font).toEqual(unchanged);
  });

  it('keeps ToUnicode text separate from the built-in source glyph and its outline', async () => {
    const { font, originalMetrics } = await symbolicFont(), actual = await payload(document(font, { unicode: mapping('0058'), outline: true }));
    const glyph = actual.commands.find(command => command.op === 'text').glyphs[0];
    expect(actual.items[0].str).toBe('X'); expect(actual.inspection.unmappedGlyphs).toBe(0);
    expect(actual.inspection.decodingWarnings).not.toContainEqual({ filter: 'TrueType', unmappedSymbolicText: true });
    expect(glyph.renderText).toBe(String.fromCodePoint(privateGlyphCode(originalMetrics.glyphId(65))));
    const reference = await payload(simplePdf('BT /F1 20 Tf 1 Tr (A) Tj ET', {
      font: '/Type /Font /Subtype /TrueType /BaseFont /AuthoredLatin /Encoding /WinAnsiEncoding /FontDescriptor 6 0 R',
      extra: ['<< /Type /FontDescriptor /Flags 32 /FontFile2 7 0 R >>', stream(await loadAsset('standard_fonts/LiberationSans-Regular.ttf'))],
    }));
    expect(glyph.outline).toEqual(reference.commands.find(command => command.op === 'text').glyphs[0].outline);
  });

  it('retains unknown glyphs when ToUnicode is partial and warns once per font', async () => {
    const { font, originalMetrics } = await symbolicFont([[0xf0a7, 65], [0xf0a8, 66]]);
    const actual = await payload(document(font, { content: '<a7a8a8>', unicode: mapping('0058') }));
    expect(actual.items[0].str).toBe('X\ue0a8\ue0a8'); expect(actual.inspection.unmappedGlyphs).toBe(2);
    expect(actual.inspection.decodingWarnings.filter(warning => warning.unmappedSymbolicText)).toHaveLength(1);
    expect(actual.commands.find(command => command.op === 'text').glyphs.map(glyph => glyph.renderText)).toEqual([65, 66, 66].map(code => String.fromCodePoint(privateGlyphCode(originalMetrics.glyphId(code)))));
    expect(stripPrivateUseCharacters(createPdfPageModel(actual.items).speech)).toBe('X.');
  });

  it('honors explicit empty Unicode without dropping the visible source glyph', async () => {
    const { font, originalMetrics } = await symbolicFont(), actual = await payload(document(font, { unicode: mapping('') }));
    expect(actual.items).toHaveLength(0); expect(actual.inspection.unmappedGlyphs).toBe(0);
    expect(actual.commands.find(command => command.op === 'text').glyphs[0].renderText).toBe(String.fromCodePoint(privateGlyphCode(originalMetrics.glyphId(65))));
  });

  it('does not apply the symbolic route to a nonsymbolic descriptor', async () => {
    const { font } = await symbolicFont();
    await expect(payload(document(font, { flags: 32 }))).rejects.toThrow('Non-ASCII StandardEncoding');
  });

  it('rejects ambiguous symbolic cmap ranges without choosing a glyph', async () => {
    const { font } = await symbolicFont([[0x00a7, 65], [0xf0a7, 66]]);
    await expect(payload(document(font))).rejects.toMatchObject({ code: 'pdf_unsupported', message: expect.stringContaining('symbolic TrueType cmap range') });
  });

  it('reports a missing CID font program accurately while keeping it unsupported', async () => {
    const data = simplePdf('BT /F1 20 Tf <8140> Tj ET', {
      font: '/Type /Font /Subtype /Type0 /BaseFont /MissingCjk /Encoding /GBK-EUC-H /DescendantFonts [6 0 R]',
      extra: ['<< /Type /Font /Subtype /CIDFontType2 /BaseFont /MissingCjk /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 2 >> /FontDescriptor 7 0 R >>', '<< /Type /FontDescriptor /Flags 5 >>'],
    });
    await expect(payload(data)).rejects.toMatchObject({ code: 'pdf_unsupported', message: 'This unembedded PDF CID font needs a supported font program.' });
  });
});
