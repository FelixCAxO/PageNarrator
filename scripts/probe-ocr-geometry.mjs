// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { createCpuOcrBrowser } from './ocr-cpu-browser.mjs';
import { findForbiddenText } from './audit-cws-media-text.mjs';

const sourceContext = process.argv.includes('--source-context');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const paths = ['src/lib/pdf-ocr.js', 'src/lib/pdf-ocr-paper.js', 'src/lib/pdf-ocr-unwarp.js', 'src/lib/pdf-ocr-detector.js',
  'src/lib/pdf-ocr-ctc.js', 'src/lib/pdf-ocr-neural-batch.js', 'src/lib/pdf-ocr-word-bounds.js',
  'src/engines/ocr-worker-runtime.js', 'src/engines/tesseract-line-recognizer.js', 'src/engines/webgpu-onnx-session.js',
  'public/assets/ocr/english-lstm.json', 'public/assets/ocr/english-lstm.bin', 'public/native/ocr-lstm-engine.wasm'];
const sourceHashes = Object.fromEntries(await Promise.all(paths.map(async path => [path, hash(await readFile(path))])));
const assertFrozen = async () => { for (const [path, expected] of Object.entries(sourceHashes)) if (hash(await readFile(path)) !== expected) throw new Error(`Frozen geometry source changed: ${path}`); };
const source = await readFile('src/lib/pdf-ocr-neural-batch.js', 'utf8');
const needle = "const words = refinePdfOcrWordBounds(timedWords, source.getContext('2d').getImageData(0, 0, source.width, source.height));";
if (!source.includes(needle) || source.indexOf(needle) !== source.lastIndexOf(needle)) throw new Error('Unexpected OCR diagnostic insertion site.');
const instrumented = source.replace(needle, `${needle}
    if ((words.some(word => word.bbox.x1 <= word.bbox.x0 || word.bbox.y1 <= word.bbox.y0)
      || (${sourceContext} && timedWords.some(word => word.bbox.x1 > width + 10)))
      && (globalThis.pnOcrGeometryCaptures || 0) < 16 && source.width * source.height <= 262144) {
      globalThis.pnOcrGeometryCaptures = (globalThis.pnOcrGeometryCaptures || 0) + 1;
      globalThis.postMessage({ type: 'ocr-geometry-diagnostic', width, height, inputWidth, steps, sourceExtent: sourceExtents?.[index] || null,
        sourceWidth: source.width, sourceHeight: source.height,
        labels: Array.from(labels.subarray(index * steps, (index + 1) * steps), Number),
        scores: Array.from(scores.subarray(index * steps, (index + 1) * steps)),
        timedWords, words, pixels: Array.from(source.getContext('2d').getImageData(0, 0, source.width, source.height).data) });
    }`);
const corpus = JSON.parse(await readFile('.cache/ocr-paper-roi-baseline/corpus.json', 'utf8'));
const cases = corpus.cases.filter(value => sourceContext ? value.name === 'rating-matrix' : ['rating-matrix', 'development-photo1700'].includes(value.name) || value.cwsNegative);
const report = { status: 'incomplete', scope: 'Read-only capture of actual post-space-recovery CTC labels, probabilities and source crop pixels; no recognition changes',
  sourceHashes, diagnosticSourceSha256: hash(instrumented), cases: [] };
const save = async () => { await mkdir('artifacts/engines', { recursive: true }); await writeFile(`artifacts/engines/ocr-${sourceContext ? 'source-context' : 'zero-span'}-diagnostic.json`, `${JSON.stringify(report, null, 2)}\n`); };
const browser = await createCpuOcrBrowser({ candidate: 'verified-retained', sourceOverrides: { '/src/lib/pdf-ocr-neural-batch.js': instrumented } });
try {
  for (const value of cases) {
    await assertFrozen(); const bytes = await readFile(value.path);
    if (hash(bytes) !== value.sha256) throw new Error(`Frozen geometry image differs: ${value.name}`);
    const result = await browser.recognizePdfSource(bytes);
    const entry = { name: value.name, inputSha256: value.sha256, ...result };
    if (value.cwsNegative) entry.cwsFindings = findForbiddenText(result.text).map(value => value.label);
    report.cases.push(entry); await save();
    console.log(JSON.stringify({ name: value.name, elapsedMs: entry.elapsedMs, captures: entry.diagnostics.length,
      invalidGeometry: entry.items.filter(item => item.width <= 0 || item.height <= 0).length,
      text: value.cwsNegative ? entry.text : undefined, cwsFindings: entry.cwsFindings }));
  }
  if (sourceContext) {
    const ink = JSON.parse(await readFile('artifacts/engines/ocr-matrix-source-ink.json', 'utf8'));
    const original = await readFile(ink.path);
    if (hash(original) !== ink.sha256) throw new Error('Independently frozen matrix source changed.');
    const { data, info } = await sharp(original).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const result = report.cases[0];
    const candidates = result.items.filter(item => item.str === '5').map(item => ({
      left: item.transform[4] * 3, top: (item.transform[5] - item.height) * 3,
      right: (item.transform[4] + item.width) * 3, bottom: item.transform[5] * 3,
    }));
    const evaluated = candidates.map(box => {
      let covered = 0;
      for (let y = ink.search.top; y < ink.search.bottom; y++) for (let x = ink.search.left; x < ink.search.right; x++) {
        const p = (y * info.width + x) * 4;
        if (Math.min(data[p], data[p + 1], data[p + 2]) > 220 && x + .5 >= box.left && x + .5 < box.right && y + .5 >= box.top && y + .5 < box.bottom) covered++;
      }
      return { box, coveredPixels: covered, independentlyFrozenInkPixels: ink.ink.count, ratio: covered / ink.ink.count };
    });
    const best = evaluated.sort((a, b) => b.coveredPixels - a.coveredPixels)[0];
    const capture = result.diagnostics.find(value => value.words.map(word => word.text).join(' ') === 'u1 5');
    let nonWhiteContext = 0;
    if (capture) for (let y = 10; y < capture.sourceHeight - 10; y++) for (let x = capture.width + 10; x < capture.sourceWidth; x++) {
      const p = (y * capture.sourceWidth + x) * 4;
      if (Math.min(capture.pixels[p], capture.pixels[p + 1], capture.pixels[p + 2]) < 220) nonWhiteContext++;
    }
    report.originalInkAcceptance = { criterion: 'At least90% of independently frozen original5 ink pixels covered; additional context contains non-white original-source pixels',
      best, nonWhiteContext, crop: capture ? { width: capture.sourceWidth, height: capture.sourceHeight, sourceExtent: capture.sourceExtent,
        timedWords: capture.timedWords, refinedWords: capture.words } : null };
    if (!best || best.ratio < .9 || !nonWhiteContext || result.items.some(item => item.width <= 0 || item.height <= 0)) throw new Error('Matrix original-source ink/context proof failed.');
  }
  await assertFrozen(); report.status = 'complete-diagnostic-no-quality-acceptance';
} catch (error) { report.status = 'fail'; report.failure = error.stack; throw error; }
finally { await browser.close(); await save(); }
