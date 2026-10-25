import { describe, expect, it } from 'vitest';
import { createPdfDocumentCore } from '../../src/pdf/document-core.js';
import { parseCffFont } from '../../src/pdf/cff-font.js';
import { readTrueTypeMetrics } from '../../src/pdf/font-metrics.js';
import { privateGlyphCode } from '../../src/pdf/font-container.js';
import { pdfLocalFontNames } from '../../src/pdf/system-fonts.js';
import { simplePdf, stream, loadAsset, options } from './fixtures.js';

function data({ flags = 98, angle = '-11', name = 'TimesNewRoman,Italic', descriptorName = name, encoding = '/WinAnsiEncoding', widths = '/FirstChar 65 /LastChar 66 /Widths [611 333]', unicode = null, embedded = null } = {}) {
  return simplePdf('BT /F1 20 Tf 1 0 0 1 20 60 Tm (AB) Tj ET', {
    font: `/Type /Font /Subtype /TrueType /BaseFont /${name} /Encoding ${encoding} ${widths} /FontDescriptor 6 0 R ${unicode ? '/ToUnicode 7 0 R' : ''}`,
    extra: [`<< /Type /FontDescriptor /FontName /${descriptorName} /Flags ${flags} ${angle ? `/ItalicAngle ${angle}` : ''} ${embedded ? '/FontFile2 8 0 R' : ''} >>`, stream(unicode ?? 'begincmap endcmap'), ...(embedded ? [stream(embedded)] : [])],
  });
}
async function payload(bytes) { const core = await createPdfDocumentCore(bytes, options); try { return await core.pagePayload(1); } finally { core.destroy(); } }

describe('exact known comma-style Times italic substitution', () => {
  it('uses licensed italic source glyphs, explicit PDF widths and an optional known local face', async () => {
    const actual = await payload(data()), command = actual.commands.find(command => command.op === 'text');
    const cff = parseCffFont(await loadAsset('standard_fonts/FoxitSerifItalic.pfb'));
    expect(command.glyphs.map(glyph => glyph.renderText)).toEqual(['A', 'B'].map(name => String.fromCodePoint(privateGlyphCode(cff.byName.get(name)))));
    expect(command.glyphs.map(glyph => glyph.systemText)).toEqual(['A', 'B']);
    expect(actual.items[0].str).toBe('AB'); expect(actual.items[0].width).toBeCloseTo(18.88, 9); expect(command.glyphs[1].x).toBeCloseTo(.611, 9);
    expect(actual.inspection.decodingWarnings).toContainEqual({ filter: 'FontSubstitution', sourceFont: 'TimesNewRoman,Italic', replacement: 'FoxitSerifItalic.pfb' });
    expect(actual.fonts[0].localFaces).toEqual(pdfLocalFontNames('Times-Italic')); expect(actual.fonts[0].requiresLocalFace).toBeUndefined();
  });
  it('keeps ToUnicode replacement text separate from the encoded painted glyph', async () => {
    const actual = await payload(data({ unicode: 'begincmap 1 beginbfchar <41> <0058> endbfchar endcmap' }));
    expect(actual.items[0].str).toBe('XB'); expect(actual.commands.find(command => command.op === 'text').glyphs[0].systemText).toBe('A');
    const cff = parseCffFont(await loadAsset('standard_fonts/FoxitSerifItalic.pfb'));
    expect(actual.commands.find(command => command.op === 'text').glyphs[0].renderText).toBe(String.fromCodePoint(privateGlyphCode(cff.byName.get('A'))));
  });
  it.each([{ flags: 34 }, { flags: 100 }, { angle: '' }, { angle: '0' }, { angle: '11' }, { angle: '/invalid' }, { descriptorName: 'Other' }, { name: 'Other,Italic' }, { name: 'AAAAAA+TimesNewRoman,Italic' }, { encoding: '/MacRomanEncoding' }, { widths: '' }])('does not broaden the exact style/encoding/metric admission: %j', async changes => {
    await expect(payload(data(changes))).rejects.toMatchObject({ code: 'pdf_unsupported' });
  });
  it('retains malformed width rejection and used-code span checks', async () => {
    await expect(payload(data({ widths: '/FirstChar 65 /LastChar 66 /Widths [611 /invalid]' }))).rejects.toMatchObject({ code: 'pdf_corrupt' });
    await expect(payload(data({ widths: '/FirstChar 65 /LastChar 65 /Widths [611]' }))).rejects.toMatchObject({ code: 'pdf_unsupported', message: expect.stringContaining('declared PDF width') });
  });
  it('keeps an embedded program authoritative even with this exact alias', async () => {
    const bytes = await loadAsset('standard_fonts/LiberationSans-Regular.ttf'), actual = await payload(data({ embedded: bytes, angle: '0', flags: 32 }));
    expect(actual.fonts[0].localFaces).toBeUndefined(); expect(actual.inspection.decodingWarnings.some(warning => warning.filter === 'FontSubstitution')).toBe(false);
    expect(actual.commands.find(command => command.op === 'text').glyphs[0].renderText).toBe(String.fromCodePoint(privateGlyphCode(readTrueTypeMetrics(bytes).glyphId(65))));
  });
});
