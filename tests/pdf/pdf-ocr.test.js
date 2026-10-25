import { readFile } from 'node:fs/promises';
import { describe, it, expect, vi } from 'vitest';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { configurePdfWorker, extractPdfTextFromDocument, getPdfReadableWordCount, iteratePdfSpeechChunks, readPdfPageRecord } from '../../src/lib/pdf-extraction.js';

const words = [{ str: 'Recognized requirements are readable.', transform: [14, 0, 0, 14, 72, 400], width: 260, height: 14 }];
async function open(name) {
  configurePdfWorker(pdfjs);
  return pdfjs.getDocument({ data: new Uint8Array(await readFile(new URL(`../fixtures/pdfs/image-only/${name}.pdf`, import.meta.url))) }).promise;
}

describe('OCR extraction fallback', () => {
  const outlinePage = (pageNumber = 1, scale = 1, paint = 'fill', text = 'Published by the garden society.') => ({
    pageNumber, view: [0, 0, 800 * scale, 600 * scale], cleanup() {},
    getTextContent: async () => ({ items: text ? [{ str: text, transform: [8 * scale, 0, 0, 8 * scale, 40 * scale, 20 * scale], width: 180 * scale, height: 8 * scale }] : [] }),
    getOperatorList: async () => ({ fnArray: Array(60).fill(pdfjs.OPS.constructPath),
      argsArray: Array.from({ length: 60 }, () => [pdfjs.OPS[paint === 'rectangle' ? 'fill' : paint], [],
        paint === 'rectangle' ? [0, 0, 400 * scale, 200 * scale] : [0, 0, 40 * scale, 12 * scale]]) }),
  });

  it.each([1, 1.5])('recognizes outlined body despite a native footer at scale %s', async scale => {
    const page = outlinePage(1, scale), recognizePage = vi.fn(async () => words);
    const record = await readPdfPageRecord({ numPages: 1, getPage: async () => page }, 1, { pdfjs, recognizePage });
    expect(recognizePage).toHaveBeenCalledTimes(1);
    expect(record.model.speech).toContain('Recognized requirements are readable.');
  });

  it('recognizes grouped outlined words even without any native glyphs', async () => {
    const page = outlinePage(1, 1, 'fill', ''), recognizePage = vi.fn(async () => words);
    await readPdfPageRecord({ numPages: 1, getPage: async () => page }, 1, { pdfjs, recognizePage });
    expect(recognizePage).toHaveBeenCalledTimes(1);
  });

  it.each(['stroke', 'rectangle'])('keeps short native text without OCR for vector %s', async paint => {
    const page = outlinePage(1, 1, paint), recognizePage = vi.fn();
    const record = await readPdfPageRecord({ numPages: 1, getPage: async () => page }, 1, { pdfjs, recognizePage });
    expect(recognizePage).not.toHaveBeenCalled();
    expect(record.model.speech).toContain('Published by the garden society.');
  });

  it('stops native-only metadata at an outlined page instead of counting its footer as the whole document', async () => {
    const getPage = vi.fn(async number => { expect(number).toBe(1); return outlinePage(number); });
    await expect(getPdfReadableWordCount({ numPages: 401, getPage }, { pdfjs, stopOnRasterImage: true }))
      .rejects.toMatchObject({ code: 'scanned_pdf_unsupported' });
    expect(getPage).toHaveBeenCalledTimes(1);
  });

  it('routes materialized outlined documents to OCR instead of returning a partial native footer', async () => {
    await expect(extractPdfTextFromDocument({ numPages: 1, getPage: async () => outlinePage() }, { pdfjs }))
      .rejects.toMatchObject({ code: 'scanned_pdf_unsupported' });
  });

  it('reports an outlined page when recognition only returns its original native footer', async () => {
    const page = outlinePage();
    const recognizePage = async () => (await page.getTextContent()).items.map(item => ({ ...item, ocrLine: 0 }));
    await expect(getPdfReadableWordCount({ numPages: 1, getPage: async () => page }, { pdfjs, recognizePage }))
      .rejects.toMatchObject({ code: 'scanned_pdf_unsupported' });
  });

  it('defers outlined-page OCR discovered by native read-ahead until that page is reached', async () => {
    const document = { numPages: 6, getPage: async number => number === 2 || number === 6 ? outlinePage(number)
      : { pageNumber: number, view: [0, 0, 800, 600], cleanup() {}, getTextContent: async () => ({ items: [{ ...words[0], str: 'Selectable native body text. '.repeat(24) }] }) } };
    const recognizePage = vi.fn(async () => words), stream = iteratePdfSpeechChunks(document, { pdfjs, recognizePage });
    try {
      let reached = false;
      for (let i = 0; i < 20; i++) {
        const result = await stream.next();
        if (result.done) break;
        if (result.value.anchorId === 'pdf-page-2') { reached = true; break; }
      }
      expect(reached).toBe(true);
      expect(recognizePage).toHaveBeenCalledTimes(1);
      expect(recognizePage.mock.calls[0][0].pageNumber).toBe(2);
      for (let i = 0; i < 40; i++) {
        const result = await stream.next();
        if (result.done || result.value.pageNumber === 5) break;
      }
      expect(recognizePage).toHaveBeenCalledTimes(1);
      while (true) {
        const result = await stream.next();
        if (result.done || result.value.pageNumber === 6) break;
      }
      expect(recognizePage).toHaveBeenCalledTimes(2);
      expect(recognizePage.mock.calls[1][0].pageNumber).toBe(6);
    } finally { await stream.return(); }
  });

  it.each([90, 180, 270])('reads substantial native %i-degree pages without loading OCR or inspecting raster operators', async (rotate) => {
    const cleanup = vi.fn();
    const getOperatorList = vi.fn(() => { throw new Error('native text must not inspect operators'); });
    const recognizePage = vi.fn(() => { throw new Error('native text must not invoke OCR'); });
    const transform = rotate === 90 ? [0, 14, -14, 0, 112, 72]
      : rotate === 180 ? [-14, 0, 0, -14, 540, 292] : [0, -14, 14, 0, 500, 720];
    const page = { rotate, view: [0, 0, 612, 792], cleanup, getOperatorList,
      getTextContent: async () => ({ items: [{ ...words[0], str: `${words[0].str} ${'Native text is directly selectable. '.repeat(16)}`, transform }] }) };
    const document = { numPages: 1, getPage: async () => page };
    const record = await readPdfPageRecord(document, 1, { recognizePage });
    expect(record.contentKind).toBe('text');
    expect(record.model.speech).toContain('Recognized requirements are readable.');
    expect(record.pageView).toEqual(rotate === 180 ? [0, 0, 612, 792] : [0, 0, 792, 612]);
    const chunks = [];
    for await (const chunk of iteratePdfSpeechChunks(document, { recognizePage })) chunks.push(chunk);
    expect(chunks.map(chunk => chunk.speech).join(' ')).toContain('Recognized requirements are readable.');
    expect(recognizePage).not.toHaveBeenCalled();
    expect(getOperatorList).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalled();
  });
  it('stops metadata counting at the first scan in a long document', async () => {
    const document = await open('single-raster');
    const getPage = vi.fn((number) => {
      if (number !== 1) throw new Error('Metadata must not scan the entire book');
      return document.getPage(1);
    });
    try {
      await expect(getPdfReadableWordCount({ numPages: 401, getPage }, {
        pdfjs, stopOnRasterImage: true,
      })).rejects.toMatchObject({ code: 'scanned_pdf_unsupported' });
      expect(getPage).toHaveBeenCalledTimes(1);
    } finally { await document.loadingTask.destroy(); }
  });
  it('streams the first scan without recognizing subsequent pages', async () => {
    const document = await open('multi-raster');
    const recognizePage = vi.fn().mockResolvedValue(words);
    try {
      const stream = iteratePdfSpeechChunks(document, { pdfjs, recognizePage });
      expect((await stream.next()).value.speech).toContain('Recognized requirements');
      expect(recognizePage).toHaveBeenCalledTimes(1);
      await stream.return();
      expect(recognizePage).toHaveBeenCalledTimes(1);
    } finally { await document.loadingTask.destroy(); }
  });

  it.each(['text-control', 'blank-control', 'vector-control'])('does not OCR %s', async (name) => {
    const document = await open(name);
    const recognizePage = vi.fn();
    try {
      await readPdfPageRecord(document, 1, { pdfjs, recognizePage });
      expect(recognizePage).not.toHaveBeenCalled();
    } finally { await document.loadingTask.destroy(); }
  });

  it('reports OCR failure and releases the page instead of silently skipping it', async () => {
    const document = await open('single-raster');
    const page = await document.getPage(1);
    const cleanup = vi.spyOn(page, 'cleanup');
    try {
      await expect(readPdfPageRecord(document, 1, { pdfjs,
        recognizePage: async () => { throw new Error('OCR failed'); },
      })).rejects.toThrow('OCR failed');
      expect(cleanup).toHaveBeenCalled();
    } finally { await document.loadingTask.destroy(); }
  });
});

