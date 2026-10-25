import { describe, expect, it } from 'vitest';
import * as reference from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createPdfDocumentCore } from '../../src/pdf/document-core.js';
import { readTrueTypeMetrics } from '../../src/pdf/font-metrics.js';
import { privateGlyphCode } from '../../src/pdf/font-container.js';
import { simplePdf, stream, loadAsset, options } from './fixtures.js';

async function payload(data) { const core = await createPdfDocumentCore(data, options); try { return await core.pagePayload(1); } finally { core.destroy(); } }
function embedded(font, encoding, { content = '(ABC)', unicode = null, outline = false } = {}) {
  return simplePdf(`BT /F1 12 Tf ${outline ? '1 Tr' : ''} ${content} Tj ET`, {
    font: `/Type /Font /Subtype /TrueType /BaseFont /OriginalDifferences /Encoding ${encoding} /FirstChar 65 /Widths [400 500 700] /FontDescriptor 6 0 R ${unicode ? '/ToUnicode 8 0 R' : ''}`,
    extra: ['<< /Type /FontDescriptor /Flags 32 /FontFile2 7 0 R >>', stream(font), stream(unicode ?? 'begincmap endcmap')],
  });
}
async function referencePage(data) {
  const task = reference.getDocument({ data: data.slice(), disableFontFace: true, fontExtraProperties: true, verbosity: 0 });
  try {
    const page = await (await task.promise).getPage(1), text = (await page.getTextContent()).items.map(item => item.str).join('');
    const operators = await page.getOperatorList(), glyphs = [];
    let font;
    for (let i = 0; i < operators.fnArray.length; i++) {
      if (operators.fnArray[i] === reference.OPS.setFont) font = page.commonObjs.get(operators.argsArray[i][0]);
      if (operators.fnArray[i] === reference.OPS.showText) for (const glyph of operators.argsArray[i][0]) if (glyph && typeof glyph === 'object') glyphs.push(readTrueTypeMetrics(font.data).glyphId(glyph.fontChar.codePointAt(0)));
    }
    return { text, glyphs };
  } finally { await task.destroy(); }
}

describe('TrueType encoding dictionaries', () => {
  it('uses declared glyph names for painting and outlines while ToUnicode supplies separate semantic text', async () => {
    const font = await loadAsset('standard_fonts/LiberationSans-Regular.ttf'), metrics = readTrueTypeMetrics(font);
    const data = embedded(font, '<< /BaseEncoding /WinAnsiEncoding /Differences [65 /B 67 /A] >>', {
      unicode: 'begincmap 3 beginbfchar <41> <0058> <42> <0042> <43> <0041> endbfchar endcmap', outline: true,
    });
    const actual = await payload(data), glyphs = actual.commands.find(command => command.op === 'text').glyphs;
    expect(actual.items[0].str).toBe('XBA'); expect(actual.items[0].width).toBeCloseTo(19.2, 8);
    const gids = [66, 66, 65].map(code => metrics.glyphId(code));
    expect(glyphs.map(glyph => glyph.renderText)).toEqual(gids.map(gid => String.fromCodePoint(privateGlyphCode(gid))));
    const originalPaint = await payload(embedded(font, '/WinAnsiEncoding', { content: '(BBA)', outline: true }));
    expect(glyphs.map(glyph => glyph.outline)).toEqual(originalPaint.commands.find(command => command.op === 'text').glyphs.map(glyph => glyph.outline));
    expect(await referencePage(data)).toEqual({ text: 'XBA', glyphs: gids });
  });

  it('resolves Differences through the Macintosh cmap rather than reusing the source byte', async () => {
    const font = (await loadAsset('standard_fonts/LiberationSans-Regular.ttf')).slice(), original = readTrueTypeMetrics(font), view = new DataView(font.buffer);
    for (let i = 0; i < view.getUint16(4); i++) {
      const row = 12 + i * 16; if (String.fromCharCode(...font.subarray(row, row + 4)) !== 'cmap') continue;
      const at = view.getUint32(row + 8); view.setUint16(at + 2, 1); view.setUint16(at + 4, 1); view.setUint16(at + 6, 0); view.setUint32(at + 8, 12);
      view.setUint16(at + 12, 6); view.setUint16(at + 14, 14); view.setUint16(at + 18, 65); view.setUint16(at + 20, 2);
      view.setUint16(at + 22, original.glyphId(65)); view.setUint16(at + 24, original.glyphId(66));
    }
    const data = embedded(font, '<< /BaseEncoding /MacRomanEncoding /Differences [65 /B] >>', { content: '(A)' }), actual = await payload(data);
    expect(actual.items[0].str).toBe('B');
    expect(actual.commands.find(command => command.op === 'text').glyphs[0].renderText).toBe(String.fromCodePoint(privateGlyphCode(original.glyphId(66))));
    expect(await referencePage(data)).toEqual({ text: 'B', glyphs: [original.glyphId(66)] });
    // An absent MacRoman character must not become a glyph from byte zero.
    for (let i = 0; i < view.getUint16(4); i++) {
      const row = 12 + i * 16; if (String.fromCharCode(...font.subarray(row, row + 4)) !== 'cmap') continue;
      const at = view.getUint32(row + 8); view.setUint16(at + 14, 12); view.setUint16(at + 18, 0); view.setUint16(at + 20, 1); view.setUint16(at + 22, original.glyphId(65));
    }
    expect(readTrueTypeMetrics(font).glyphId(0)).toBe(original.glyphId(65));
    await expect(payload(embedded(font, '<< /BaseEncoding /MacRomanEncoding /Differences [65 /u1F600] >>', { content: '(A)',
      unicode: 'begincmap 1 beginbfchar <41> <0041> endbfchar endcmap' }))).rejects.toMatchObject({ code: 'pdf_unsupported' });
  });

  it('uses StandardEncoding for an absent base and declared names for licensed Standard14 glyph metrics', async () => {
    const data = simplePdf('BT /F1 12 Tf <0141> Tj ET', { font: '/Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding << /Differences [1 /fi] >>' });
    const actual = await payload(data), font = readTrueTypeMetrics(actual.fonts[0].bytes);
    expect(actual.items[0].str).toBe('ﬁA');
    expect(actual.items[0].width).toBeCloseTo((500 + 667) * .012, 8);
    expect(actual.commands.find(command => command.op === 'text').glyphs[0].renderText).toBe(String.fromCodePoint(privateGlyphCode(font.glyphId(0xfb01))));
  });

  it('keeps unknown used names unsupported even if ToUnicode supplies plausible text', async () => {
    const font = await loadAsset('standard_fonts/LiberationSans-Regular.ttf');
    await expect(payload(embedded(font, '<< /Differences [65 /UninventedCustomGlyph] >>', { content: '(A)', unicode: 'begincmap 1 beginbfchar <41> <0041> endbfchar endcmap' }))).rejects.toMatchObject({ code: 'pdf_unsupported' });
    expect((await payload(embedded(font, '<< /Differences [65 /UninventedCustomGlyph] >>', { content: '(B)' }))).items[0].str).toBe('B');
  });

  it.each(['[ /B ]', '[ -1 /B ]', '[ 255 /A /B ]', '[ 65.5 /B ]', '[ 65 true ]', '/NotAnArray'])('rejects malformed Differences %s', async differences => {
    await expect(payload(embedded(await loadAsset('standard_fonts/LiberationSans-Regular.ttf'), `<< /BaseEncoding /WinAnsiEncoding /Differences ${differences} >>`))).rejects.toMatchObject({ code: 'pdf_corrupt' });
  });

  it.each([['Arial,Bold', 'LiberationSans-Bold.ttf'], ['Arial,Italic', 'LiberationSans-Italic.ttf'], ['Arial,BoldItalic', 'LiberationSans-BoldItalic.ttf']])('recognizes the documented comma-style Arial name %s', async (name, asset) => {
    const font = await loadAsset(`standard_fonts/${asset}`), actual = await payload(simplePdf('BT /F1 12 Tf 1 Tr (A) Tj ET', { font: `/Type /Font /Subtype /TrueType /BaseFont /${name} /Encoding /WinAnsiEncoding` }));
    expect(readTrueTypeMetrics(actual.fonts[0].bytes).width(65)).toBe(readTrueTypeMetrics(font).width(65));
    const expected = await payload(embedded(font, '/WinAnsiEncoding', { content: '(A)', outline: true }));
    expect(actual.commands.find(command => command.op === 'text').glyphs[0].outline).toEqual(expected.commands.find(command => command.op === 'text').glyphs[0].outline);
    expect(actual.items[0].str).toBe('A');
  });
});
