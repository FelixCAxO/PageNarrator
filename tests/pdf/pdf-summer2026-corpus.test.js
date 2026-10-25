import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  configurePdfWorker,
  iteratePdfSpeechChunks,
} from '../../src/lib/pdf-extraction.js';

const RUN_LOCAL_SUMMER2026_CORPUS = process.env.PN_SUMMER2026_PDF_CORPUS === '1';
const SUMMER2026_PDF_DIR = process.env.PN_SUMMER2026_PDF_DIR;
const LOCAL_CORPUS_TIMEOUT_MS = 10 * 60 * 1000;

const localCorpusIt = RUN_LOCAL_SUMMER2026_CORPUS ? it : it.skip;

describe('Summer2026 local PDF corpus', () => {
  localCorpusIt('reads every PDF in the configured folder', async () => {
    if (!SUMMER2026_PDF_DIR) throw new Error('Set PN_SUMMER2026_PDF_DIR to your local PDF corpus directory.');
    const pdfFiles = await listPdfFiles(SUMMER2026_PDF_DIR);
    const failures = [];

    expect(pdfFiles.length).toBeGreaterThan(0);

    for (const filePath of pdfFiles) {
      try {
        const firstChunk = await readFirstSpeechChunk(filePath);
        expect(firstChunk?.speech?.trim().length, basename(filePath)).toBeGreaterThan(0);
      } catch (error) {
        failures.push(`${basename(filePath)}: ${error?.message || error}`);
      }
    }

    expect(failures, failures.join('\n')).toEqual([]);
  }, LOCAL_CORPUS_TIMEOUT_MS);
});

async function listPdfFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.pdf'))
    .map((entry) => join(dir, entry.name))
    .sort((a, b) => a.localeCompare(b));
}

async function readFirstSpeechChunk(filePath) {
  configurePdfWorker(pdfjs);
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(await readFile(filePath)),
    disableWorker: true,
    useSystemFonts: true,
    enableScripting: false,
  });
  const document = await loadingTask.promise;

  try {
    const iterator = iteratePdfSpeechChunks(document, { pdfjs })[Symbol.asyncIterator]();
    const first = await iterator.next();
    await iterator.return?.();
    if (first.done) throw new Error('No readable speech chunk found.');
    return first.value;
  } finally {
    await loadingTask.destroy();
  }
}
