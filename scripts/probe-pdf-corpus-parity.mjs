// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Development oracle: classify existing corpus failures without changing its gold.
import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { loadPdfBenchmarkGold } from '../tests/helpers/pdf-benchmark-gold.js';
import { assertCurrentPdfCorpusControl, readPdfCorpusImplementationPins, readPdfCorpusSourceSha256 } from './lib/pdf-corpus-control-integrity.mjs';
import { createPdfPageModel } from '../src/lib/pdf-page-model.js';
import { matchesOrderedCheckpoints, countNarrationErrors } from './pdf-acceptance-metrics.mjs';

const { records: PDF_ACCEPTANCE_BENCHMARK, goldEvidence } = loadPdfBenchmarkGold();
const root = fileURLToPath(new URL('../', import.meta.url)), source = process.env.PN_PDF_FIXTURE_DIR || path.join(root, '.cache/pdf-corpus');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const ownBytes = await readFile(new URL('../artifacts/engines/pdf-original-corpus.json', import.meta.url)), own = JSON.parse(ownBytes);
const controlPinsBefore = await readPdfCorpusImplementationPins(root);
const currentControl = assertCurrentPdfCorpusControl(own, { records: PDF_ACCEPTANCE_BENCHMARK, goldEvidence,
  implementationPins: controlPinsBefore, sourceSha256: await readPdfCorpusSourceSha256(root),
  wasmSha256: controlPinsBefore.find(pin => pin.path === 'native/pdf.wasm')?.sha256 });
const candidates = own.records.filter(record => !record.readingOrder || record.narrationErrors || record.unmappedGlyphs || record.recognizedSymbolGlyphs);
const pageModelPin = sha(await readFile(new URL('../src/lib/pdf-page-model.js', import.meta.url))), records = [];
for (const actual of candidates) {
  const entry = PDF_ACCEPTANCE_BENCHMARK.find(entry => entry.id === actual.id), location = entry.source.startsWith('tests/') ? path.join(root, entry.source) : path.join(source, `${entry.id}.pdf`);
  const data = new Uint8Array(await readFile(location));
  if (sha(data) !== entry.sha256 || actual.sha256 !== entry.sha256) throw new Error(`Frozen source mismatch for ${entry.id}.`);
  const task = pdfjs.getDocument({ data, useSystemFonts: true, isEvalSupported: false,
    standardFontDataUrl: fileURLToPath(new URL('../vendor/pdf-data/standard_fonts/', import.meta.url)).replaceAll('\\', '/'),
    cMapUrl: fileURLToPath(new URL('../node_modules/pdfjs-dist/cmaps/', import.meta.url)).replaceAll('\\', '/'), cMapPacked: true });
  try {
    const page = await (await task.promise).getPage(entry.pageNumber), content = await page.getTextContent();
    const model = createPdfPageModel(content.items, { pageView: page.view, pageRotation: page.rotate });
    const order = matchesOrderedCheckpoints(model.speech, entry.orderedCheckpoints), narrationErrors = countNarrationErrors(model.speech, entry.forbiddenNarration);
    const matches = text => entry.forbiddenNarration.map(value => ({ value, count: countNarrationErrors(text, [value]) })).filter(item => item.count);
    const baseline = { readingOrder: order.passed, failedCheckpoint: order.failedCheckpoint, narrationErrors,
      forbiddenMatches: matches(model.speech), text: content.items.map(item => item.str || '').join(' '), speech: model.speech };
    records.push({ id: entry.id, sourceSha256: entry.sha256, pageNumber: entry.pageNumber,
      original: { readingOrder: actual.readingOrder, failedCheckpoint: actual.failedCheckpoint, narrationErrors: actual.narrationErrors,
        forbiddenMatches: matches(actual.speech), unmappedGlyphs: actual.unmappedGlyphs, recognizedSymbolGlyphs: actual.recognizedSymbolGlyphs, recognizedSymbols: actual.recognizedSymbols, text: actual.text, speech: actual.speech }, pdfjs: baseline,
      checkpointClassification: actual.readingOrder ? 'passed' : order.passed ? 'replacement_regression' : 'shared_existing_failure',
      forbiddenNarrationClassification: actual.narrationErrors ? narrationErrors === actual.narrationErrors && JSON.stringify(matches(actual.speech)) === JSON.stringify(baseline.forbiddenMatches) ? 'shared_existing_failure' : 'replacement_regression_or_different_error' : 'passed',
      mappingClassification: actual.unmappedGlyphs ? 'replacement_mapping_obligation_requires_source_glyph_review' : actual.recognizedSymbolGlyphs ? 'documented_nontext_symbols_preserved_and_counted_separately' : 'passed' });
  } finally { await task.destroy(); }
}
if (pageModelPin !== sha(await readFile(new URL('../src/lib/pdf-page-model.js', import.meta.url)))) throw new Error('Page model changed during parity audit.');
if (JSON.stringify(controlPinsBefore) !== JSON.stringify(await readPdfCorpusImplementationPins(root))) throw new Error('Current PDF implementation/data/gold changed during parity audit.');
const report = { schemaVersion: 1, backend: 'PDF.js isolated development oracle', rendererAcceptance: false, goldEvidence, currentControl,
  scope: `The ${candidates.length} sources failing original reading/order/mapping/narration gates; no gold or production implementation changed.`,
  ownControlSha256: sha(ownBytes), ownEngineSourceSha256: own.sourceSha256, ownWasmSha256: own.wasmSha256,
  pageModelSha256: pageModelPin, pdfjsVersion: pdfjs.version,
  pdfjsSourceSha256: sha(await readFile(new URL('../node_modules/pdfjs-dist/legacy/build/pdf.mjs', import.meta.url))),
  manifestSha256: sha(await readFile(new URL('../tests/fixtures/pdf-acceptance-manifest.js', import.meta.url))),
  records };
const output = new URL('../artifacts/engines/pdf-original-parity-audit.json', import.meta.url);
try { await copyFile(output, new URL(`../artifacts/engines/pdf-original-parity-audit-${Date.now()}.json`, import.meta.url)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(records.map(({ id, checkpointClassification, forbiddenNarrationClassification, mappingClassification, original, pdfjs }) => ({ id, checkpointClassification, forbiddenNarrationClassification, mappingClassification,
  originalCheckpoint: original.failedCheckpoint, pdfjsCheckpoint: pdfjs.failedCheckpoint, originalErrors: original.narrationErrors, pdfjsErrors: pdfjs.narrationErrors, unmappedGlyphs: original.unmappedGlyphs })), null, 2));
