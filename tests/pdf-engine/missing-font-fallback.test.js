import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { createPdfDocumentCore } from '../../src/pdf/document-core.js';
import { openPdfDocument } from '../../src/pdf/browser-pdf.js';
import { annotatePdfTextLayer, extractPdfTextFromData, readPdfPageRecord } from '../../src/lib/pdf-extraction.js';
import { createPdfPagePlaceholder, createVirtualPdfPageRenderer } from '../../src/lib/pdf-viewer-rendering.js';
import { createPdfSelectionFromSelection } from '../../src/lib/pdf-selection.js';
import { simplePdf, stream, loadAsset, options } from './fixtures.js';

async function payload(data, settings = {}) {
  const core = await createPdfDocumentCore(data, { ...options, ...settings });
  try { return await core.pagePayload(1); } finally { core.destroy(); }
}
function simple({ name = 'UnknownFont', subtype = 'TrueType', encoding = '/WinAnsiEncoding', widths = '/FirstChar 65 /LastChar 66 /Widths [321 654]', flags = 32, unicode = null, content = '(AB)', program = null, mode = 0 } = {}) {
  return simplePdf(`BT /F1 20 Tf ${mode} Tr 1 0 0 1 50 700 Tm ${content} Tj ET`, {
    font: `/Type /Font /Subtype /${subtype} /BaseFont /${name} ${encoding ? `/Encoding ${encoding}` : ''} ${widths} /FontDescriptor 6 0 R ${unicode !== null ? '/ToUnicode 7 0 R' : ''}`,
    extra: [`<< /Type /FontDescriptor /Flags ${flags} ${program ? '/FontFile2 8 0 R' : ''} >>`, stream(unicode ?? 'begincmap endcmap'), ...(program ? [stream(program)] : [])],
  });
}
function composite({ encoding = 'Identity-H', unicode = 'begincmap 2 beginbfchar <0001> <4e2d> <0002> <6587> endbfchar endcmap', content = '<00010002>', collection = '/Registry (Adobe) /Ordering (Identity) /Supplement 0', widths = '/DW 1000 /W [1 [700 900]]', mode = 0 } = {}) {
  return simplePdf(`BT /F1 20 Tf ${mode} Tr 1 0 0 1 50 700 Tm ${content} Tj ET`, {
    font: `/Type /Font /Subtype /Type0 /BaseFont /UnknownCJK /Encoding /${encoding} /DescendantFonts [6 0 R] ${unicode !== null ? '/ToUnicode 7 0 R' : ''}`,
    extra: [`<< /Type /Font /Subtype /CIDFontType2 /BaseFont /UnknownCJK /CIDSystemInfo << ${collection} >> ${widths} >>`, ...(unicode !== null ? [stream(unicode)] : [])],
  });
}
const substitution = { filter: 'FontSubstitution', sourceFont: 'UnknownFont', replacement: 'LiberationSans-Regular.ttf' };

describe('missing PDF font fallback', () => {
  it('delivers narratable speech through the app extraction pipeline with an unfamiliar font', async () => {
    const article = await extractPdfTextFromData(simple({ content: '(Narration continues with a missing font.)', widths: '' }), {
      wasmUrl: new URL('../../engines/native/pdf.wasm', import.meta.url).href,
      standardFontDataUrl: new URL('../../engines/vendor/pdf-data/standard_fonts/', import.meta.url).href,
    });
    expect(article.text).toBe('Narration continues with a missing font.');
    expect(article.chunks[0].speech).toBe('Narration continues with a missing font.');
  });
  it.each(['Type1', 'TrueType'])('narrates unfamiliar unembedded %s fonts using PDF text and advances', async subtype => {
    const actual = await payload(simple({ subtype }));
    expect(actual.items[0]).toMatchObject({ str: 'AB', width: 19.5 });
    expect(actual.commands.find(c => c.op === 'text').glyphs[1].x).toBeCloseTo(.321);
    expect(actual.inspection.decodingWarnings).toContainEqual(substitution);
    expect(actual.inspection.unmappedGlyphs).toBe(0);
    expect(actual.fonts[0].localFaces).toBeUndefined();
  });
  it.each(['CustomVerdana', 'AAAAAA+Verdana', 'UnknownLatin', '#E5#AE#8B#E4#BD#93', '__proto__', 'constructor'])('does not depend on the font name %s', async name => {
    expect((await payload(simple({ name }))).items[0].str).toBe('AB');
  });
  it('keeps Unicode semantics, including ligatures and empty mappings, separate from source paint', async () => {
    const actual = await payload(simple({ unicode: 'begincmap 2 beginbfchar <41> <00660069> <42> <> endbfchar endcmap' }));
    expect(actual.items[0]).toMatchObject({ str: 'fi', width: 19.5 });
    expect(actual.inspection.unmappedGlyphs).toBe(0);
  });
  it.each([['/MacRomanEncoding', '<80>', 'Ä'], ['<< /BaseEncoding /WinAnsiEncoding /Differences [65 /B] >>', '(A)', 'B'], ['', '(AB)', 'AB']])('honors the declared simple encoding %s', async (encoding, content, expected) => {
    expect((await payload(simple({ encoding, content, widths: '' }))).items[0].str).toBe(expected);
  });
  it('uses substitute metrics when the PDF does not supply glyph widths', async () => {
    const actual = await payload(simple({ widths: '' }));
    expect(actual.items[0].str).toBe('AB'); expect(actual.items[0].width).toBeGreaterThan(0);
  });
  it.each([['Unknown-Bold', 32, 'LiberationSans-Bold.ttf'], ['Unknown-Italic', 32, 'LiberationSans-Italic.ttf'], ['UnknownFont', 262208, 'LiberationSans-BoldItalic.ttf']])('selects a usable visual style for %s with descriptor flags %i', async (name, flags, replacement) => {
    const actual = await payload(simple({ name, flags }));
    expect(actual.items[0].str).toBe('AB');
    expect(actual.inspection.decodingWarnings).toContainEqual({ ...substitution, sourceFont: name, replacement });
  });
  it('uses Unicode for custom glyph names without losing narration when paint is unavailable', async () => {
    const actual = await payload(simple({ encoding: '<< /Differences [65 /customGlyph] >>', content: '(A)', unicode: 'begincmap 1 beginbfchar <41> <4e2d> endbfchar endcmap' }));
    expect(actual.items[0].str).toBe('中'); expect(actual.inspection.unmappedGlyphs).toBe(0);
  });
  describe.each([['TrueType', '4e2d', '中'], ['Type1', '4e2d', '中'], ['TrueType', '0e01', 'ก'], ['Type1', '0905', 'अ']])('missing simple %s outline for U+%s', (subtype, unicode, text) => {
    it.each([1, 2, 4, 5, 6, 7])('recovers mapped text with its source width in mode %i', async mode => {
      const data = simple({ subtype, mode, encoding: '<< /Differences [65 /customGlyph] >>', content: '(A)',
        unicode: `begincmap 1 beginbfchar <41> <${unicode}> endbfchar endcmap` });
      await expect(payload(data).then(() => 'painted', error => error.code)).resolves.toBe('pdf_unsupported');
      const actual = await payload(data, { recoverUnsupportedArtwork: true });
      expect(actual.inspection).toMatchObject({ textOnly: true, unmappedGlyphs: 0,
        artworkWarnings: [{ kind: 'page', code: 'pdf_unsupported' }] });
      expect(actual.items[0]).toMatchObject({ str: text, transform: [20, 0, 0, 20, 50, 700] });
      expect(actual.items[0].width).toBeCloseTo(6.42);
      expect(actual.commands.some(c => c.op === 'textClip')).toBe(false);
    });
  });
  it.each([{ flags: 4, encoding: '' }, { encoding: '/CustomEncoding' }, { encoding: '<< /Differences [65 /customGlyph] >>' }])('flags missing character mappings for OCR instead of fabricating speech: %j', async settings => {
    const actual = await payload(simple({ ...settings, content: '(A)' }));
    expect(actual.inspection.unmappedGlyphs).toBe(1); expect(actual.items[0].str).not.toBe('A');
  });
  it('uses explicit Unicode even with an unfamiliar encoding name', async () => {
    expect((await payload(simple({ encoding: '/CustomEncoding', unicode: 'begincmap 2 beginbfchar <41> <0058> <42> <0059> endbfchar endcmap' }))).items[0].str).toBe('XY');
  });
  it.each([1, 2, 4, 7])('retains narration through outlined/clipped text mode %i', async mode => {
    expect((await payload(simple({ mode }))).items[0].str).toBe('AB');
  });
  it.each([1, 2, 4, 5, 6, 7])('retains available simple substitute outlines and source advances in mode %i', async mode => {
    const actual = await payload(simple({ mode }), { recoverUnsupportedArtwork: true });
    expect(actual.inspection.textOnly).toBeUndefined();
    expect(actual.items[0]).toMatchObject({ str: 'AB', width: 19.5 });
    const glyphs = actual.commands.find(c => c.op === 'text')?.glyphs
      || actual.commands.find(c => c.op === 'textClip').groups[0].glyphs;
    expect(glyphs[1].x).toBe(.321);
    expect(glyphs.every(glyph => glyph.outline.length > 0)).toBe(true);
    expect(glyphs[0].outline).not.toEqual(glyphs[1].outline);
  });
  it('never substitutes corrupt embedded font data', async () => {
    await expect(payload(simple({ program: new Uint8Array([0, 1, 2, 3]) }))).rejects.toMatchObject({ code: 'pdf_unsupported', message: expect.stringContaining('embedded font') });
    const program = await loadAsset('standard_fonts/LiberationSans-Italic.ttf');
    expect((await payload(simple({ program }))).inspection.decodingWarnings).not.toContainEqual(substitution);
  });
  it('still rejects corrupt glyph widths and Unicode mappings', async () => {
    await expect(payload(simple({ widths: '/FirstChar 65 /LastChar 66 /Widths [321 /bad]' }))).rejects.toMatchObject({ code: 'pdf_corrupt' });
    await expect(payload(simple({ unicode: 'begincmap 1 beginbfchar <41> <d800> endbfchar endcmap' }))).rejects.toMatchObject({ code: 'pdf_corrupt' });
  });
  it('narrates composite fonts from explicit Unicode without treating CIDs as glyph indices', async () => {
    const actual = await payload(composite());
    expect(actual.items[0]).toMatchObject({ str: '中文', width: 32 }); expect(actual.inspection.unmappedGlyphs).toBe(0);
    expect(actual.inspection.decodingWarnings).toContainEqual({ ...substitution, sourceFont: 'UnknownCJK' });
    expect(actual.fonts[0].requiresLocalFace).toBeUndefined();
  });
  it.each([1, 2, 4, 5, 6, 7])('recovers missing CJK substitute outlines instead of painting notdef in mode %i', async mode => {
    const data = composite({ mode });
    await expect(payload(data)).rejects.toMatchObject({ code: 'pdf_unsupported' });
    const actual = await payload(data, { recoverUnsupportedArtwork: true });
    expect(actual.inspection).toMatchObject({ textOnly: true, unmappedGlyphs: 0,
      artworkWarnings: [{ kind: 'page', code: 'pdf_unsupported' }] });
    expect(actual.items[0]).toMatchObject({ str: '中文', width: 32, transform: [20, 0, 0, 20, 50, 700] });
    expect(actual.commands.find(c => c.op === 'text').glyphs).toMatchObject([
      { text: '中', x: 0 }, { text: '文', x: .7 },
    ]);
    expect(actual.commands.some(c => c.op === 'textClip')).toBe(false);
  });
  it.each([1, 2, 4, 5, 6, 7])('keeps available Latin substitute outlines and source widths in mode %i', async mode => {
    const actual = await payload(composite({ mode, unicode: 'begincmap 2 beginbfchar <0001> <0041> <0002> <0042> endbfchar endcmap' }), { recoverUnsupportedArtwork: true });
    expect(actual.inspection.textOnly).toBeUndefined();
    expect(actual.items[0]).toMatchObject({ str: 'AB', width: 32 });
    const glyphs = actual.commands.find(c => c.op === 'text')?.glyphs
      || actual.commands.find(c => c.op === 'textClip').groups[0].glyphs;
    expect(glyphs[1].x).toBe(.7);
    expect(glyphs.every(glyph => glyph.outline.length > 0)).toBe(true);
    expect(glyphs[0].outline).not.toEqual(glyphs[1].outline);
  });
  it('keeps recovered CJK narration selectable without loading unavailable browser fonts', async () => {
    const document = await openPdfDocument(composite({ mode: 4 }), options);
    const dom = new JSDOM('<!doctype html><main></main>');
    const renderer = createVirtualPdfPageRenderer({ documentRef: dom.window.document,
      windowRef: dom.window, pdfjs: {}, annotateTextLayer: annotatePdfTextLayer });
    try {
      expect(await (await document.getPage(1)).getTextContent()).toMatchObject({ textOnly: true });
      expect((await readPdfPageRecord(document, 1)).model.speech).toBe('中文.');
      const pageEl = createPdfPagePlaceholder(dom.window.document, 1, { width: 612, height: 792 });
      dom.window.document.querySelector('main').append(pageEl);
      await renderer.ensurePageRendered(document, pageEl, 1);
      const layer = pageEl.querySelector('.pdf-readable-text');
      expect(layer.textContent.trim()).toBe('中文');
      expect(pageEl.querySelector('canvas')).toBeNull();
      expect(layer.querySelector('span').dataset.pagenarratorPdfSourceIndex).toBe('0');
      const range = dom.window.document.createRange(); range.selectNodeContents(layer);
      const selection = dom.window.getSelection(); selection.addRange(range);
      expect(createPdfSelectionFromSelection(selection, { documentRef: dom.window.document, pageCount: 1 }))
        .toMatchObject({ text: '中文', pageNumber: 1, chunks: [{ speech: '中文', anchorId: 'pdf-page-1' }] });
    } finally { renderer.destroy(); document.destroy(); dom.window.close(); }
  });
  it('uses canonical CID character maps for unfamiliar CJK font names', async () => {
    const actual = await payload(composite({ encoding: 'GBK-EUC-H', unicode: null, content: '<d6d0cec4>', collection: '/Registry (Adobe) /Ordering (GB1) /Supplement 2', widths: '/DW 1000' }));
    expect(actual.items[0].str).toBe('中文'); expect(actual.inspection.unmappedGlyphs).toBe(0);
  });
  it('preserves composite vertical writing metrics', async () => {
    const actual = await payload(composite({ encoding: 'Identity-V' }));
    expect(actual.items[0]).toMatchObject({ str: '中文', vertical: true, dir: 'ttb' });
  });
  it('flags an unmapped CID for OCR and rejects truncated source codes', async () => {
    expect((await payload(composite({ unicode: null }))).inspection.unmappedGlyphs).toBe(2);
    await expect(payload(composite({ content: '<00>' }))).rejects.toMatchObject({ code: 'pdf_corrupt' });
  });
});
