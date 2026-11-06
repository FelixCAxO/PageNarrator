import { describe, expect, it } from 'vitest';
import { createPdfDocumentCore } from '../../src/pdf/document-core.js';
import { openPdfDocument } from '../../src/pdf/browser-pdf.js';
import { extractPdfTextFromData, readPdfPageRecord } from '../../src/lib/pdf-extraction.js';
import { simplePdf, show, stream, options } from './fixtures.js';

const text = 'Narration remains readable.';
const resources = extra => `/Resources << /Font << /F1 5 0 R >> ${extra} >>`;
const statePdf = dictionary => simplePdf(show('Before') + ' /GS gs ' + show('After'), {
  page: resources('/ExtGState << /GS 6 0 R >>'), extra: [dictionary],
});
const cases = [
  ['blend mode', statePdf('<< /BM /UnknownBlend >>')],
  ['transfer function', statePdf('<< /TR2 << /FunctionType 2 /Domain [0 1] /C0 [0] /C1 [1] /N 1 >> >>')],
  ['soft mask', statePdf('<< /SMask << /S /UnknownMask >> >>')],
  ['color space', simplePdf(show('Before') + ' /Unsupported cs ' + show('After'), { page: resources('/ColorSpace << /Unsupported [/Lab << /WhitePoint [1 1 1] /BlackPoint [0.1 0.1 0.1] >>] >>') })],
  ['page transparency', simplePdf(show('Before') + ' ' + show('After'), { page: '/Group << /S /Transparency /K true >>' })],
  ['Form transparency', simplePdf(show('Before') + ' /X Do ' + show('After'), {
    page: resources('/XObject << /X 6 0 R >>'),
    extra: [stream('BT /F1 12 Tf (Inside form) Tj ET', '/Type /XObject /Subtype /Form /BBox [0 0 100 100] /Matrix [2 0 0 2 30 40] /Group << /S /Transparency /K true >>')],
  })],
  ['image filter', simplePdf(show('Before') + ' /X Do ' + show('After'), {
    page: resources('/XObject << /X 6 0 R >>'), extra: [stream('image', '/Type /XObject /Subtype /Image /Width 1 /Height 1 /BitsPerComponent 8 /ColorSpace /DeviceRGB /Filter /UnknownDecode')],
  })],
  ['rounded annotation', simplePdf(show('Before') + ' ' + show('After'), { page: '/Annots [6 0 R]', extra: ['<< /Type /Annot /Subtype /Link /Rect [0 0 10 10] /Border [2 2 1] >>'] })],
  ['annotation style', simplePdf(show('Before') + ' ' + show('After'), { page: '/Annots [6 0 R]', extra: ['<< /Type /Annot /Subtype /Link /Rect [0 0 10 10] /BS << /W 1 /S /B >> >>'] })],
];
async function payload(bytes, recoverUnsupportedArtwork = true) {
  const core = await createPdfDocumentCore(bytes, { ...options, recoverUnsupportedArtwork });
  try { return await core.pagePayload(1); } finally { core.destroy(); }
}

describe('narration recovery from unsupported PDF visuals', () => {
  it.each(cases)('retains all text when %s is unsupported', async (kind, bytes) => {
    await expect(payload(bytes, false)).rejects.toMatchObject({ code: 'pdf_unsupported' });
    const recovered = await payload(bytes);
    expect(recovered.items.map(item => item.str)).toEqual(kind === 'Form transparency' ? ['Before', 'Inside form', 'After'] : ['Before', 'After']);
    expect(recovered.inspection.artworkWarnings).toContainEqual(expect.objectContaining({ kind: 'page', code: 'pdf_unsupported' }));
    expect(recovered.inspection.unmappedGlyphs).toBe(0);
  });
  it('preserves Form transforms while ignoring its group paint', async () => {
    const actual = await payload(cases.find(([name]) => name === 'Form transparency')[1]);
    expect(actual.items[1].transform).toEqual([24, 0, 0, 24, 30, 40]);
  });
  it('keeps ExtGState font changes and text spacing despite unsupported visual state', async () => {
    const actual = await payload(simplePdf('q 2 0 0 2 10 20 cm /GS gs BT 2 Tc 75 Tz 1 0 0 1 50 100 Tm [(A) -100 (B)] TJ ET Q', {
      page: resources('/ExtGState << /GS 6 0 R >>'), extra: ['<< /Font [5 0 R 20] /BM /UnknownBlend >>'],
    }));
    expect(actual.items.map(item => item.str).join('')).toBe('AB');
    expect(actual.items[0].transform).toEqual([30, 0, 0, 40, 110, 220]);
    expect(actual.items[0].width).toBeCloseTo(49.02, 2);
  });
  it('extracts annotation appearance text even with an unsupported transparency group', async () => {
    const actual = await payload(simplePdf(show('Body'), { page: '/Annots [6 0 R]', extra: [
      '<< /Type /Annot /Subtype /Stamp /Rect [20 30 220 130] /AP << /N 7 0 R >> >>',
      stream(show('Annotation text'), '/Type /XObject /Subtype /Form /BBox [0 0 100 50] /Group << /S /Transparency /K true >>'),
    ] }));
    expect(actual.items.map(item => item.str)).toEqual(['Body', 'Annotation text']);
  });
  it('delivers speech through the app extraction path after a page-group rendering failure', async () => {
    const actual = await extractPdfTextFromData(simplePdf(show(text), { page: '/Group << /S /Transparency /K true >>' }), {
      wasmUrl: new URL('../../engines/native/pdf.wasm', import.meta.url).href,
      standardFontDataUrl: new URL('../../engines/vendor/pdf-data/standard_fonts/', import.meta.url).href,
    });
    expect(actual.chunks[0].speech).toBe(text);
  });
  it('retains readable Type3 glyphs without executing unsupported glyph artwork', async () => {
    const actual = await payload(simplePdf('BT /F1 20 Tf (A) Tj ET', { font: '/Type /Font /Subtype /Type3 /FontBBox [0 0 1000 1000] /FontMatrix [.001 0 0 .001 0 0] /FirstChar 65 /LastChar 65 /Widths [600] /Encoding << /Differences [65 /A] >> /CharProcs << /A 6 0 R >>',
      page: resources('/ExtGState << /GS << /BM /UnknownBlend >> >>'), extra: [stream('600 0 d0 /GS gs')],
    }));
    expect(actual.items[0].str).toBe('A'); expect(actual.inspection.textOnly).toBe(true);
  });
  it('keeps narration available when a known local CID face cannot supply text outlines', async () => {
    const actual = await payload(simplePdf('BT /F1 20 Tf 1 Tr <d6d0cec4> Tj ET', { font: '/Type /Font /Subtype /Type0 /BaseFont /SimSun /Encoding /GBK-EUC-H /DescendantFonts [6 0 R]', extra: [
      '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /SimSun /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 2 >> /FontDescriptor 7 0 R /DW 1000 >>',
      '<< /Type /FontDescriptor /FontName /SimSun /Flags 5 /Ascent 859 /Descent -141 >>',
    ] }));
    expect(actual.items[0].str).toBe('中文'); expect(actual.inspection.textOnly).toBe(true);
  });
  it('propagates corrupt text and missing resources instead of accepting partial recovery', async () => {
    for (const content of [show('Before') + ' /GS gs BT /F1 12 Tf (After) Tj', show('Before') + ' /GS gs /Missing Do', show('Before') + ' /GS gs BT /Missing 12 Tf (After) Tj ET']) {
      await expect(payload(simplePdf(content, { page: resources('/ExtGState << /GS 6 0 R >>'), extra: ['<< /BM /UnknownBlend >>'] }))).rejects.toMatchObject({ code: 'pdf_corrupt' });
    }
  });
  it('does not claim success for a page with no readable text', async () => {
    await expect(payload(simplePdf('/GS gs 0 0 10 10 re f', { page: resources('/ExtGState << /GS 6 0 R >>'), extra: ['<< /BM /UnknownBlend >>'] }))).rejects.toMatchObject({ code: 'pdf_unsupported' });
  });
  it('preserves the OCR requirement for outlined body text beside a mapped heading', async () => {
    const paths = Array.from({ length: 50 }, (_, i) => `${20 + i % 10 * 30} ${200 + Math.floor(i / 10) * 15} 12 5 re f`).join(' ');
    const actual = await payload(simplePdf(show('Heading') + ' ' + paths, { page: '/Group << /S /Transparency /K true >>' }));
    expect(actual.inspection.hasOutlinedText).toBe(true);
    expect(actual.commands.some(command => command.op === 'text')).toBe(true);
  });
  it.each(['1 g', '1 1 1 rg', '0 0 0 0 k', '/DeviceRGB cs 1 1 1 sc'])('retains the white OCR background selected with %s', async white => {
    const actual = await payload(simplePdf(`${white} 0 0 612 792 re f 0 g ${show('Heading')}`, { page: '/Group << /S /Transparency /K true >>' }));
    const background = actual.commands.findIndex(command => command.op === 'path');
    expect(actual.commands.slice(0, background).findLast(command => command.op === 'color' && command.fill)?.value).toBe('rgb(255,255,255)');
    expect(actual.commands.find(command => command.op === 'text').fill).toBe('rgb(0,0,0)');
  });
  it('requests OCR after reduced rendering without silently narrating only the heading', async () => {
    const paths = Array.from({ length: 50 }, (_, i) => `${20 + i % 10 * 30} ${200 + Math.floor(i / 10) * 15} 12 5 re f`).join(' ');
    const document = await openPdfDocument(simplePdf(show('Heading') + ' ' + paths, { page: '/Group << /S /Transparency /K true >>' }), options);
    try { expect((await readPdfPageRecord(document, 1)).needsOcr).toBe(true); }
    finally { document.destroy(); }
  });
  it('keeps an unsupported color-space selection across repeated color operations', async () => {
    const actual = await payload(simplePdf(show('Before') + ' /Unsupported cs 0 0 0 sc ' + show('Middle') + ' 1 1 1 sc ' + show('After'), {
      page: resources('/ColorSpace << /Unsupported [/Lab << /WhitePoint [1 1 1] /BlackPoint [0.1 0.1 0.1] >>] >>'),
    }));
    expect(actual.items.map(item => item.str)).toEqual(['Before', 'Middle', 'After']);
  });
  it('ignores repeated pattern selections without treating them as grayscale operands', async () => {
    const actual = await payload(simplePdf(show('Before') + ' /Pattern cs /P scn 0 0 10 10 re f ' + show('Middle') + ' /P scn 20 20 10 10 re f ' + show('After'), {
      page: resources('/Pattern << /P 6 0 R >>'), extra: ['<< /PatternType 2 /Shading << /ShadingType 7 >> >>'],
    }));
    expect(actual.items.map(item => item.str)).toEqual(['Before', 'Middle', 'After']);
  });
  it('caches recovery and releases it on cleanup', async () => {
    const document = await openPdfDocument(cases[0][1], options);
    try {
      const page = await document.getPage(1), first = await page.getTextContent();
      expect((await page.getTextContent()).artworkWarnings).toBe(first.artworkWarnings);
      page.cleanup(); expect((await page.getTextContent()).items.map(item => item.str)).toEqual(['Before', 'After']);
    } finally { document.destroy(); }
  });
});
