import { describe, expect, it, vi } from 'vitest';
import { pdfLatinGlyphName, pdfLatinGlyphText } from '../../src/pdf/latin-encodings.js';
import { createPdfDocumentCore } from '../../src/pdf/document-core.js';
import { parseCffFont } from '../../src/pdf/cff-font.js';
import { readTrueTypeMetrics } from '../../src/pdf/font-metrics.js';
import { privateGlyphCode } from '../../src/pdf/font-container.js';
import { simplePdf, stream, options, loadAsset } from './fixtures.js';

async function payload(data, settings = options) { const core = await createPdfDocumentCore(data, settings); try { return await core.pagePayload(1); } finally { core.destroy(); } }
const originalPdf = (encoding, hex, unicode = null) => simplePdf(`BT /F1 20 Tf 1 0 0 1 54 700 Tm <${hex}> Tj ET`, {
  font: `/Type /Font /Subtype /Type1 /BaseFont /Times-Roman /Encoding /${encoding}${unicode ? ' /ToUnicode 6 0 R' : ''}`,
  extra: unicode ? [stream(unicode)] : [],
});

describe('normative Latin encoding facts', () => {
  // Independently selected rows and footnotes from ISO 32000-1 Annex D.2;
  // byte values below are hexadecimal, while the specification prints octal.
  it.each([
    ['WinAnsiEncoding', 0x80, 'Euro', '\u20ac'], ['WinAnsiEncoding', 0x81, 'bullet', '\u2022'], ['WinAnsiEncoding', 0x7f, 'bullet', '\u2022'],
    ['WinAnsiEncoding', 0xe9, 'eacute', '\u00e9'], ['WinAnsiEncoding', 0xc4, 'Adieresis', '\u00c4'], ['WinAnsiEncoding', 0x9e, 'zcaron', '\u017e'],
    ['WinAnsiEncoding', 0xa0, 'space', '\u00a0'], ['WinAnsiEncoding', 0xad, 'hyphen', '\u00ad'], ['WinAnsiEncoding', 0x27, 'quotesingle', "'"],
    ['MacRomanEncoding', 0x80, 'Adieresis', '\u00c4'], ['MacRomanEncoding', 0x8e, 'eacute', '\u00e9'], ['MacRomanEncoding', 0xdb, 'currency', '\u00a4'],
    ['MacRomanEncoding', 0xca, 'space', '\u00a0'], ['MacRomanEncoding', 0xde, 'fi', '\ufb01'], ['MacRomanEncoding', 0xdf, 'fl', '\ufb02'],
    ['StandardEncoding', 0x27, 'quoteright', '\u2019'], ['StandardEncoding', 0x60, 'quoteleft', '\u2018'], ['StandardEncoding', 0xae, 'fi', '\ufb01'],
  ])('maps %s byte %i to the specified glyph and logical text', (encoding, code, name, text) => {
    expect(pdfLatinGlyphName(encoding, code)).toBe(name); expect(pdfLatinGlyphText(encoding, code)).toBe(text);
  });
  it('preserves duplicate-space/soft-hyphen meaning but lets explicit Differences change glyph identity', () => {
    expect(pdfLatinGlyphText('WinAnsiEncoding', 0x41, 'B')).toBe('B'); expect(pdfLatinGlyphText('MacRomanEncoding', 0xdb, 'Euro')).toBe('\u20ac');
    expect(pdfLatinGlyphText('WinAnsiEncoding', 0xa0, 'A')).toBe('A'); expect(pdfLatinGlyphText('WinAnsiEncoding', 0xad, 'B')).toBe('B');
    expect(pdfLatinGlyphName('MacRomanEncoding', 0xf0)).toBe('.notdef'); expect(pdfLatinGlyphText('MacRomanEncoding', 0xf0)).toBe('');
  });
  it.each([['WinAnsiEncoding', '80e9c4', '\u20ac\u00e9\u00c4', ['Euro', 'eacute', 'Adieresis']], ['MacRomanEncoding', '808edb', '\u00c4\u00e9\u00a4', ['Adieresis', 'eacute', 'currency']]])('paints actual licensed CFF glyph IDs for %s without substituting .notdef', async (encoding, hex, text, names) => {
    const value = await payload(originalPdf(encoding, hex)), source = parseCffFont(await loadAsset('standard_fonts/FoxitSerif.pfb')), metrics = readTrueTypeMetrics(value.fonts[0].bytes);
    expect(value.items[0].str).toBe(text); const glyphs = value.commands.find(c => c.op === 'text').glyphs;
    expect(glyphs.map(glyph => glyph.renderText)).toEqual(names.map(name => String.fromCodePoint(privateGlyphCode(source.byName.get(name)))));
    for (const [i, glyph] of glyphs.entries()) { expect(metrics.glyphId(glyph.renderText.codePointAt(0))).toBe(source.byName.get(names[i])); expect(glyph.systemText).toBe([...text][i]); }
  });
  it('keeps an explicit non-ASCII ToUnicode replacement logical while painting the encoded glyph', async () => {
    const value = await payload(originalPdf('WinAnsiEncoding', 'e9', 'begincmap 1 beginbfchar <e9> <0058> endbfchar endcmap'));
    expect(value.items[0].str).toBe('X'); expect(value.commands.find(c => c.op === 'text').glyphs[0].systemText).toBe('\u00e9');
  });
  it('keeps nonbreaking and discretionary text semantics separate from the standard TrueType source glyph', async () => {
    const value = await payload(simplePdf('BT /F1 20 Tf <a0ad> Tj ET', { font: '/Type /Font /Subtype /TrueType /BaseFont /ArialMT /Encoding /WinAnsiEncoding' }));
    const source = readTrueTypeMetrics(await loadAsset('standard_fonts/LiberationSans-Regular.ttf')), glyphs = value.commands.find(c => c.op === 'text').glyphs;
    expect(value.items[0].str).toBe('\u00a0-'); expect(glyphs.map(glyph => glyph.systemText)).toEqual([' ', '-']);
    expect(glyphs.map(glyph => glyph.renderText)).toEqual([' ', '-'].map(text => String.fromCodePoint(privateGlyphCode(source.glyphId(text.codePointAt(0))))));
  });
  it('does not invent host-encoding text for an unknown glyph in an original Type1 program', async () => {
    const clear = Buffer.from('/FontName /OwnType1 def /FontMatrix [.001 0 0 .001 0 0] def currentfile eexec\n');
    const plain = Buffer.concat([Buffer.alloc(4), Buffer.from('/lenIV -1 def /CharStrings 2 dict dup begin /.notdef 4 RD '),
      Buffer.from([139, 139, 13, 14]), Buffer.from(' ND /customIcon 5 RD '), Buffer.from([139, 248, 236, 13, 14]), Buffer.from(' ND end closefile')]);
    let seed = 55665; const encrypted = Uint8Array.from(plain, value => { const cipher = value ^ seed >> 8; seed = ((cipher + seed) * 52845 + 22719) & 65535; return cipher; });
    const data = simplePdf('BT /F1 12 Tf (A) Tj ET', { font: '/Type /Font /Subtype /Type1 /BaseFont /OwnType1 /FontDescriptor 6 0 R /Encoding << /BaseEncoding /MacRomanEncoding /Differences [65 /customIcon] >>',
      extra: ['<< /Type /FontDescriptor /FontFile 7 0 R >>', stream(Buffer.concat([clear, encrypted]), `/Length1 ${clear.length} /Length2 ${encrypted.length}`)] });
    const value = await payload(data); expect(value.items[0].str).not.toBe('A'); expect(value.inspection.unmappedGlyphs).toBe(1);
    expect(value.commands.find(c => c.op === 'text').glyphs[0].renderText).toBe(String.fromCodePoint(privateGlyphCode(1)));
  });
});

describe('embedded font descriptor validation before substitution', () => {
  it.each([['Type1', 'Times-Roman'], ['TrueType', 'ArialMT']])('treats optional null descriptor/program entries as absent for %s', async (subtype, base) => {
    for (const descriptor of ['null', '<< /Type /FontDescriptor /FontFile null /FontFile2 null /FontFile3 null >>']) {
      const value = await payload(simplePdf('BT /F1 12 Tf (A) Tj ET', { font: `/Type /Font /Subtype /${subtype} /BaseFont /${base} /FontDescriptor 6 0 R /Encoding /WinAnsiEncoding`, extra: [descriptor] }));
      expect(value.items[0].str).toBe('A'); expect(value.fonts[0].localFaces).toHaveLength(3);
    }
  });
  it.each([
    ['TrueType', '/FontFile 7 0 R'], ['Type1', '/FontFile2 7 0 R'], ['Type1', '/FontFile 7 0 R /FontFile2 8 0 R'],
    ['TrueType', '/FontFile2 7 0 R /FontFile3 8 0 R'], ['Type1', '/FontFile 7 0 R /FontFile3 8 0 R'],
  ])('rejects %s with %s without loading any substitute', async (subtype, fields) => {
    const read = vi.fn(loadAsset), data = simplePdf('BT /F1 12 Tf (A) Tj ET', { font: `/Type /Font /Subtype /${subtype} /BaseFont /ArialMT /FontDescriptor 6 0 R`,
      extra: [`<< /Type /FontDescriptor ${fields} >>`, stream('invalid'), stream('invalid', '/Subtype /Type1C')] });
    await expect(payload(data, { ...options, loadAsset: read })).rejects.toMatchObject({ code: 'pdf_corrupt' }); expect(read).not.toHaveBeenCalled();
  });
  it.each([['TrueType', 'Type1C'], ['Type1', 'CIDFontType0C'], ['TrueType', null]])('rejects incompatible or missing FontFile3 subtype %s/%s', async (subtype, format) => {
    const data = simplePdf('BT /F1 12 Tf (A) Tj ET', { font: `/Type /Font /Subtype /${subtype} /BaseFont /ArialMT /FontDescriptor 6 0 R`,
      extra: ['<< /Type /FontDescriptor /FontFile3 7 0 R >>', stream('invalid', format ? `/Subtype /${format}` : '')] });
    await expect(payload(data)).rejects.toMatchObject({ code: 'pdf_corrupt' });
  });
  it('rejects a conflicting CID font descriptor before choosing its preferred field', async () => {
    const data = simplePdf('BT /F1 12 Tf <0001> Tj ET', { font: '/Type /Font /Subtype /Type0 /BaseFont /OriginalCID /Encoding /Identity-H /DescendantFonts [6 0 R]',
      extra: ['<< /Type /Font /Subtype /CIDFontType2 /FontDescriptor 7 0 R >>', '<< /Type /FontDescriptor /FontFile2 8 0 R /FontFile3 9 0 R >>', stream('invalid'), stream('invalid', '/Subtype /CIDFontType0C')] });
    await expect(payload(data)).rejects.toMatchObject({ code: 'pdf_corrupt', message: expect.stringContaining('Multiple') });
  });
  it('rejects an indirect nonstream font program rather than falling back', async () => {
    const data = simplePdf('BT /F1 12 Tf (A) Tj ET', { font: '/Type /Font /Subtype /TrueType /BaseFont /ArialMT /FontDescriptor 6 0 R', extra: ['<< /Type /FontDescriptor /FontFile2 7 0 R >>', '<< /Subtype /TrueType >>'] });
    await expect(payload(data)).rejects.toMatchObject({ code: 'pdf_corrupt', message: expect.stringContaining('stream') });
  });
});
