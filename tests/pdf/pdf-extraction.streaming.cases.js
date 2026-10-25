import { createFakePdfDocument, textToItems, textItem } from "./pdf-extraction.fixtures.js";
import { describe, expect, it } from "vitest";

import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractPdfTextFromDocument, iteratePdfSpeechChunks } from "../../src/lib/pdf-extraction.js";

describe('PDF extraction', () => {
  it.each(['l84', 'I84'])('omits OCR page number %s alongside a learned running header row', async number => {
    const document = createFakePdfDocument(Array.from({ length: 4 }, (_, index) => [
      textItem('Wildlife research proceedings', 300, 700, { width: 210, height: 8.88 }),
      ...(index === 2 ? [textItem(number, 68, 699.3, { width: 18, height: 10.8 })] : []),
      textItem(`Distinct chapter ${index + 1} retains meaningful body.`, 72, 620, { width: 270 }),
      textItem(`Body identifier ${number} remains visible.`, 72, 600, { width: 240 }),
    ]));
    const article = await extractPdfTextFromDocument(document);
    expect(article.chunks).toHaveLength(4);
    for (const [index, chunk] of article.chunks.entries()) {
      expect(chunk.speech).toBe(`Distinct chapter ${index + 1} retains meaningful body. Body identifier ${number} remains visible.`);
    }
  });

  it.each(['l84', 'I84'])('recognizes OCR-confused page number %s only in a repeated edge slot', async number => {
    const document = createFakePdfDocument(Array.from({ length: 4 }, (_, index) => [
      textItem(index === 2 ? number : String(182 + index), 68, 700, { width: 18, height: index === 2 ? 10.8 : 8.88 }),
      textItem(`Distinct chapter ${index + 1} retains meaningful body.`, 72, 620, { width: 270 }),
      textItem(`Body identifier ${number} remains visible.`, 72, 600, { width: 240 }),
    ]));
    const article = await extractPdfTextFromDocument(document);
    expect(article.chunks).toHaveLength(4);
    for (const [index, chunk] of article.chunks.entries()) {
      expect(chunk.speech).toBe(`Distinct chapter ${index + 1} retains meaningful body. Body identifier ${number} remains visible.`);
    }
  });

  it('strips repeated PDF headers, footers, and page numbers before page chunks are emitted', async () => {
    const document = createFakePdfDocument(Array.from({ length: 4 }, (_, index) => [
      textItem('PageNarrator technical report', 72, 770, { width: 190 }),
      textItem(`Page ${index + 1}`, 288, 26, { width: 44 }),
      textItem(`Chapter body ${index + 1} opening sentence.`, 72, 710, { width: 220 }),
      textItem(`Distinct page ${index + 1} supporting details.`, 72, 690, { width: 220 }),
    ]));

    const article = await extractPdfTextFromDocument(document, {
      title: 'Repeated furniture',
      url: 'https://example.test/repeated.pdf',
    });

    expect(article.chunks).toHaveLength(4);
    expect(article.text).not.toContain('PageNarrator technical report');
    expect(article.text).not.toMatch(/\bPage [1-4]\b/);
    expect(article.chunks.map((chunk) => chunk.speech)).toEqual([
      'Chapter body 1 opening sentence. Distinct page 1 supporting details.',
      'Chapter body 2 opening sentence. Distinct page 2 supporting details.',
      'Chapter body 3 opening sentence. Distinct page 3 supporting details.',
      'Chapter body 4 opening sentence. Distinct page 4 supporting details.',
    ]);
    for (const chunk of article.chunks) {
      expect(chunk.pdfNarration).toEqual({ speech: chunk.speech, narratedItemOrders: [1, 2] });
    }
  });

  it('does not emit PDF outline titles as standalone spoken sections', async () => {
    const document = createFakePdfDocument([
      'Cover page preface.',
      'Introduction body text.',
      'Methods body text.',
    ]);
    document.getOutline = async () => [
      { title: 'Introduction', dest: 'intro-dest' },
      {
        title: 'Methods',
        dest: [{ pageNumber: 3 }],
        items: [{ title: 'Evaluation', dest: [{ pageNumber: 3 }] }],
      },
    ];
    document.getDestination = async (name) => {
      expect(name).toBe('intro-dest');
      return [{ pageNumber: 2 }];
    };
    document.getPageIndex = async (ref) => ref.pageNumber - 1;

    const article = await extractPdfTextFromDocument(document, {
      title: 'Outlined PDF',
      url: 'https://example.test/outlined.pdf',
    });

    expect(article.chunks.map((chunk) => ({
      type: chunk.type,
      speech: chunk.speech,
      anchorId: chunk.anchorId,
      pageNumber: chunk.pageNumber,
    }))).toEqual([
      { type: 'pdf-page', speech: 'Cover page preface.', anchorId: 'pdf-page-1', pageNumber: 1 },
      { type: 'pdf-page', speech: 'Introduction body text.', anchorId: 'pdf-page-2', pageNumber: 2 },
      { type: 'pdf-page', speech: 'Methods body text.', anchorId: 'pdf-page-3', pageNumber: 3 },
    ]);
    expect(article.text).toBe([
      'Cover page preface.',
      'Introduction body text.',
      'Methods body text.',
    ].join('\n\n').trim());
  });

  it('streams header-stripped PDF page chunks without outline-only audio gaps', async () => {
    const document = createFakePdfDocument(Array.from({ length: 3 }, (_, index) => [
      textItem('Recurring report title', 72, 770, { width: 160 }),
      textItem(String(index + 1), 304, 26, { width: 12 }),
      textItem(index === 1 ? 'Chapter One' : `Body page ${index + 1}.`, 72, 710, {
        height: index === 1 ? 20 : 12,
        width: index === 1 ? 112 : 120,
      }),
      textItem(`Readable page ${index + 1} content.`, 72, 690, { width: 180 }),
    ]));
    document.getOutline = async () => [
      { title: 'Chapter One', dest: [{ pageNumber: 2 }] },
    ];
    document.getPageIndex = async (ref) => ref.pageNumber - 1;

    const chunks = [];
    for await (const chunk of iteratePdfSpeechChunks(document, { maxLen: 120 })) {
      chunks.push(chunk);
    }

    expect(chunks.map((chunk) => ({
      type: chunk.type,
      speech: chunk.speech,
      anchorId: chunk.anchorId,
      pageNumber: chunk.pageNumber,
    }))).toEqual([
      { type: 'pdf-page', speech: 'Body page 1. Readable page 1 content.', anchorId: 'pdf-page-1', pageNumber: 1 },
      { type: 'pdf-page', speech: 'Chapter One. Readable page 2 content.', anchorId: 'pdf-page-2', pageNumber: 2 },
      { type: 'pdf-page', speech: 'Body page 3. Readable page 3 content.', anchorId: 'pdf-page-3', pageNumber: 3 },
    ]);
    expect(chunks.some((chunk) => /Recurring report title/.test(chunk.speech))).toBe(false);
    expect(document.cleanupCalls).toEqual([1, 2, 3]);
  });

  it('rejects image-only PDFs with a scanned-PDF diagnostic', async () => {
    const document = {
      numPages: 1,
      async getPage() {
        return {
          async getTextContent() {
            return { items: [] };
          },
          async getOperatorList() {
            return { fnArray: [pdfjs.OPS.paintImageXObject] };
          },
          cleanup() {},
        };
      },
    };

    await expect(extractPdfTextFromDocument(document, {
      title: 'Scanned book',
      url: 'https://example.test/scanned.pdf',
    })).rejects.toMatchObject({
      code: 'scanned_pdf_unsupported',
      message: expect.stringContaining('text recognition'),
    });
  });

  it('rejects image-only streamed PDFs with the same scanned-PDF diagnostic', async () => {
    const document = {
      numPages: 1,
      async getPage() {
        return {
          async getTextContent() {
            return { items: [] };
          },
          async getOperatorList() {
            return { fnArray: [pdfjs.OPS.paintImageXObject] };
          },
          cleanup() {},
        };
      },
    };
    const readStream = async () => {
      const chunks = [];
      for await (const chunk of iteratePdfSpeechChunks(document)) {
        chunks.push(chunk);
      }
      return chunks;
    };

    await expect(readStream()).rejects.toMatchObject({
      code: 'scanned_pdf_unsupported',
      message: expect.stringContaining('text recognition'),
    });
  });

  it('surfaces operator-inspection failures instead of mislabeling the PDF as scanned', async () => {
    const inspectionError = Object.assign(new Error('operator inspection failed'), {
      code: 'operator_inspection_failed',
    });
    const document = {
      numPages: 1,
      async getPage() {
        return {
          async getTextContent() {
            return { items: [] };
          },
          async getOperatorList() {
            throw inspectionError;
          },
          cleanup() {},
        };
      },
    };

    await expect(extractPdfTextFromDocument(document)).rejects.toBe(inspectionError);

    const streamedDocument = {
      ...document,
      async getPage() {
        return {
          async getTextContent() {
            return { items: [] };
          },
          async getOperatorList() {
            throw inspectionError;
          },
          cleanup() {},
        };
      },
    };
    const consume = async () => {
      for await (const _chunk of iteratePdfSpeechChunks(streamedDocument)) {
        // The inspection error is expected before any chunk can be emitted.
      }
    };
    await expect(consume()).rejects.toBe(inspectionError);
  });

  it('streams PDF speech chunks page by page and releases each page', async () => {
    const document = createFakePdfDocument([
      'First page opening sentence. First page second sentence.',
      'Second page final sentence.',
    ]);

    const chunks = [];
    for await (const chunk of iteratePdfSpeechChunks(document, { maxLen: 34 })) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      expect.objectContaining({
        type: 'pdf-page',
        speech: 'First page opening sentence.',
        text: 'First page opening sentence.',
        anchorId: 'pdf-page-1',
        pageNumber: 1,
        domWordOffset: 0,
      }),
      expect.objectContaining({
        speech: 'First page second sentence.',
        anchorId: 'pdf-page-1',
        pageNumber: 1,
        domWordOffset: 4,
      }),
      expect.objectContaining({
        speech: 'Second page final sentence.',
        anchorId: 'pdf-page-2',
        pageNumber: 2,
        domWordOffset: 0,
      }),
    ]);
    expect(document.cleanupCalls).toEqual([1, 2]);
  });

  it('yields the first PDF speech chunk before sampling later pages', async () => {
    let releaseSecondPage;
    const secondPageRequested = new Promise((resolve) => {
      releaseSecondPage = resolve;
    });
    const document = {
      numPages: 4,
      cleanupCalls: [],
      async getPage(pageNumber) {
        if (pageNumber === 2) {
          await secondPageRequested;
        }
        const text = pageNumber === 1
          ? 'First page should speak immediately.'
          : `Later page ${pageNumber} text.`;
        return {
          view: [0, 0, 612, 792],
          async getTextContent() {
            return { items: textToItems(text) };
          },
          cleanup: () => document.cleanupCalls.push(pageNumber),
        };
      },
    };

    const iterator = iteratePdfSpeechChunks(document, { maxLen: 120 })[Symbol.asyncIterator]();
    const first = iterator.next();
    const firstOrTimeout = await Promise.race([
      first,
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 20)),
    ]);

    expect(firstOrTimeout).toMatchObject({
      done: false,
      value: {
        speech: 'First page should speak immediately.',
        pageNumber: 1,
      },
    });

    releaseSecondPage();
    await iterator.return?.();
  });

  it('streams ten pages immediately without narrating repeated furniture', async () => {
    let releaseSecondPage;
    const secondPageGate = new Promise((resolve) => {
      releaseSecondPage = resolve;
    });
    const document = {
      numPages: 10,
      cleanupCalls: [],
      async getPage(pageNumber) {
        if (pageNumber === 2) await secondPageGate;
        return {
          view: [0, 0, 612, 792],
          async getTextContent() {
            return {
              items: [
                textItem('Recurring report header', 72, 770, { width: 150, height: 9 }),
                textItem(pageNumber === 1
                  ? 'First page body starts immediately.'
                  : `Later body ${pageNumber} remains meaningful.`, 72, 700, { width: 360 }),
                textItem('Confidential footer', 72, 30, { width: 110, height: 9 }),
                textItem(`Page ${pageNumber}`, 288, 20, { width: 40, height: 9 }),
              ],
            };
          },
          cleanup: () => document.cleanupCalls.push(pageNumber),
        };
      },
    };

    const iterator = iteratePdfSpeechChunks(document, { maxLen: 240 })[Symbol.asyncIterator]();
    const first = await Promise.race([
      iterator.next(),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 30)),
    ]);

    expect(first).toMatchObject({
      done: false,
      value: {
        pageNumber: 1,
        speech: expect.stringContaining('First page body starts immediately.'),
      },
    });

    releaseSecondPage();
    const chunks = [first.value];
    while (true) {
      const result = await iterator.next();
      if (result.done) break;
      chunks.push(result.value);
    }
    const narration = chunks.map((chunk) => chunk.speech).join(' ');

    expect(narration).not.toMatch(/Recurring report header|Confidential footer|\bPage \d+\b/u);
    expect(document.cleanupCalls).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('streams PDF speech chunks from a requested page', async () => {
    const document = createFakePdfDocument([
      'First page should be skipped.',
      'Second page starts here.',
      'Third page continues.',
    ]);

    const chunks = [];
    for await (const chunk of iteratePdfSpeechChunks(document, { startPage: 2 })) {
      chunks.push(chunk);
    }

    expect(chunks.map((chunk) => chunk.pageNumber)).toEqual([2, 3]);
    expect(chunks[0].speech).toBe('Second page starts here.');
    expect(document.cleanupCalls).toEqual([2, 3]);
  });
});
