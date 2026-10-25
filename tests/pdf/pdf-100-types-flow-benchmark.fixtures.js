import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { configurePdfWorker, extractPdfTextFromData } from "../../src/lib/pdf-extraction.js";

import { PDF_ACCEPTANCE_BENCHMARK } from '../fixtures/pdf-acceptance-manifest.js';
import { buildPdfBytes } from '../helpers/pdf-test-generator.js';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function loadFixturePdfBytes(fixtureRelativePath) {
  const fullPath = path.join(ROOT_DIR, fixtureRelativePath);
  return new Uint8Array(readFileSync(fullPath));
}

export function getFixtureRecord(id) {
  const record = PDF_ACCEPTANCE_BENCHMARK.find((candidate) => candidate.id === id);
  if (!record) throw new Error(`Fixture not found in acceptance benchmark: ${id}`);
  return record;
}

configurePdfWorker(pdfjs);

export async function extractFromPdf(itemsOrPages, options = {}) {
  const bytes = buildPdfBytes(itemsOrPages, options);
  return extractPdfTextFromData(bytes, { pdfjs });
}
