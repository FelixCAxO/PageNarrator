import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import * as reference from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createPdfDocumentCore } from '../../src/pdf/document-core.js';
import { readTrueTypeMetrics } from '../../src/pdf/font-metrics.js';
import { privateGlyphCode } from '../../src/pdf/font-container.js';
import { renderPdfDisplayList } from '../../src/pdf/canvas-renderer.js';
import { renderPdfTextLayer } from '../../src/pdf/browser-pdf.js';
import { createPdfViewport } from '../../src/pdf/viewport.js';
import { simplePdf, stream, loadAsset, options } from './fixtures.js';
import { miniatureCidCff, verticalCidCffPdf } from './cmap-cff-fixture.js';
import { parseCffFont } from '../../src/pdf/cff-font.js';

async function cidPdf(content, { encoding = 'Identity-H', encodingData = null, encodingDictionary = '', unicode = null, system = 'Identity', widths = '', vertical = '', mapping = null, fontBytes = null } = {}) {
  const font = fontBytes ?? await loadAsset('standard_fonts/LiberationSans-Regular.ttf');
  return simplePdf(content, { font: `/Type /Font /Subtype /Type0 /BaseFont /OriginalCID /Encoding ${encodingData ? '11 0 R' : `/${encoding}`} /DescendantFonts [6 0 R] ${unicode ? '/ToUnicode 9 0 R' : ''}`,
    extra: [`<< /Type /Font /Subtype /CIDFontType2 /BaseFont /OriginalCID /CIDSystemInfo << /Registry (Adobe) /Ordering (${system}) /Supplement 7 >> /FontDescriptor 7 0 R /DW 1000 ${widths} ${vertical} ${mapping ? '/CIDToGIDMap 10 0 R' : ''} >>`,
      '<< /Type /FontDescriptor /FontName /OriginalCID /Flags 4 /FontBBox [-500 -500 1500 1500] /Ascent 1000 /Descent -200 /StemV 80 /FontFile2 8 0 R >>', stream(font), stream(unicode ?? 'begincmap endcmap'), stream(mapping ?? new Uint8Array()), stream(encodingData ?? 'begincmap endcmap', encodingDictionary)] });
}
async function payload(data) { const core = await createPdfDocumentCore(data, options); try { return await core.pagePayload(1); } finally { core.destroy(); } }
async function referenceText(data) {
  const task = reference.getDocument({ data: data.slice(), cMapUrl: fileURLToPath(new URL('../../node_modules/pdfjs-dist/cmaps/', import.meta.url)).replaceAll('\\', '/'), cMapPacked: true, disableFontFace: true });
  try { const document = await task.promise; return (await (await document.getPage(1)).getTextContent()).items; } finally { await task.destroy(); }
}
const putGlyph = (bytes, cid, gid) => { bytes[cid * 2] = gid >>> 8; bytes[cid * 2 + 1] = gid & 255; };
function withoutCmap(bytes) {
  const out = bytes.slice(), view = new DataView(out.buffer), rows = [];
  for (let i = 0; i < view.getUint16(4); i++) {
    const row = 12 + i * 16;
    if (String.fromCharCode(...out.subarray(row, row + 4)) !== 'cmap') rows.push(out.slice(row, row + 16));
  }
  view.setUint16(4, rows.length); rows.forEach((row, i) => out.set(row, 12 + i * 16)); return out;
}

describe('CID source associations and vertical metrics', () => {
  it('uses Identity CID glyphs and ToUnicode when an embedded TrueType subset omits cmap', async () => {
    const source = await loadAsset('standard_fonts/LiberationSans-Regular.ttf'), metrics = readTrueTypeMetrics(source);
    const a = metrics.glyphId(65), b = metrics.glyphId(66), hex = gid => gid.toString(16).padStart(4, '0');
    const fontBytes = withoutCmap(source), unchanged = fontBytes.slice();
    const data = await cidPdf(`BT /F1 12 Tf <${hex(a)}${hex(b)}> Tj ET`, { fontBytes, widths: `/W [${a} [500] ${b} [800]]`,
      unicode: `begincmap 2 beginbfchar <${hex(a)}> <03A9> <${hex(b)}> <0416> endbfchar endcmap` });
    const actual = await payload(data), converted = readTrueTypeMetrics(actual.fonts[0].bytes);
    expect(actual.items[0].str).toBe('ΩЖ'); expect(actual.items[0].width).toBeCloseTo(15.6, 8);
    expect(actual.inspection.unmappedGlyphs).toBe(0); expect(fontBytes).toEqual(unchanged);
    expect(actual.commands.find(command => command.op === 'text').glyphs.map(glyph => glyph.renderText)).toEqual([a, b].map(gid => String.fromCodePoint(privateGlyphCode(gid))));
    expect(converted.glyphId(0x03a9)).toBe(a); expect(converted.glyphId(0x0416)).toBe(b);
    expect(converted.ascent).toBe(metrics.ascent); expect(converted.descent).toBe(metrics.descent);
    expect((await referenceText(data)).map(item => item.str).join('')).toBe('ΩЖ');
  });
  it('keeps nonidentity CIDToGIDMap and multi-character ToUnicode independent of an omitted font cmap', async () => {
    const source = await loadAsset('standard_fonts/LiberationSans-Regular.ttf'), metrics = readTrueTypeMetrics(source), a = metrics.glyphId(65), b = metrics.glyphId(66);
    const mapping = new Uint8Array(200); putGlyph(mapping, 12, b); putGlyph(mapping, 99, a);
    const data = await cidPdf('BT /F1 12 Tf <000C0063> Tj ET', { fontBytes: withoutCmap(source), mapping, widths: '/W [12 [400] 99 [700]]',
      unicode: 'begincmap 2 beginbfchar <000C> <0058> <0063> <00660069> endbfchar endcmap' });
    const actual = await payload(data), converted = readTrueTypeMetrics(actual.fonts[0].bytes);
    expect(actual.items[0].str).toBe('Xfi'); expect(actual.items[0].width).toBeCloseTo(13.2, 8);
    expect(actual.commands.find(command => command.op === 'text').glyphs.map(glyph => glyph.renderText)).toEqual([b, a].map(gid => String.fromCodePoint(privateGlyphCode(gid))));
    expect(converted.glyphId(88)).toBe(b); expect(converted.glyphId(privateGlyphCode(a))).toBe(a);
    expect(converted.glyphId(102)).toBe(0); // Multi-character text is not a single-glyph alias.
    expect((await referenceText(data)).map(item => item.str).join('')).toBe('Xfi');
  });
  it('retains exact CID outlines without inventing Unicode when both cmap and text maps are absent', async () => {
    const source = await loadAsset('standard_fonts/LiberationSans-Regular.ttf'), gid = readTrueTypeMetrics(source).glyphId(65);
    const actual = await payload(await cidPdf(`BT /F1 12 Tf 1 Tr <${gid.toString(16).padStart(4, '0')}> Tj ET`, { fontBytes: withoutCmap(source) }));
    expect(actual.inspection.unmappedGlyphs).toBe(1);
    expect(actual.items[0].str).toBe(String.fromCodePoint(privateGlyphCode(gid)));
    const glyph = actual.commands.find(command => command.op === 'text').glyphs[0];
    expect(glyph.renderText).toBe(String.fromCodePoint(privateGlyphCode(gid)));
    expect(glyph.outline).toHaveLength(21); expect(glyph.fontMatrix).toEqual([1 / 2048, 0, 0, 1 / 2048, 0, 0]);
  });
  it('continues rejecting a simple embedded TrueType font without cmap', async () => {
    const fontBytes = withoutCmap(await loadAsset('standard_fonts/LiberationSans-Regular.ttf'));
    expect(() => readTrueTypeMetrics(fontBytes)).toThrow(/Missing font cmap/);
    await expect(payload(simplePdf('BT /F1 12 Tf (A) Tj ET', { font: '/Type /Font /Subtype /TrueType /BaseFont /NoCmap /FontDescriptor 6 0 R',
      extra: ['<< /Type /FontDescriptor /FontFile2 7 0 R >>', stream(fontBytes)] }))).rejects.toMatchObject({ code: 'pdf_corrupt', message: 'Missing font cmap table.' });
  });
  it('executes an original CID-keyed CFF program through vertical named encoding without ToUnicode', async () => {
    const cff = parseCffFont(miniatureCidCff()); expect(cff.cid).toBe(true); expect([...cff.byCid]).toEqual([[0, 0], [264, 1], [7887, 2]]);
    const data = verticalCidCffPdf(), actual = await payload(data), independent = await referenceText(data);
    expect(actual.items.map(item => item.str)).toEqual(['A、A', 'A、']);
    expect(actual.items.map(item => item.height)).toEqual([90, 60]); expect(actual.inspection.unmappedGlyphs).toBe(0);
    expect(actual.commands.filter(command => command.op === 'text')[0].glyphs.map(glyph => glyph.renderText)).toEqual([String.fromCodePoint(privateGlyphCode(1)), String.fromCodePoint(privateGlyphCode(2)), String.fromCodePoint(privateGlyphCode(1))]);
    expect(independent.map(item => item.str).join('')).toBe('A、AA、');
    expect(independent[0]).toMatchObject({ dir: 'ttb', height: 90, transform: [30, 0, 0, 30, 400, 700] });
  });
  it('extracts missing-ToUnicode Identity text through the actual embedded Unicode glyph cmap', async () => {
    const metrics = readTrueTypeMetrics(await loadAsset('standard_fonts/LiberationSans-Regular.ttf')), gid = metrics.glyphId(65);
    expect(metrics.unicodeForGlyph(gid)).toBe('A');
    const data = await cidPdf(`BT /F1 12 Tf <${gid.toString(16).padStart(4, '0')}> Tj ET`), actual = await payload(data);
    expect(actual.items[0].str).toBe('A'); expect(actual.inspection.unmappedGlyphs).toBe(0);
    // The independent reference echoes CID36 as '$' here. The actual declared GID36
    // is 'A' in the retained font's Unicode cmap; this fallback is not reference parity.
    expect((await referenceText(data)).map(item => item.str).join('')).toBe('$');
  });
  it('maps variable source bytes to CIDs, Unicode records, PDF widths and declared glyph IDs independently', async () => {
    const metrics = readTrueTypeMetrics(await loadAsset('standard_fonts/LiberationSans-Regular.ttf')), mapping = new Uint8Array(1270);
    putGlyph(mapping, 264, metrics.glyphId(65)); putGlyph(mapping, 634, metrics.glyphId(66));
    const data = await cidPdf('BT /F1 12 Tf <418141> Tj ET', { encoding: '90ms-RKSJ-H', system: 'Japan1', widths: '/W [264 [500] 634 [700]]', mapping });
    const actual = await payload(data), glyphs = actual.commands.find(command => command.op === 'text').glyphs;
    expect(actual.items[0].str).toBe('A、'); expect(actual.items[0].width).toBeCloseTo(14.4, 8);
    expect(glyphs.map(glyph => glyph.renderText)).toEqual([String.fromCodePoint(privateGlyphCode(metrics.glyphId(65))), String.fromCodePoint(privateGlyphCode(metrics.glyphId(66)))]);
    expect((await referenceText(data)).map(item => item.str).join('')).toBe('A、');
  });
  it('uses vertical code substitutions and W2/DW2 advances with the correct unscaled Y displacement', async () => {
    const metrics = readTrueTypeMetrics(await loadAsset('standard_fonts/LiberationSans-Regular.ttf')), mapping = new Uint8Array(15776);
    putGlyph(mapping, 264, metrics.glyphId(65)); putGlyph(mapping, 7887, metrics.glyphId(66));
    const data = await cidPdf('BT /F1 10 Tf 50 Tz 1 0 0 1 100 200 Tm <418141> Tj <41> Tj ET', { encoding: '90ms-RKSJ-V', system: 'Japan1', mapping,
      vertical: '/DW2 [880 -1000] /W2 [264 [-1000 250 900] 7887 7887 -1200 500 800]' });
    const actual = await payload(data), first = actual.items[0], paints = actual.commands.filter(command => command.op === 'text');
    expect(first).toMatchObject({ str: 'A、', vertical: true, dir: 'ttb', width: 5, height: 22, transform: [5, 0, 0, 10, 100, 200] });
    expect(paints[0].glyphs.map(({ x, y }) => [x, y])).toEqual([[-.25, -.9], [-.5, -1.8]]);
    expect(actual.items[1].transform[5]).toBe(178); expect(actual.fonts[0].vertical).toBe(true);
    const expected = await referenceText(data);
    expect(expected.map(item => item.str).join('')).toBe('A、A');
    expect(expected[0]).toMatchObject({ dir: 'ttb', width: 5, height: 32, transform: [5, 0, 0, 10, 100, 200] });
  });
  it('applies TJ adjustments along the writing direction and word spacing only to one-byte source32', async () => {
    const unicode = 'begincmap 2 beginbfchar <0020> <0020> <0021> <0041> endbfchar endcmap';
    const actual = await payload(await cidPdf('BT /F1 10 Tf 50 Tz 10 Tw 1 0 0 1 100 200 Tm [<0020> 200 <0021>] TJ ET', { encoding: 'Identity-V', unicode }));
    expect(actual.items[1].transform[5]).toBe(188); // -10 vertical advance, then -2 TJ; no two-byte word-space addition.
    const horizontal = await payload(await cidPdf('BT /F1 10 Tf 10 Tw <00200021> Tj ET', { unicode }));
    expect(horizontal.items[0].width).toBe(20);
  });
  it('executes embedded CMap records/base inheritance and rejects cyclic base streams', async () => {
    const metrics = readTrueTypeMetrics(await loadAsset('standard_fonts/LiberationSans-Regular.ttf')), gid = metrics.glyphId(65);
    const encodingData = `begincmap 1 begincidchar <0041> ${gid} endcidchar endcmap`;
    const actual = await payload(await cidPdf('BT /F1 12 Tf <0041> Tj ET', { encodingData, encodingDictionary: '/UseCMap /Identity-H' }));
    expect(actual.items[0].str).toBe('A');
    await expect(payload(await cidPdf('BT /F1 12 Tf <0041> Tj ET', { encodingData, encodingDictionary: '/UseCMap 11 0 R' }))).rejects.toThrow(/Cyclic/);
  });
  it('keeps vertical Canvas baselines and selectable source spans at the declared per-glyph positions', async () => {
    const metrics = readTrueTypeMetrics(await loadAsset('standard_fonts/LiberationSans-Regular.ttf')), mapping = new Uint8Array(15776);
    putGlyph(mapping, 264, metrics.glyphId(65)); putGlyph(mapping, 7887, metrics.glyphId(66));
    const actual = await payload(await cidPdf('BT /F1 10 Tf 50 Tz 1 0 0 1 100 200 Tm <418141> Tj ET', { encoding: '90ms-RKSJ-V', system: 'Japan1', mapping,
      vertical: '/W2 [264 [-1000 250 900] 7887 7887 -1200 500 800]' }));
    const calls = [], context = { canvas: { width: 612, height: 792 } };
    for (const name of ['save', 'restore', 'setTransform', 'fillRect', 'transform', 'beginPath', 'scale', 'fillText']) context[name] = (...args) => calls.push([name, ...args]);
    const viewport = createPdfViewport([0, 0, 612, 792]); await renderPdfDisplayList(actual, { canvasContext: context, viewport }).promise;
    const paints = calls.filter(call => call[0] === 'fillText'); expect(paints.map(call => call.slice(2))).toEqual([[-.25, .9], [-.5, 1.8]]);
    const spans = [], ownerDocument = { createElement: tag => tag === 'canvas' ? { getContext: () => ({ measureText: () => ({ width: 6 }) }) } : { style: {}, setAttribute(name, value) { this[name] = value; } } };
    const container = { ownerDocument, style: {}, setAttribute() {}, replaceChildren() { spans.length = 0; }, append(span) { spans.push(span); } };
    await renderPdfTextLayer({ page: { getTextContent: async () => ({ items: actual.items, styles: { [actual.fonts[0].family]: actual.fonts[0] } }) }, container, viewport });
    expect(spans.map(span => span.textContent).join('')).toBe('A、'); expect(spans.map(span => parseFloat(span.style.left))).toEqual([98.75, 97.5]);
    expect(parseFloat(spans[0].style.top)).toBeCloseTo(601 - 10 * actual.fonts[0].ascent, 8);
    expect(parseFloat(spans[1].style.top)).toBeCloseTo(610 - 10 * actual.fonts[0].ascent, 8);
    expect(actual.items).toHaveLength(1);
    expect(spans.map(span => span['data-pagenarrator-pdf-source-index'])).toEqual(['0', '0']);
  });
  it('preserves vertical ActualText geometry and paint while keeping replacement source associations explicit', async () => {
    const unicode = 'begincmap 2 beginbfchar <0020> <0041> <0021> <0042> endbfchar endcmap';
    const actual = await payload(await cidPdf('BT /F1 10 Tf 1 0 0 1 100 200 Tm /Span << /ActualText (CD) >> BDC <0020> Tj <0021> Tj EMC ET', { encoding: 'Identity-V', unicode }));
    expect(actual.items).toHaveLength(1); expect(actual.items[0]).toMatchObject({ str: 'CD', dir: 'ttb', height: 20, vertical: true });
    expect(actual.items[0].glyphs.map(glyph => [glyph.text, glyph.x, glyph.y])).toEqual([['C', -.5, -.88], ['D', -.5, -1.88]]);
    expect(actual.commands.filter(command => command.op === 'text').map(command => command.glyphs.map(glyph => glyph.text).join(''))).toEqual(['A', 'B']);
    await expect(payload(await cidPdf('BT /F1 10 Tf /Span << /ActualText (ambiguous) >> BDC <00200021> Tj EMC ET', { encoding: 'Identity-V', unicode }))).rejects.toThrow(/per-glyph source association/);
    await expect(payload(await cidPdf('BT /F1 10 Tf /Span << /ActualText (AB) >> BDC <0020> Tj 30 0 Td <0021> Tj EMC ET', { encoding: 'Identity-V', unicode }))).rejects.toThrow(/Multi-column/);
  });
});
