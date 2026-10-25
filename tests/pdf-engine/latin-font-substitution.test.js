import { describe, expect, it } from 'vitest';
import { createPdfDocumentCore } from '../../src/pdf/document-core.js';
import { readTrueTypeMetrics } from '../../src/pdf/font-metrics.js';
import { parseCffFont } from '../../src/pdf/cff-font.js';
import { privateGlyphCode } from '../../src/pdf/font-container.js';
import { pdfLocalFontNames } from '../../src/pdf/system-fonts.js';
import { simplePdf, stream, loadAsset, options } from './fixtures.js';

const cases = [
  ['TrebuchetMS', 'LiberationSans-Regular.ttf', 'Trebuchet MS'], ['Verdana', 'LiberationSans-Regular.ttf', 'Verdana'],
  ['Verdana,Italic', 'LiberationSans-Italic.ttf', 'Verdana Italic'], ['Verdana,Bold', 'LiberationSans-Bold.ttf', 'Verdana Bold'],
  ['CourierNew', 'FoxitFixed.pfb', 'Courier New'], ['CourierNew,Bold', 'FoxitFixedBold.pfb', 'Courier New Bold'],
];
async function payload(data) {
  const core = await createPdfDocumentCore(data, options);
  try { return await core.pagePayload(1); } finally { core.destroy(); }
}
function document(name = 'Verdana', { flags = 32, encoding = '/WinAnsiEncoding', metrics = '/FirstChar 65 /LastChar 66 /Widths [321 654]', content = '(AB)', unicode = null, embedded = null } = {}) {
  return simplePdf(`BT /F1 20 Tf 1 0 0 1 50 700 Tm ${content} Tj ET`, {
    font: `/Type /Font /Subtype /TrueType /BaseFont /${name} ${encoding ? `/Encoding ${encoding}` : ''} ${metrics} /FontDescriptor 6 0 R ${unicode ? '/ToUnicode 7 0 R' : ''}`,
    extra: [`<< /Type /FontDescriptor /Flags ${flags}${embedded ? ' /FontFile2 8 0 R' : ''} >>`, stream(unicode ?? 'begincmap endcmap'), ...(embedded ? [stream(embedded)] : [])],
  });
}
async function expectedGids(asset, names) {
  const bytes = await loadAsset(`standard_fonts/${asset}`);
  if (asset.endsWith('.pfb')) { const font = parseCffFont(bytes); return names.map(name => font.byName.get(name)); }
  const metrics = readTrueTypeMetrics(bytes); return names.map(name => metrics.glyphId(name === 'Euro' ? 0x20ac : name.codePointAt(0)));
}

describe('bounded known unembedded Latin font substitution', () => {
  it.each(cases)('uses the declared glyphs and PDF advances for %s with an explicit substitute warning', async (name, asset, local) => {
    const actual = await payload(document(name)), command = actual.commands.find(c => c.op === 'text');
    expect(actual.items[0].str).toBe('AB'); expect(actual.items[0].width).toBeCloseTo((321 + 654) * .02, 8);
    expect(command.glyphs[1].x).toBeCloseTo(.321, 8);
    expect(command.glyphs.map(glyph => glyph.renderText)).toEqual((await expectedGids(asset, ['A', 'B'])).map(gid => String.fromCodePoint(privateGlyphCode(gid))));
    expect(actual.inspection.unmappedGlyphs).toBe(0);
    expect(actual.inspection.decodingWarnings).toContainEqual({ filter: 'FontSubstitution', sourceFont: name, replacement: asset });
    expect(actual.fonts[0].localFaces).toContain(local); expect(pdfLocalFontNames(name)).toContain(local);
  });

  it.each(['Verdana', 'CourierNew'])('keeps ToUnicode semantics separate from %s source paint', async name => {
    const actual = await payload(document(name, { unicode: 'begincmap 1 beginbfchar <41> <0058> endbfchar endcmap' }));
    expect(actual.items[0].str).toBe('XB'); expect(actual.items[0].width).toBeCloseTo(19.5, 8);
    const asset = cases.find(row => row[0] === name)[1];
    expect(actual.commands.find(c => c.op === 'text').glyphs[0].renderText).toBe(String.fromCodePoint(privateGlyphCode((await expectedGids(asset, ['A']))[0])));
  });

  it.each(['Verdana', 'CourierNew'])('accepts the independently verified redundant WinAnsi Euro Difference for %s', async name => {
    const actual = await payload(document(name, { encoding: '<< /BaseEncoding /WinAnsiEncoding /Differences [128 /Euro] >>', metrics: '/FirstChar 128 /LastChar 128 /Widths [555]', content: '<80>' }));
    expect(actual.items[0].str).toBe('€'); expect(actual.items[0].width).toBeCloseTo(11.1, 8);
    const gid = (await expectedGids(cases.find(row => row[0] === name)[1], ['Euro']))[0]; expect(gid).toBeGreaterThan(0);
    expect(actual.commands.find(c => c.op === 'text').glyphs[0].renderText).toBe(String.fromCodePoint(privateGlyphCode(gid)));
  });

  it.each([0, 4, 36])('keeps nonsymbolic admission closed for Flags %i', async flags => {
    await expect(payload(document('Verdana', { flags }))).rejects.toMatchObject({ code: 'pdf_unsupported' });
  });
  it.each(['', '/MacRomanEncoding', '/CustomEncoding', '<< /Differences [65 /A] >>'])('keeps undeclared or unsupported encodings closed: %s', async encoding => {
    await expect(payload(document('Verdana', { encoding }))).rejects.toMatchObject({ code: 'pdf_unsupported' });
  });
  it('does not use fallback aliases for custom glyph remapping or unknown font families', async () => {
    await expect(payload(document('Verdana', { encoding: '<< /BaseEncoding /WinAnsiEncoding /Differences [65 /B] >>' }))).rejects.toMatchObject({ code: 'pdf_unsupported' });
    for (const name of ['CustomVerdana', 'AAAAAA+Verdana', 'UnknownLatin', '宋体']) await expect(payload(document(name))).rejects.toMatchObject({ code: 'pdf_unsupported' });
  });
  it('requires complete finite explicit widths and rejects used codes outside that declaration', async () => {
    await expect(payload(document('Verdana', { metrics: '' }))).rejects.toMatchObject({ code: 'pdf_unsupported' });
    for (const metrics of ['/FirstChar 65 /LastChar 66 /Widths [321]', '/FirstChar 65 /LastChar 66 /Widths [321 /invalid]']) await expect(payload(document('Verdana', { metrics }))).rejects.toMatchObject({ code: 'pdf_corrupt' });
    await expect(payload(document('Verdana', { content: '(C)' }))).rejects.toMatchObject({ code: 'pdf_unsupported', message: expect.stringContaining('declared PDF width') });
  });
  it('never replaces an embedded program even when it uses one of these known family names', async () => {
    const embedded = await loadAsset('standard_fonts/LiberationSans-Italic.ttf'), actual = await payload(document('Verdana', { embedded }));
    expect(actual.fonts[0].localFaces).toBeUndefined(); expect(actual.inspection.decodingWarnings.some(warning => warning.filter === 'FontSubstitution')).toBe(false);
    expect(actual.commands.find(c => c.op === 'text').glyphs[0].renderText).toBe(String.fromCodePoint(privateGlyphCode(readTrueTypeMetrics(embedded).glyphId(65))));
  });
});
