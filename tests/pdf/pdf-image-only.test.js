import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  configurePdfWorker,
  extractPdfTextFromData,
  iteratePdfSpeechChunks,
  readPdfPageRecord,
} from '../../src/lib/pdf-extraction.js';

const FIXTURE_DIR = new URL('../fixtures/pdfs/image-only/', import.meta.url);
const RASTER_FIXTURES = [
  'single-raster.pdf',
  'multi-raster.pdf',
  'inline-image.pdf',
  'raster-with-furniture.pdf',
  'raster-with-citation.pdf',
];
const CONTROL_FIXTURES = [
  ['blank-control.pdf', 'blank'],
  ['vector-control.pdf', 'renderable-nontext'],
];

async function readFixture(name) {
  return new Uint8Array(await readFile(new URL(name, FIXTURE_DIR)));
}

async function openFixture(name) {
  configurePdfWorker(pdfjs);
  const loadingTask = pdfjs.getDocument({
    data: await readFixture(name),
    disableWorker: true,
    useSystemFonts: true,
    enableScripting: false,
  });
  return {
    document: await loadingTask.promise,
    destroy: () => loadingTask.destroy(),
  };
}

async function consumeStream(document) {
  const chunks = [];
  for await (const chunk of iteratePdfSpeechChunks(document, { pdfjs })) chunks.push(chunk);
  return chunks;
}

describe('real image-only PDF classification', () => {
  it.each(RASTER_FIXTURES)('classifies every page in %s as raster-image', async (name) => {
    const { document, destroy } = await openFixture(name);
    try {
      const kinds = [];
      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
        const record = await readPdfPageRecord(document, pageNumber, { pdfjs });
        kinds.push(record.contentKind);
      }
      expect(kinds.length).toBeGreaterThan(0);
      expect(kinds.every((kind) => kind === 'raster-image')).toBe(true);
    } finally {
      await destroy();
    }
  });

  it.each(CONTROL_FIXTURES)('classifies %s as %s instead of a scan', async (name, expectedKind) => {
    const { document, destroy } = await openFixture(name);
    try {
      await expect(readPdfPageRecord(document, 1, { pdfjs })).resolves.toMatchObject({
        contentKind: expectedKind,
      });
    } finally {
      await destroy();
    }
  });

  it('classifies a real selectable-text control as text', async () => {
    const { document, destroy } = await openFixture('text-control.pdf');
    try {
      await expect(readPdfPageRecord(document, 1, { pdfjs })).resolves.toMatchObject({
        contentKind: 'text',
      });
    } finally {
      await destroy();
    }
  });

  it.each(RASTER_FIXTURES)('routes %s to the scanned fallback in materialized and streaming paths', async (name) => {
    const bytes = await readFixture(name);
    await expect(extractPdfTextFromData(bytes, { pdfjs, title: name })).rejects.toMatchObject({
      code: 'scanned_pdf_unsupported',
    });

    const { document, destroy } = await openFixture(name);
    try {
      await expect(consumeStream(document)).rejects.toMatchObject({
        code: 'scanned_pdf_unsupported',
      });
    } finally {
      await destroy();
    }
  });

  it.each(CONTROL_FIXTURES)('does not label %s as scanned in materialized or streaming paths', async (name) => {
    const bytes = await readFixture(name);
    await expect(extractPdfTextFromData(bytes, { pdfjs, title: name })).resolves.toMatchObject({
      source: 'pdf',
      text: '',
    });

    const { document, destroy } = await openFixture(name);
    try {
      await expect(consumeStream(document)).resolves.toEqual([]);
    } finally {
      await destroy();
    }
  });

  it('keeps the real selectable-text control readable in both paths', async () => {
    const bytes = await readFixture('text-control.pdf');
    await expect(extractPdfTextFromData(bytes, { pdfjs, title: 'text-control.pdf' })).resolves.toMatchObject({
      text: expect.stringContaining('Selectable body text remains meaningful.'),
    });

    const { document, destroy } = await openFixture('text-control.pdf');
    try {
      await expect(consumeStream(document)).resolves.toEqual([
        expect.objectContaining({ speech: 'Selectable body text remains meaningful.' }),
      ]);
    } finally {
      await destroy();
    }
  });
});
