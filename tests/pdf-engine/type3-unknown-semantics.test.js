import { describe, expect, it } from 'vitest';
import { NativePdfReader } from '../../src/pdf/native-reader.js';
import { loadSimplePdfFont } from '../../src/pdf/fonts.js';
import { createPdfDocumentCore } from '../../src/pdf/document-core.js';
import { renderPdfDisplayList } from '../../src/pdf/canvas-renderer.js';
import { createPdfViewport } from '../../src/pdf/viewport.js';
import { options, simplePdf, stream } from './fixtures.js';

const rectangle = '600 0 0 0 600 700 d1 0 0 600 700 re f';
const font = (name, extra = '') => `/Type /Font /Subtype /Type3 /FontMatrix [.001 0 0 .001 0 0] /FontBBox [0 0 600 700] /Encoding << /Differences [65 /${name}] >> /FirstChar 65 /LastChar 65 /Widths [600] /CharProcs << /${name} 6 0 R >> ${extra}`;
const show = 'BT /F1 20 Tf 1 0 0 1 50 700 Tm (A) Tj ET';
function fixture(name = 'char78', { content = show, unicode = null, procedure = rectangle, extra = '' } = {}) {
  return simplePdf(content, { font: font(name, `${unicode === null ? '' : '/ToUnicode 7 0 R'} ${extra}`), extra: [stream(procedure), ...(unicode === null ? [] : [stream(unicode)])] });
}
async function payload(data) {
  const core = await createPdfDocumentCore(data, options);
  try { return await core.pagePayload(1); } finally { core.destroy(); }
}

describe('Type3 unknown semantics preserve source painting and refuse invented text', () => {
  it.each(['char78', 'A1', 'F7', 'prime'])('retains the actual %s CharProc and PDF advances under a private unmapped identity', async name => {
    const data = fixture(name), reader = await NativePdfReader.create(data, options);
    try {
      const loaded = await loadSimplePdfFont(reader, reader.checked(reader.api.pn_pdf_resolve(5, 0)), options.loadAsset);
      const actual = loaded.decode(Uint8Array.of(65))[0]; loaded.decode(Uint8Array.of(65));
      expect(actual).toMatchObject({ code: 65, text: '\ue041', unmapped: true, unknownType3Text: true }); expect(actual.width).toBeCloseTo(600, 10);
      expect(reader.node(actual.type3.stream).kind).toBe('stream');
      expect(reader.codecWarnings.filter(warning => warning.unknownType3Text)).toHaveLength(1);
    } finally { reader.destroy(); }
    const actual = await payload(data);
    expect(actual.items[0].str).toBe('\ue041'); expect(actual.items[0].width).toBeCloseTo(12, 10);
    expect(actual.inspection.unknownType3Glyphs).toBe(1); expect(actual.inspection.unmappedGlyphs).toBe(1);
    expect(actual.commands.filter(command => command.op === 'text')).toEqual([]);
    actual.commands.find(command => command.op === 'setPdfTransform').args.forEach((value, i) => expect(value).toBeCloseTo([.02, 0, 0, .02, 50, 700][i], 10));
    const fills = [], paths = [], stack = [];
    const context = { canvas: { width: 612, height: 792 }, save() { stack.push(1); }, restore() { stack.pop(); }, setTransform() {}, transform() {},
      beginPath() { paths.length = 0; }, rect(...args) { paths.push(args); }, fill() { fills.push(paths.map(args => [...args])); },
      fillText() { throw Error('Unknown Type3 names must paint their actual CharProc, not substitute font text.'); } };
    await renderPdfDisplayList(actual, { canvasContext: context, viewport: createPdfViewport([0, 0, 612, 792]), background: false }).promise;
    expect(fills).toEqual([[[0, 0, 600, 700]]]); expect(stack).toHaveLength(0);
  });

  it.each([['0058', 'X'], ['', '']])('preserves explicit ToUnicode <%s>, including an empty authoritative value', async (target, expected) => {
    const actual = await payload(fixture('char78', { unicode: `begincmap 1 beginbfchar <41> <${target}> endbfchar endcmap` }));
    expect(actual.items.map(item => item.str).join('')).toBe(expected);
    expect(actual.inspection.unknownType3Glyphs).toBe(0); expect(actual.inspection.unmappedGlyphs).toBe(0);
    expect(actual.inspection.decodingWarnings.some(warning => warning.unknownType3Text)).toBe(false);
    expect(actual.commands.some(command => command.op === 'paint')).toBe(true);
  });
  it('retains the independently pinned normative AGL minute name without treating Unicode PRIME as a glyph-name alias', async () => {
    const actual = await payload(fixture('minute'));
    expect(actual.items[0].str).toBe('\u2032'); expect(actual.inspection.unknownType3Glyphs).toBe(0);
  });
  it.each(['Recovered mark', ''])('lets authoritative ActualText %j replace unknown semantics while retaining CharProc painting', async actualText => {
    const actual = await payload(fixture('char78', { content: `/Span << /ActualText (${actualText}) >> BDC ${show} EMC` }));
    expect(actual.items.map(item => item.str).join('')).toBe(actualText); expect(actual.inspection.unknownType3Glyphs).toBe(0);
    expect(actual.inspection.unmappedGlyphs).toBe(0); expect(actual.commands.some(command => command.op === 'paint')).toBe(true);
  });
  it.each(['BT /F1 0 Tf (A) Tj ET', 'BT /F1 20 Tf 0 Tz (A) Tj ET'])('does not claim an unknown painted glyph for a zero-size or zero-horizontal-scale show', async content => {
    const actual = await payload(fixture('char78', { content }));
    expect(actual.inspection.unknownType3Glyphs).toBe(0); expect(actual.items).toEqual([]); expect(actual.commands.some(command => command.op === 'paint')).toBe(false);
  });
  it('does not mistake implementation text inside an authoritative outer CharProc for unknown page semantics', async () => {
    const data = simplePdf(show, { font: font('A', '/Resources << /Font << /Inner 8 0 R >> >>'), extra: [
      stream('600 0 d0 BT /Inner 1000 Tf (A) Tj ET'), 'null', `<< ${font('char78').replace('/char78 6 0 R', '/char78 9 0 R')} >>`, stream(rectangle),
    ] });
    const actual = await payload(data);
    expect(actual.items.map(item => item.str).join('')).toBe('A'); expect(actual.inspection.unknownType3Glyphs).toBe(0);
    expect(actual.commands.some(command => command.op === 'paint')).toBe(true);
  });
  it('keeps missing used CharProc/width data and invalid authoritative ToUnicode corrupt', async () => {
    const missing = simplePdf(show, { font: font('char78').replace('/CharProcs << /char78 6 0 R >>', '/CharProcs << >>'), extra: [stream(rectangle)] });
    await expect(payload(missing)).rejects.toMatchObject({ code: 'pdf_corrupt', message: 'Missing Type3 glyph or width.' });
    const missingWidth = simplePdf(show, { font: font('char78').replace('/Widths [600]', '/Widths []'), extra: [stream(rectangle)] });
    await expect(payload(missingWidth)).rejects.toMatchObject({ code: 'pdf_corrupt', message: 'Missing Type3 glyph or width.' });
    await expect(payload(fixture('char78', { unicode: 'begincmap 1 beginbfchar <41> <58> endbfchar endcmap' }))).rejects.toMatchObject({ code: 'pdf_corrupt', message: 'Odd-length ToUnicode value.' });
  });
  it('does not warn or count an unused unknown name', async () => {
    const actual = await payload(fixture('char78', { content: '' }));
    expect(actual.inspection.unknownType3Glyphs).toBe(0); expect(actual.inspection.decodingWarnings.some(warning => warning.unknownType3Text)).toBe(false);
  });
});
