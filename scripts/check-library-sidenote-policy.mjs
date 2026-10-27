// Targeted conformance to the user's sidenote policy; never replace frozen benchmark gold or report this as holdout accuracy.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPdfLibraryBenchmarkGold } from '../tests/helpers/pdf-library-benchmark-gold.js';
import { getDocument } from '../src/pdf/pdf-engine.js';
import { iteratePdfSpeechChunks } from '../src/lib/pdf-extraction.js';
import { evaluateReadingOrder } from './run-pdf-acceptance.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'artifacts/reading-order-patterns/private-sidenote-policy.json');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const { records, goldEvidence } = loadPdfLibraryBenchmarkGold();
const goldHash = hash(await readFile(goldEvidence.path));
const sourceFiles = ['src/lib/pdf-page-model.js', 'src/lib/pdf-extraction.js', 'scripts/check-library-sidenote-policy.mjs'];
const pins = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async name => [name, hash(await readFile(path.join(root, name)))])));
const sourcePins = await pins();
const wasm = new Uint8Array(await readFile(path.join(root, 'native/pdf.wasm')));
const loadAsset = async name => new Uint8Array(await readFile(path.join(root, 'vendor/pdf-data', name)));
// Orders follow the independently captured Poppler pages and the user's confirmed after-paragraph policy.
const cases = [
  { id: 'library-b44cd75c-6066-4180-9adb-ab89df51c7f6', order: [1, 0, 2, 3, 4],
    visualReason: 'Marker 17 attaches the right-margin note to a body paragraph above the power-budget paragraph. Read the complete marked paragraph, then its note, then later body paragraphs.' },
  { id: 'library-f8a0cf91-22fe-4a2d-8282-6edc4eed2d0a', order: [2, 0, 1, 3, 4],
    visualReason: 'Marker 30 attaches the left-margin note to the governance paragraph preceding the question box. Read the complete paragraph, then the note, then the box and subsequent section.' },
];
const results = [];
for (const selected of cases) {
  const record = records.find(record => record.id === selected.id);
  assert.ok(record, 'Unknown pinned library page');
  assert.deepEqual([...selected.order].sort(), [0, 1, 2, 3, 4]);
  const preview = path.join(root, '.cache/pdf-library-v1-20261024-reference-05/previews', `library-${record.sha256.slice(0, 16)}-p${record.pageNumber}.png`);
  const previewSha256 = hash(await readFile(preview));
  const task = getDocument({ data: new Uint8Array(await readFile(record.privateFilePath)), wasm, loadAsset, disableWorker: true });
  let stream, speech = '';
  try {
    const document = await task.promise;
    stream = iteratePdfSpeechChunks(document, { startPage: record.narrationStartPage })[Symbol.asyncIterator]();
    for (;;) {
      const next = await stream.next();
      if (next.done || next.value.pageNumber > record.pageNumber) break;
      if (next.value.pageNumber === record.pageNumber) {
        assert.equal(typeof next.value.pdfNarration?.speech, 'string');
        speech = next.value.pdfNarration.speech;
        break;
      }
    }
  } finally {
    try { await stream?.return?.(); }
    finally { await task.destroy(); }
  }
  const checkpoints = selected.order.map(index => record.orderedCheckpoints[index]);
  results.push({ ...selected, preview, previewSha256, sourceSha256: record.sha256,
    frozenBenchmark: evaluateReadingOrder({ speech }, record.orderedCheckpoints),
    afterParagraphPolicy: evaluateReadingOrder({ speech }, checkpoints),
    checkpoints, transcriptSha256: hash(speech), speech });
}
const goldUnchanged = hash(await readFile(goldEvidence.path)) === goldHash;
const sourcePinsUnchanged = JSON.stringify(sourcePins) === JSON.stringify(await pins());
const report = { policy: 'Sidenotes after their attached paragraph, explicitly selected by the user on 2026-10-26.',
  scope: 'Two selected known deviations reviewed against independent Poppler previews. Agent visual review and targeted Node-core conformance only; not a human review score, a new benchmark, or unseen-document accuracy.',
  backend: 'original', sourcePins, sourcePinsUnchanged, goldSha256: goldHash, goldUnchanged, results,
  passed: goldUnchanged && sourcePinsUnchanged && results.every(result => result.afterParagraphPolicy.passed) };
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ output, passed: report.passed, goldUnchanged, sourcePinsUnchanged,
  results: results.map(({ id, frozenBenchmark, afterParagraphPolicy }) => ({ id, frozenBenchmark, afterParagraphPolicy })) }, null, 2));
if (!report.passed) process.exitCode = 1;
