import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PDF_ACCEPTANCE_BENCHMARK } from '../fixtures/pdf-acceptance-manifest.js';
import { buildPdfBytes } from '../helpers/pdf-test-generator.js';
import { sha256 } from '../../scripts/weak-hardware/run-provenance.mjs';
import {
  COMPLEX_ARTICLE,
  SCANNED_PDF_SENTENCES,
  TTS_PROBE_PDF_PAGES,
  complexArticleCheckpoints,
  longArticleReferenceText,
  renderComplexArticleHtml,
  renderLongArticleHtml,
  renderSoakArticleHtml,
} from '../fixtures/weak-hardware/workload-references.js';

const ROOT_DIR = path.resolve(import.meta.dirname, '../..');

// The protocol's threshold for straightforward extraction categories.
export const WORD_RECALL_THRESHOLD = 0.99;

const LEGACY_ARTICLE_CHECKPOINTS = Object.freeze([
  'This local article is deterministic',
  'First measured section',
  'The first section has enough spoken text',
  'Fourth measured section',
  'The fourth section gives the flow probe another transition',
]);

/**
 * Workloads the probe can open. HTML workloads are served from the local probe
 * server; PDF workloads open in the extension's viewer.
 */
export const PROBE_WORKLOADS = Object.freeze({
  article: Object.freeze({ kind: 'html', path: '/probe.html', reference: { checkpoints: LEGACY_ARTICLE_CHECKPOINTS } }),
  'long-article': Object.freeze({
    kind: 'html',
    path: '/long-article.html',
    title: 'Maintaining a Community Library Through Lean Years',
    render: renderLongArticleHtml,
    reference: { fullText: longArticleReferenceText() },
  }),
  'complex-html': Object.freeze({
    kind: 'html',
    path: '/complex-layout.html',
    title: COMPLEX_ARTICLE.title,
    render: renderComplexArticleHtml,
    reference: { checkpoints: complexArticleCheckpoints(), forbidden: COMPLEX_ARTICLE.forbidden },
  }),
  'soak-article': Object.freeze({
    kind: 'html',
    path: '/soak-article.html',
    title: 'The River Town Record',
    render: () => renderSoakArticleHtml(),
    reference: { checkpoints: ['The River Town Record', 'Part 1', 'Part 2'] },
  }),
  pdf: Object.freeze({
    kind: 'pdf',
    sha256: 'cf7f64bca6be30fbbde2e686589fc45a41568533a87df467cb7054c149f0e774',
    build: () => Buffer.from(buildPdfBytes(TTS_PROBE_PDF_PAGES.map(lines => ({
      items: lines.map((text, line) => ({ text, x: 54, y: 700 - line * 24 })),
    })))),
    readyText: TTS_PROBE_PDF_PAGES[0][0],
    reference: { checkpoints: TTS_PROBE_PDF_PAGES.flat() },
  }),
  'two-column-pdf': Object.freeze({
    kind: 'pdf',
    file: 'tests/fixtures/pdfs/acceptance/ltr-two-column.pdf',
    readyText: 'Left Before Right',
    reference: { checkpoints: getAcceptanceCheckpoints('fixture-ltr-two-column') },
  }),
  'scanned-pdf': Object.freeze({
    kind: 'pdf',
    build: () => buildScannedPdf(SCANNED_PDF_SENTENCES),
    // OCR runs during reading; only the page itself must load first.
    readyText: null,
    reference: { checkpoints: SCANNED_PDF_SENTENCES.map((sentence) => sentence.replace(/\.$/, '')) },
  }),
});

/**
 * The probe closes its toolbar-player page after every run, and that page's
 * pagehide teardown disposes the PDF viewer it read from (tearDownPdfViewer),
 * leaving the tab open without a document. A PDF that an earlier run in the
 * same browser session used must be reopened before it is read again.
 * @param {string} documentType
 * @param {{ usedInSession?: boolean }} [options]
 */
export function needsFreshDocumentTarget(documentType, { usedInSession = false } = {}) {
  return usedInSession && PROBE_WORKLOADS[documentType]?.kind === 'pdf';
}

function getAcceptanceCheckpoints(id) {
  const record = PDF_ACCEPTANCE_BENCHMARK.find((entry) => entry.id === id);
  if (!record) throw new Error(`Unknown PDF acceptance fixture: ${id}`);
  return [...record.orderedCheckpoints];
}

export async function loadPdfWorkloadBytes(workload) {
  const bytes = workload.build ? await workload.build() : await readFile(path.join(ROOT_DIR, workload.file));
  if (workload.sha256 && sha256(bytes) !== workload.sha256) throw new Error('PDF probe workload hash does not match the frozen fixture.');
  return bytes;
}

// A one-page image-only PDF with known sentences, built like the OCR e2e test.
export async function buildScannedPdf(sentences) {
  const { default: sharp } = await import('sharp');
  const lines = sentences.map((sentence, index) => `<text x="80" y="${200 + (index * 70)}" font-size="42" font-family="Arial">${sentence}</text>`).join('');
  const jpeg = await sharp(Buffer.from(`<svg width="1200" height="600" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="white"/>${lines}</svg>`)).jpeg().toBuffer();
  const stream = 'q 600 0 0 300 0 0 cm /Im1 Do Q';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 300] /Resources << /XObject << /Im1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width 1200 /Height 600 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`), jpeg, Buffer.from('\nendstream')]),
  ];
  let pdf = Buffer.from('%PDF-1.4\n');
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(pdf.length);
    pdf = Buffer.concat([pdf, Buffer.from(`${index + 1} 0 obj\n`), Buffer.from(object), Buffer.from('\nendobj\n')]);
  });
  return Buffer.concat([pdf, Buffer.from(`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${pdf.length}\n%%EOF`)]);
}

export function normalizeForScoring(text) {
  return String(text || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^\p{L}\p{N}$%.']+/gu, ' ')
    .replace(/(?<!\d)\.|\.(?!\d)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function words(text) {
  const normalized = normalizeForScoring(text);
  return normalized ? normalized.split(' ') : [];
}

/** Longest common subsequence of words / reference length. */
export function orderedWordRecall(referenceText, actualText) {
  const reference = words(referenceText);
  const actual = words(actualText);
  if (!reference.length) return null;
  let previous = new Array(actual.length + 1).fill(0);
  for (let i = 1; i <= reference.length; i += 1) {
    const current = new Array(actual.length + 1).fill(0);
    for (let j = 1; j <= actual.length; j += 1) {
      current[j] = reference[i - 1] === actual[j - 1] ? previous[j - 1] + 1 : Math.max(previous[j], current[j - 1]);
    }
    previous = current;
  }
  return previous[actual.length] / reference.length;
}

export function findCheckpointsInOrder(actualText, checkpoints = []) {
  const haystack = normalizeForScoring(actualText);
  let cursor = 0;
  const found = [];
  const missing = [];
  let inOrder = true;
  for (const checkpoint of checkpoints) {
    const needle = normalizeForScoring(checkpoint);
    const index = haystack.indexOf(needle, cursor);
    if (index >= 0) {
      found.push(checkpoint);
      cursor = index + needle.length;
    } else if (haystack.includes(needle)) {
      found.push(checkpoint);
      inOrder = false;
    } else {
      missing.push(checkpoint);
    }
  }
  return { found: found.length, total: checkpoints.length, missing, inOrder };
}

/**
 * Scores extracted text against an authored reference.
 * @param {string} actualText
 * @param {{ fullText?: string, checkpoints?: readonly string[], forbidden?: readonly string[] }} reference
 * @param {{ truncated?: boolean }} [options]
 */
export function scoreWorkloadContent(actualText, reference = {}, { truncated = false } = {}) {
  const failures = [];
  const result = { truncated, wordRecall: null, checkpoints: null, forbiddenFound: [] };
  if (reference.fullText) {
    if (truncated) {
      failures.push('transcript is truncated; full-text recall cannot be measured');
    } else {
      result.wordRecall = orderedWordRecall(reference.fullText, actualText);
      if (result.wordRecall < WORD_RECALL_THRESHOLD) {
        failures.push(`ordered word recall ${(result.wordRecall * 100).toFixed(1)}% is below ${WORD_RECALL_THRESHOLD * 100}%`);
      }
    }
  }
  if (reference.checkpoints?.length) {
    result.checkpoints = findCheckpointsInOrder(actualText, reference.checkpoints);
    if (result.checkpoints.missing.length && !truncated) failures.push(`missing content: ${result.checkpoints.missing.join(' | ')}`);
    if (!result.checkpoints.inOrder) failures.push('content is out of reading order');
  }
  const normalized = normalizeForScoring(actualText);
  result.forbiddenFound = (reference.forbidden || []).filter((phrase) => normalized.includes(normalizeForScoring(phrase)));
  if (result.forbiddenFound.length) failures.push(`page furniture narrated: ${result.forbiddenFound.join(' | ')}`);
  return { ...result, failures, passes: failures.length === 0 };
}

/**
 * Picks the text to score. Narration (every queued chunk's speech text) is what
 * the reader speaks; the transcript card is a UI surface that can hold only the
 * first streamed part of a page, so it is scored separately.
 * @param {any} captured value of TRANSCRIPT_EXPRESSION
 */
export function selectScoredContent(captured) {
  const transcriptText = [captured?.title || '', ...(captured?.paragraphs || [])].join('\n');
  const chunks = (captured?.narration?.chunks || []).filter((text) => typeof text === 'string');
  const narrated = chunks.some((text) => text.trim());
  return {
    text: narrated ? chunks.join('\n') : transcriptText,
    source: narrated ? 'narration: queued speech text from reader-state broadcasts' : `transcript (${captured?.source || 'unknown'})`,
    truncated: narrated ? false : Boolean(captured?.truncated),
    queuedChunks: narrated ? chunks.length : null,
    transcriptText,
  };
}

/**
 * Source evaluated in the toolbar-player page: the extracted transcript. The
 * page hooks keep the fullest transcript rendered during the read because the
 * engine resets the DOM when a read ends; the live DOM is the fallback.
 */
export const TRANSCRIPT_EXPRESSION = `(() => {
  const recorded = globalThis.__pnProbeTranscript;
  const fromRecorder = Boolean(recorded && recorded.textLength > 0);
  const paragraphs = fromRecorder
    ? [...recorded.paragraphs]
    : [...document.querySelectorAll('#transcript-text p')].map((node) => node.textContent || '');
  const label = fromRecorder ? recorded.countLabel : (document.getElementById('transcript-count')?.textContent || '');
  const numbers = (label.match(/\\d+/g) || []).map(Number);
  const narration = globalThis.__pnProbeNarration;
  return {
    title: fromRecorder ? recorded.title : (document.getElementById('article-title')?.textContent || ''),
    paragraphs,
    countLabel: label,
    truncated: numbers.length > 1 && numbers[0] !== numbers[1],
    source: fromRecorder ? 'recorded during read' : 'live DOM after read',
    narration: narration ? {
      chunks: Array.from(narration.chunks, (text) => text || ''),
      broadcasts: narration.broadcasts,
      errors: [...narration.errors],
    } : null,
  };
})()`;
