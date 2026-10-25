import { describe, expect, it } from 'vitest';
import { createPdfDocumentCore } from '../../src/pdf/document-core.js';
import { readTrueTypeMetrics } from '../../src/pdf/font-metrics.js';
import { privateGlyphCode } from '../../src/pdf/font-container.js';
import { pdfLocalFontNames } from '../../src/pdf/system-fonts.js';
import { simplePdf, stream, loadAsset, options } from './fixtures.js';

const declaredWidths = `/FirstChar 86 /LastChar 119 /Widths [${Array.from({ length: 34 }, (_, index) => ({ 86: 778, 119: 944 })[index + 86] ?? 500).join(' ')}]`;
function data({ flags = 32, angle = '0', name = 'ArialBlack', descriptorName = name, encoding = '/WinAnsiEncoding', widths = declaredWidths, unicode = null, embedded = null, content = '(Vw)', mode = 0 } = {}) {
  return simplePdf(`BT /F1 20 Tf ${mode} Tr 1 0 0 1 20 60 Tm ${content} Tj ET`, {
    font: `/Type /Font /Subtype /TrueType /BaseFont /${name} /Encoding ${encoding} ${widths} /FontDescriptor 6 0 R ${unicode ? '/ToUnicode 7 0 R' : ''}`,
    extra: [`<< /Type /FontDescriptor /FontName /${descriptorName} /Flags ${flags} ${angle ? `/ItalicAngle ${angle}` : ''} ${embedded ? '/FontFile2 8 0 R' : ''} >>`, stream(unicode ?? 'begincmap endcmap'), ...(embedded ? [stream(embedded)] : [])],
  });
}
async function payload(bytes) { const core = await createPdfDocumentCore(bytes, options); try { return await core.pagePayload(1); } finally { core.destroy(); } }

describe('exact declared Arial Black substitution', () => {
  it('uses existing licensed bold glyphs while retaining source PDF advances and an explicit warning', async () => {
    const actual = await payload(data()), command = actual.commands.find(command => command.op === 'text');
    const metrics = readTrueTypeMetrics(await loadAsset('standard_fonts/LiberationSans-Bold.ttf'));
    expect(command.glyphs.map(glyph => glyph.renderText)).toEqual([86, 119].map(code => String.fromCodePoint(privateGlyphCode(metrics.glyphId(code)))));
    expect(command.glyphs.map(glyph => glyph.systemText)).toEqual(['V', 'w']);
    expect(actual.items[0].str).toBe('Vw'); expect(actual.items[0].width).toBeCloseTo(34.44, 9); expect(command.glyphs[1].x).toBeCloseTo(.778, 9);
    expect(actual.inspection.decodingWarnings).toContainEqual({ filter: 'FontSubstitution', sourceFont: 'ArialBlack', replacement: 'LiberationSans-Bold.ttf' });
    expect(actual.fonts[0].localFaces).toEqual(['Arial Black', 'Arial-Black']); expect(pdfLocalFontNames('ArialBlack')).toEqual(['Arial Black', 'Arial-Black']);
    expect(actual.fonts[0].requiresLocalFace).toBeUndefined();
  });
  it('keeps ToUnicode replacement and empty semantics independent from original encoded paint', async () => {
    for (const [unicode, text] of [['begincmap 1 beginbfchar <56> <0058> endbfchar endcmap', 'Xw'], ['begincmap 1 beginbfchar <56> <> endbfchar endcmap', 'w']]) {
      const actual = await payload(data({ unicode })), command = actual.commands.find(command => command.op === 'text');
      expect(actual.items[0].str).toBe(text); expect(command.glyphs[0].systemText).toBe('V'); expect(actual.items[0].width).toBeCloseTo(34.44, 9);
    }
  });
  it.each([{ flags: 0 }, { flags: 36 }, { flags: 96 }, { angle: '' }, { angle: '-1' }, { angle: '1' }, { angle: '/invalid' }, { descriptorName: 'Arial' }, { name: 'ArialBlackCustom' }, { name: 'AAAAAA+ArialBlack' }, { name: 'Arial-Black' }, { encoding: '/MacRomanEncoding' }, { encoding: '<< /BaseEncoding /WinAnsiEncoding /Differences [86 /W] >>' }, { widths: '' }])('rejects unsupported family, style, encoding and metric claims: %j', async changes => {
    await expect(payload(data(changes))).rejects.toMatchObject({ code: 'pdf_unsupported' });
  });
  it('keeps malformed widths distinct from unsupported used-code spans', async () => {
    await expect(payload(data({ widths: '/FirstChar 86 /LastChar 86 /Widths [/invalid]' }))).rejects.toMatchObject({ code: 'pdf_corrupt' });
    await expect(payload(data({ widths: '/FirstChar 86 /LastChar 86 /Widths [778]' }))).rejects.toMatchObject({ code: 'pdf_unsupported', message: expect.stringContaining('declared PDF width') });
  });
  it('uses the licensed substitute outlines for explicit stroke mode without changing source widths', async () => {
    const actual = await payload(data({ mode: 1 }));
    expect(actual.items[0].str).toBe('Vw'); expect(actual.items[0].width).toBeCloseTo(34.44, 9);
    const command = actual.commands.find(command => command.op === 'text');
    expect(command.paintMode).toBe(1); expect(command.glyphs.every(glyph => glyph.outline.length > 0)).toBe(true);
    expect(command.glyphs[0].fontMatrix).toEqual([1 / 2048, 0, 0, 1 / 2048, 0, 0]);
    expect(actual.inspection.decodingWarnings).toContainEqual({ filter: 'FontSubstitution', sourceFont: 'ArialBlack', replacement: 'LiberationSans-Bold.ttf' });
  });
  it('never overrides an embedded program based on its alias', async () => {
    const bytes = await loadAsset('standard_fonts/LiberationSans-Italic.ttf'), actual = await payload(data({ embedded: bytes, angle: '-11', flags: 96, descriptorName: 'Other' }));
    expect(actual.fonts[0].localFaces).toBeUndefined(); expect(actual.inspection.decodingWarnings.some(warning => warning.filter === 'FontSubstitution')).toBe(false);
    expect(actual.commands.find(command => command.op === 'text').glyphs[0].renderText).toBe(String.fromCodePoint(privateGlyphCode(readTrueTypeMetrics(bytes).glyphId(86))));
  });
});
