import { describe, expect, it, vi } from 'vitest';
import { openPdfDocument } from '../../src/pdf/browser-pdf.js';
import { extractPdfTextFromDocument, getPdfReadableWordCount, iteratePdfSpeechChunks, readPdfPageRecord } from '../../src/lib/pdf-extraction.js';
import { options, simplePdf, stream } from '../pdf-engine/fixtures.js';

const item = str => ({ str, transform: [12, 0, 0, 12, 50, 600], width: 300, height: 12 });
const prose = 'Selectable native prose needs its missing symbol to remain meaningful. '.repeat(12);
const recovered = [item('Recognized prose includes the recovered symbol.')];
function document(text = prose, count = 1) {
  const page = { pageNumber: 1, view: [0, 0, 612, 792], cleanup: vi.fn(),
    getTextContent: async () => ({ items: [item(text)], unknownType3Glyphs: count }),
    inspect: vi.fn(async () => ({ unmappedGlyphs: 1, hasRasterImage: false, hasRenderableNonText: false, inspectionFailed: false, error: null })) };
  return { numPages: 1, getPage: async () => page, page };
}
async function chunks(doc, settings) {
  const result = [];
  for await (const chunk of iteratePdfSpeechChunks(doc, settings)) result.push(chunk);
  return result;
}

describe('unknown Type3 semantics need recognition before narration', () => {
  it.each(['Short prose with \ue000.', prose])('retains the recognition requirement for short or long native prose', async text => {
    const doc = document(text), result = await readPdfPageRecord(doc, 1);
    expect(result.hasUnknownType3Text).toBe(true); expect(result.needsOcr).toBe(true);
    expect(doc.page.cleanup).toHaveBeenCalledTimes(1);
    if (text.length >= 500) expect(doc.page.inspect).not.toHaveBeenCalled();
  });

  it('refuses native-only materialization, streaming and word counts before emitting partial prose', async () => {
    const doc = document();
    await expect(extractPdfTextFromDocument(doc)).rejects.toMatchObject({ code: 'scanned_pdf_unsupported' });
    const iterator = iteratePdfSpeechChunks(doc);
    await expect(iterator.next()).rejects.toMatchObject({ code: 'scanned_pdf_unsupported' });
    await expect(getPdfReadableWordCount(doc)).rejects.toMatchObject({ code: 'scanned_pdf_unsupported' });
    expect(doc.page.cleanup).toHaveBeenCalledTimes(3);
  });

  it('uses recognized page text and releases the page', async () => {
    const doc = document(), recognizePage = vi.fn(async () => recovered);
    const result = await readPdfPageRecord(doc, 1, { recognizePage });
    expect(result.hasUnknownType3Text).toBe(true); expect(result.needsOcr).toBe(false);
    expect(result.model.speech).toBe(recovered[0].str);
    const actual = await chunks(doc, { recognizePage });
    expect(actual.map(chunk => chunk.speech).join(' ')).toBe(recovered[0].str);
    expect(recognizePage).toHaveBeenCalledTimes(2); expect(doc.page.cleanup).toHaveBeenCalledTimes(2);
  });

  it.each(['unchanged', 'empty'])('does not accept %s recognition as a semantic recovery', async kind => {
    const doc = document();
    const recognizePage = async () => kind === 'empty' ? [] : (await doc.page.getTextContent()).items.map(part => ({ ...part, ocrLine: 0 }));
    await expect(chunks(doc, { recognizePage })).rejects.toMatchObject({ code: 'scanned_pdf_unsupported' });
  });

  it('preserves recognition failures and page cleanup', async () => {
    const doc = document(), error = new Error('Recognition failed.');
    await expect(readPdfPageRecord(doc, 1, { recognizePage: async () => { throw error; } })).rejects.toBe(error);
    expect(doc.page.cleanup).toHaveBeenCalledTimes(1);
  });

  it('keeps other unmapped-symbol warnings and ordinary long native text on their existing path', async () => {
    const doc = document(prose, 0), recognizePage = vi.fn();
    const result = await readPdfPageRecord(doc, 1, { recognizePage });
    expect(result.hasUnknownType3Text).toBe(false); expect(result.needsOcr).toBe(false);
    expect(recognizePage).not.toHaveBeenCalled(); expect(doc.page.inspect).not.toHaveBeenCalled();
  });

  it('defers recognition of a read-ahead Type3 page until that page is reached', async () => {
    const known = document(prose, 0).page, unknown = { ...document().page, pageNumber: 3 };
    const doc = { numPages: 6, getPage: async number => number === 3 ? unknown : { ...known, pageNumber: number } };
    const recognizePage = vi.fn(async () => recovered), iterator = iteratePdfSpeechChunks(doc, { recognizePage });
    try {
      let reached = false;
      for (let i = 0; i < 100; i++) {
        const next = await iterator.next();
        if (next.done) break;
        if (next.value.pageNumber < 3) expect(recognizePage).not.toHaveBeenCalled();
        if (next.value.pageNumber === 3) { reached = true; break; }
      }
      expect(reached).toBe(true); expect(recognizePage).toHaveBeenCalledTimes(1);
      expect(recognizePage.mock.calls[0][0].pageNumber).toBe(3);
    } finally { await iterator.return(); }
  });

  it.each(['unknown', 'ToUnicode', 'ActualText'])('propagates %s Type3 semantics through the actual original facade', async authority => {
    const marked = authority === 'ActualText';
    const body = Array(16).fill('(Selectable prose is directly readable.) Tj 0 -14 Td').join(' ');
    const source = simplePdf(`BT /F2 12 Tf 1 0 0 1 50 700 Tm ${body} ET ${marked ? '/Span << /ActualText (Resolved symbol) >> BDC' : ''} BT /F1 12 Tf 1 0 0 1 50 450 Tm <00> Tj ET ${marked ? 'EMC' : ''}`, {
      page: '/Resources << /Font << /F1 5 0 R /F2 7 0 R >> >>',
      font: '/Type /Font /Subtype /Type3 /FontMatrix [.001 0 0 .001 0 0] /FontBBox [0 0 600 700] /Encoding << /Differences [0 /UnresolvedCustomGlyph] >> /FirstChar 0 /LastChar 0 /Widths [600] /CharProcs << /UnresolvedCustomGlyph 6 0 R >>' + (authority === 'ToUnicode' ? ' /ToUnicode 8 0 R' : ''),
      extra: [stream('600 0 0 0 600 700 d1 0 0 600 700 re f'), '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', stream('begincmap 1 beginbfchar <00> <0058> endbfchar endcmap')],
    });
    const doc = await openPdfDocument(source, options);
    try {
      const page = await doc.getPage(1), content = await page.getTextContent();
      expect(content.unknownType3Glyphs).toBe(authority === 'unknown' ? 1 : 0);
      const record = await readPdfPageRecord(doc, 1);
      expect(record.model.speech.length).toBeGreaterThan(500);
      expect(record.hasUnknownType3Text).toBe(authority === 'unknown'); expect(record.needsOcr).toBe(authority === 'unknown');
    } finally { await doc.destroy(); }
  });
});
