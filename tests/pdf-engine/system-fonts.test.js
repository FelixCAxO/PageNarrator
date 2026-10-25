import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPdfDocumentCore } from '../../src/pdf/document-core.js';
import { openPdfDocument, renderPdfTextLayer } from '../../src/pdf/browser-pdf.js';
import { getDocument } from '../../src/pdf/pdf-engine.js';
import { renderPdfDisplayList } from '../../src/pdf/canvas-renderer.js';
import { createPdfViewport } from '../../src/pdf/viewport.js';
import { pdfLocalFontNames, pdfSystemGlyph } from '../../src/pdf/system-fonts.js';
import { simplePdf, show, stream, loadAsset, options } from './fixtures.js';

afterEach(() => vi.unstubAllGlobals());
const data = (font = '/Type /Font /Subtype /Type1 /BaseFont /Times-Roman /Encoding /WinAnsiEncoding') => simplePdf(show('A'), {
  font: `${font} /ToUnicode 6 0 R`, extra: [stream('begincmap 1 beginbfchar <41> <0058> endbfchar endcmap')],
});
async function payload(bytes) { const core = await createPdfDocumentCore(bytes, options); try { return await core.pagePayload(1); } finally { core.destroy(); } }
function browserFonts({ localAvailable = true, invalidData = false, pendingLocal = null } = {}) {
  const calls = [], retained = new Set();
  vi.stubGlobal('document', { fonts: { add: face => retained.add(face), delete: face => retained.delete(face) } });
  vi.stubGlobal('FontFace', class {
    constructor(family, source) { Object.assign(this, { family, source }); calls.push(this); }
    async load() {
      if (typeof this.source === 'string') { if (pendingLocal) await pendingLocal; if (!localAvailable) throw new Error('Local face unavailable.'); }
      else if (invalidData) throw new Error('Invalid embedded font.');
      return this;
    }
  });
  return { calls, retained };
}
function context() {
  return { canvas: { width: 612, height: 792 }, save() {}, restore() {}, setTransform() {}, transform() {}, fillRect() {}, beginPath() {}, scale() {},
    painted: [], fillText(text, x, y) { this.painted.push({ text, x, y, font: this.font }); } };
}

describe('bounded local standard font substitution', () => {
  it('allowlists standard Latin faces and excludes PDF-controlled names, Symbol, private and multi-scalar glyphs', () => {
    expect(pdfLocalFontNames('Times-Roman')).toEqual(['Times New Roman', 'TimesNewRomanPSMT', 'Liberation Serif']);
    for (const name of ['AAAAAA+Times-Roman', 'Evil"),url(https://example.test)', 'Symbol', 'ZapfDingbats']) expect(pdfLocalFontNames(name)).toBeUndefined();
    for (const value of [undefined, '', 'fi', '\u001f', '\u007f', '\ue000', '\ud800', String.fromCodePoint(0xf0000)]) expect(pdfSystemGlyph(value)).toBeUndefined();
    expect(pdfSystemGlyph('\ufb01')).toBe('\ufb01'); expect(pdfSystemGlyph('A')).toBe('A');
  });
  it.each(['/Type /Font /Subtype /Type1 /BaseFont /Times-Roman /Encoding /WinAnsiEncoding', '/Type /Font /Subtype /TrueType /BaseFont /ArialMT /Encoding /WinAnsiEncoding'])('keeps encoded paint separate from logical ToUnicode with %s', async font => {
    const value = await payload(data(font)), glyph = value.commands.find(command => command.op === 'text').glyphs[0];
    expect(value.items[0].str).toBe('X'); expect(glyph).toMatchObject({ text: 'X', systemText: 'A' }); expect(value.fonts[0].localFaces).toHaveLength(3);
  });
  it('uses a CFF Encoding Differences glyph name before ToUnicode and does not invent unknown glyph paint', async () => {
    const known = await payload(data('/Type /Font /Subtype /Type1 /BaseFont /Times-Roman /Encoding << /BaseEncoding /WinAnsiEncoding /Differences [65 /B] >>'));
    expect(known.commands.find(command => command.op === 'text').glyphs[0]).toMatchObject({ text: 'X', systemText: 'B' });
    for (const name of ['customIcon', 'u1F600']) {
      const unknown = await payload(data(`/Type /Font /Subtype /Type1 /BaseFont /Times-Roman /Encoding << /Differences [65 /${name}] >>`));
      const glyph = unknown.commands.find(command => command.op === 'text').glyphs[0];
      expect(glyph.systemText).toBeUndefined(); expect(glyph.renderText).toBe(String.fromCodePoint(0xf0000));
    }
  });
  it('never substitutes an embedded font even when BaseFont names an allowed system font', async () => {
    const value = await payload(simplePdf(show('A'), { font: '/Type /Font /Subtype /TrueType /BaseFont /ArialMT /Encoding /WinAnsiEncoding /FontDescriptor 6 0 R',
      extra: ['<< /Type /FontDescriptor /FontFile2 7 0 R >>', stream(await loadAsset('standard_fonts/LiberationSans-Regular.ttf'))] }));
    expect(value.fonts[0].localFaces).toBeUndefined(); expect(value.commands.find(command => command.op === 'text').glyphs[0].systemText).toBeUndefined();
  });
  it('rejects unsupported embedded FontFile3 data rather than substituting a standard face', async () => {
    const source = simplePdf(show('A'), { font: '/Type /Font /Subtype /Type1 /BaseFont /Times-Roman /FontDescriptor 6 0 R',
      extra: ['<< /Type /FontDescriptor /FontFile3 7 0 R >>', stream('invalid', '/Subtype /OpenType')] });
    await expect(payload(source)).rejects.toMatchObject({ code: 'pdf_unsupported', message: expect.stringContaining('FontFile3') });
  });
  it.each(['Type1 /BaseFont /Times-Roman', 'TrueType /BaseFont /ArialMT'])('paints and advances encoded glyphs with empty ToUnicode in %s', async font => {
    const source = simplePdf(show('AA'), { font: `/Type /Font /Subtype /${font} /Encoding /WinAnsiEncoding /ToUnicode 6 0 R`,
      extra: [stream('begincmap 1 beginbfchar <41> <> endbfchar endcmap')] });
    const value = await payload(source), command = value.commands.find(c => c.op === 'text');
    expect(value.items).toHaveLength(0); expect(command.glyphs).toHaveLength(2);
    expect(command.glyphs.map(glyph => glyph.systemText)).toEqual(['A', 'A']); expect(command.glyphs[1].x).toBeGreaterThan(0);
    for (const glyph of command.glyphs) expect(glyph.renderText.codePointAt(0)).toBeGreaterThanOrEqual(0xf0000);
  });
  it.each([false, true])('honors useSystemFonts=%s through the app facade and releases every registered face', async useSystemFonts => {
    const fonts = browserFonts(), task = getDocument({ data: data(), ...options, useSystemFonts });
    try {
      const document = await task.promise, page = await document.getPage(1), ctx = context();
      await page.render({ canvasContext: ctx, viewport: page.getViewport() }).promise;
      expect(fonts.calls).toHaveLength(useSystemFonts ? 2 : 1); expect(fonts.retained.size).toBe(useSystemFonts ? 2 : 1);
      const family = (await page.getTextContent()).items[0].fontName;
      expect(page.getFontFamily(family)).toBe(`${family}${useSystemFonts ? 'Local' : ''}`);
      if (useSystemFonts) expect(ctx.painted[0].text).toBe('A'); else expect(ctx.painted[0].text.codePointAt(0)).toBeGreaterThanOrEqual(0xf0000);
      expect(ctx.painted[0].text).not.toBe('X');
      expect(ctx.painted[0].font).toBe(`1px "${page.getFontFamily(family)}"`);
    } finally { await task.destroy(); }
    expect(fonts.retained.size).toBe(0);
  });
  it('retains licensed fallback data if local() fails, but propagates data-font rejection', async () => {
    const fonts = browserFonts({ localAvailable: false }), document = await openPdfDocument(data(), { ...options, useSystemFonts: true });
    try { await (await document.getPage(1)).ensureFonts(); expect(fonts.calls).toHaveLength(2); expect(fonts.retained.size).toBe(1); } finally { document.destroy(); }
    expect(fonts.retained.size).toBe(0);
    const invalid = browserFonts({ invalidData: true }), broken = await openPdfDocument(data(), { ...options, useSystemFonts: true });
    try { await expect((await broken.getPage(1)).ensureFonts()).rejects.toThrow('Invalid embedded font.'); expect(invalid.calls).toHaveLength(1); } finally { broken.destroy(); }
    expect(invalid.retained.size).toBe(0);
  });
  it.each([false, true])('keeps licensed TrueType source glyph paint when useSystemFonts=%s and local faces are unavailable', async useSystemFonts => {
    const fonts = browserFonts({ localAvailable: false }), document = await openPdfDocument(data('/Type /Font /Subtype /TrueType /BaseFont /ArialMT /Encoding /WinAnsiEncoding'), { ...options, useSystemFonts });
    try {
      const page = await document.getPage(1), ctx = context(), content = await page.getTextContent();
      await page.render({ canvasContext: ctx, viewport: page.getViewport() }).promise;
      expect(content.items[0].str).toBe('X'); expect(ctx.painted[0].text.codePointAt(0)).toBeGreaterThanOrEqual(0xf0000);
      expect(ctx.painted[0].text).not.toBe('X'); expect(fonts.calls).toHaveLength(useSystemFonts ? 2 : 1);
    } finally { document.destroy(); }
    expect(fonts.retained.size).toBe(0);
  });
  it('does not register a late local face after destroy', async () => {
    let release; const pendingLocal = new Promise(resolve => { release = resolve; }), fonts = browserFonts({ pendingLocal });
    const document = await openPdfDocument(data(), { ...options, useSystemFonts: true }), page = await document.getPage(1), loading = page.ensureFonts();
    await vi.waitFor(() => expect(fonts.calls).toHaveLength(2)); document.destroy(); release();
    await expect(loading).rejects.toMatchObject({ code: 'pdf_closed' }); expect(fonts.retained.size).toBe(0);
  });
  it('switches per source glyph without changing supplied coordinates or painting logical replacement text', async () => {
    const ctx = context(), glyphs = [{ text: 'X', renderText: '\ue001', systemText: 'A', x: 0 }, { text: 'icon', renderText: '\ue002', x: .75 }, { text: 'Z', renderText: '\ue003', systemText: 'B', x: 1.5 }];
    await renderPdfDisplayList({ fonts: [], commands: [{ op: 'text', font: 'data', glyphs, matrix: [12, 0, 0, 12, 0, 0], fill: 'black' }] },
      { canvasContext: ctx, viewport: createPdfViewport([0, 0, 612, 792]), resolveFont: () => 'local' }).promise;
    expect(ctx.painted).toEqual([{ text: 'A', x: 0, y: 0, font: '1px "local"' }, { text: '\ue002', x: .75, y: 0, font: '1px "data"' }, { text: 'B', x: 1.5, y: 0, font: '1px "local"' }]);
  });
  it('uses the resolved face for selectable source text metrics while preserving logical Unicode', async () => {
    const measured = [], spans = [], ctx = { measureText(text) { measured.push([text, this.font]); return { width: 8 }; } };
    const document = { createElement(name) { return name === 'canvas' ? { getContext: () => ctx } : { style: {}, setAttribute() {} }; } };
    const container = { ownerDocument: document, style: {}, setAttribute() {}, replaceChildren() {}, append: span => spans.push(span) };
    const item = { str: 'X', transform: [12, 0, 0, 12, 54, 700], width: 8, fontName: 'data', dir: 'ltr' };
    await renderPdfTextLayer({ page: { ensureFonts: async () => {}, getFontFamily: () => 'local' }, textContentSource: { items: [item] }, container, viewport: createPdfViewport([0, 0, 612, 792]) });
    expect(measured).toEqual([['X', '12px "local"']]); expect(spans[0].textContent).toBe('X'); expect(spans[0].style.fontFamily).toBe('"local"');
  });
});
