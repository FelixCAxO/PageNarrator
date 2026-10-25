// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { openPdfDocument } from '../src/pdf/browser-pdf.js';
import { PDF_ACCEPTANCE_BENCHMARK as PUBLIC_PDF_ACCEPTANCE_BENCHMARK } from '../tests/fixtures/pdf-acceptance-manifest.js';
import { loadPdfBenchmarkGold } from '../tests/helpers/pdf-benchmark-gold.js';
import { readPdfCorpusImplementationPins, readPdfCorpusSourceSha256 } from './lib/pdf-corpus-control-integrity.mjs';
import { createPdfPageModel } from '../src/lib/pdf-page-model.js';
import { matchesOrderedCheckpoints, countNarrationErrors } from './pdf-acceptance-metrics.mjs';
import { extractPdfTextFromData } from '../src/lib/pdf-extraction.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = process.env.PN_PDF_FIXTURE_DIR || path.join(root, '.cache/pdf-corpus');
const count = Number(process.env.PN_PDF_ENGINE_LIMIT || PUBLIC_PDF_ACCEPTANCE_BENCHMARK.length);
if (!Number.isSafeInteger(count) || count < 1 || count > PUBLIC_PDF_ACCEPTANCE_BENCHMARK.length) throw new Error('Invalid PN_PDF_ENGINE_LIMIT.');
const ids = process.argv.slice(2);
const { records: PDF_ACCEPTANCE_BENCHMARK, goldEvidence } = loadPdfBenchmarkGold({ requiredIds: ids.length ? ids : PUBLIC_PDF_ACCEPTANCE_BENCHMARK.slice(0, count).map(record => record.id) });
const wasm = await readFile(new URL('../native/pdf.wasm', import.meta.url));
const loadAsset = async name => new Uint8Array(await readFile(new URL(`../vendor/pdf-data/${name}`, import.meta.url)));
const records = [];
const entries = ids.length ? ids.map(id => { const entry = PDF_ACCEPTANCE_BENCHMARK.find(e => e.id === id); if (!entry) throw new Error(`Unknown corpus id ${id}.`); return entry; }) : PDF_ACCEPTANCE_BENCHMARK.slice(0, count);
const implementationPins = () => readPdfCorpusImplementationPins(root);
const pinsBefore = await implementationPins();
const sourceSha256 = await readPdfCorpusSourceSha256(root);
for (const entry of entries) {
  const location = entry.source.startsWith('tests/') ? path.join(root, entry.source) : path.join(source, `${entry.id}.pdf`);
  let document;
  try {
    const bytes = new Uint8Array(await readFile(location)), sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== entry.sha256) throw new Error('Frozen PDF source hash mismatch.');
    const start = performance.now(); document = await openPdfDocument(bytes, { wasm, loadAsset, useWorker: false });
    const page = await document.getPage(entry.pageNumber), text = await page.getTextContent();
    const inspection = await page.inspect(); let model = createPdfPageModel(text.items, { pageView: page.view, pageRotation: page.rotate });
    if (entry.id === 'fixture-running-content') {
      const backend = { getDocument({ data }) { const promise = openPdfDocument(data, { wasm, loadAsset, useWorker: false }); return { promise, async destroy() { (await promise).destroy(); } }; } };
      const article = await extractPdfTextFromData(bytes.slice(), { pdfjs: backend, title: entry.id }), chunk = article.chunks.find(c => c.pageNumber === entry.pageNumber);
      model = { speech: chunk?.speech || '' };
    }
    const checkpoint = matchesOrderedCheckpoints(model.speech, entry.orderedCheckpoints);
    records.push({ id: entry.id, source: entry.source, pageNumber: entry.pageNumber, categories: [...entry.categories], sha256, status: 'parsed', items: text.items.length, elapsedMs: performance.now() - start,
      text: text.items.map(item => item.str).join(' '), speech: model.speech, readingOrder: checkpoint.passed, failedCheckpoint: checkpoint.failedCheckpoint,
      narrationErrors: countNarrationErrors(model.speech, entry.forbiddenNarration), unmappedGlyphs: inspection.unmappedGlyphs, recognizedSymbolGlyphs: inspection.recognizedSymbolGlyphs,
      recognizedSymbols: text.items.flatMap((item, sourceIndex) => (item.recognizedSymbols || []).map(symbol => ({ ...symbol, sourceIndex }))),
      decodingWarnings: inspection.decodingWarnings, view: page.view, rotate: page.rotate });
  } catch (error) { records.push({ id: entry.id, source: entry.source, pageNumber: entry.pageNumber, categories: [...entry.categories], status: 'failed', code: error.code, message: error.message }); }
  finally { document?.destroy(); }
}
const failures = {};
for (const record of records) if (record.status === 'failed') failures[record.message] = (failures[record.message] || 0) + 1;
const pinsAfter = await implementationPins();
if (JSON.stringify(pinsBefore) !== JSON.stringify(pinsAfter)) throw new Error('PDF implementation/data/gold changed during the frozen corpus control.');
const report = { schemaVersion: 1, controlIntegrityVersion: 1, backend: 'original', rasterAcceptance: false, goldEvidence,
  scope: 'Standalone original PDF extraction and narration gates on frozen source bytes. Packaged viewer integration is verified by the separate pdf-app report; this is not raster, performance or release acceptance.',
  sourceSha256, implementationPins: pinsBefore, implementationPinsUnchanged: true,
  wasmSha256: createHash('sha256').update(wasm).digest('hex'), parsed: records.filter(record => record.status === 'parsed').length,
  readingOrderPassed: records.filter(record => record.readingOrder && record.unmappedGlyphs === 0).length, narrationClean: records.filter(record => record.status === 'parsed' && record.narrationErrors === 0 && record.unmappedGlyphs === 0).length,
  recognizedSymbolGlyphs: records.reduce((sum, record) => sum + (record.recognizedSymbolGlyphs || 0), 0),
  symbolPolicy: 'Provider-defined nontext symbols retain selectable source representation and exact painted glyphs, carry validated font/glyph/range metadata, and are counted separately from meaningful text. Unknown glyphs remain failures.',
  total: records.length, failures, records };
await mkdir(new URL('../artifacts/engines/', import.meta.url), { recursive: true });
try { await copyFile(new URL('../artifacts/engines/pdf-original-corpus.json', import.meta.url), new URL(`../artifacts/engines/pdf-original-corpus-${Date.now()}.json`, import.meta.url)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
await writeFile(new URL('../artifacts/engines/pdf-original-corpus.json', import.meta.url), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ parsed: report.parsed, total: report.total, readingOrderPassed: report.readingOrderPassed, narrationClean: report.narrationClean, failures }, null, 2));
