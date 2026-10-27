// Decode real PDF bytes through each parser; compare the entire spoken token stream.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as original from '../src/pdf/pdf-engine.js';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { configurePdfWorker, extractPdfTextFromData } from '../src/lib/pdf-extraction.js';
import { tokenizeSpokenWords } from '../src/lib/speech-tokenization.js';
import { chunkText } from '../src/lib/speech-chunks.js';
import { buildPdfBytes } from '../tests/helpers/pdf-test-generator.js';
import { readingOrderPatterns, buildReadingOrderPattern } from '../tests/helpers/reading-order-patterns.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'artifacts/reading-order-patterns', process.argv[2] || 'pdf-lanes');
const family = process.argv.find(value => value.startsWith('--family='))?.slice('--family='.length) || null;
assert.ok(family === null || ['table', 'prose', 'sidenote'].includes(family), 'Unknown reading-order family');
await mkdir(output, { recursive: true });
const pinFiles = ['native/pdf.wasm', 'vendor/pdf-data/standard14_metrics/Helvetica.afm',
  'tests/helpers/reading-order-patterns.js', 'tests/helpers/sidenote-reading-order-patterns.js', 'tests/helpers/pdf-test-generator.js', 'scripts/audit-reading-order-pdf.mjs'];
async function visit(directory) {
  for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
    const name = `${directory}/${entry.name}`;
    if (entry.isDirectory()) await visit(name); else if (entry.isFile()) pinFiles.push(name);
  }
}
await visit('src');
const pins = async () => Object.fromEntries(await Promise.all(pinFiles.sort().map(async file => [file,
  createHash('sha256').update(await readFile(path.join(root, file))).digest('hex')])));
const sourcePins = await pins();
const afm = await readFile(path.join(root, 'vendor/pdf-data/standard14_metrics/Helvetica.afm'), 'ascii');
const advances = new Map([...afm.matchAll(/^C (\d+) ; WX (\d+) ;/gm)].map(match => [Number(match[1]), Number(match[2])]));
const measureText = (text, height) => [...text].reduce((width, char) => {
  assert.ok(advances.has(char.charCodeAt(0)), `Missing independent font metric for ${char}`);
  return width + advances.get(char.charCodeAt(0)) * height / 1000;
}, 0);
const wasm = new Uint8Array(await readFile(path.join(root, 'native/pdf.wasm')));
const loadAsset = async name => new Uint8Array(await readFile(path.join(root, 'vendor/pdf-data', name)));
const backends = { original: { ...original, getDocument: input => original.getDocument({ ...input, wasm, loadAsset, disableWorker: true }) }, pdfjs };
configurePdfWorker(pdfjs);
const tokens = text => tokenizeSpokenWords(text).map(token => token.text);
const ledger = await open(path.join(output, 'results.jsonl'), 'w');
const started = performance.now(), totals = {}, failures = [], records = [];
let count = 0;
try {
  for (const pattern of readingOrderPatterns()) {
    if (family && !pattern.id.startsWith(`${family}-`)) continue;
    if (pattern.parameters.source !== 'pdf-text') continue;
    const fixture = buildReadingOrderPattern(pattern, { measureText });
    const bytes = buildPdfBytes([{ items: fixture.items, width: fixture.options.pageView[2], height: fixture.options.pageView[3], rotation: fixture.options.pageRotation || 0 }]);
    const expected = tokens(fixture.expectedText.join(' '));
    for (const [backend, implementation] of Object.entries(backends)) {
      let actual = [], error = null, words = 0, chunks = 0;
      try {
        const result = await extractPdfTextFromData(bytes.slice(), { pdfjs: implementation });
        const stream = chunkText(result.chunks, { maxLen: 180, targetMinLen: 60 });
        actual = tokens(stream.map(chunk => chunk.speech).join(' '));
        assert.deepEqual(actual, expected);
        for (const chunk of stream) {
          assert.equal(chunk.anchorId, 'pdf-page-1');
          assert.equal(chunk.domWordOffset ?? 0, words);
          const chunkTokens = tokens(chunk.speech);
          assert.deepEqual(chunkTokens, expected.slice(words, words + chunkTokens.length));
          words += chunkTokens.length;
        }
        chunks = stream.length;
      } catch (failure) { error = String(failure.message || failure).slice(0, 1200); }
      const status = error ? 'failed' : 'passed';
      const record = { id: pattern.id, family: pattern.family, parameters: pattern.parameters, backend, status, error,
        sourceSha256: createHash('sha256').update(bytes).digest('hex'), expected, actual, chunks, wordOffsetsChecked: words };
      await ledger.write(JSON.stringify(record) + '\n');
      totals[backend] ||= { passed: 0, failed: 0 };
      totals[backend][status] += 1;
      records.push({ id: record.id, backend, status, parameters: pattern.parameters });
      if (error) failures.push({ id: record.id, backend, error });
      count += 1;
      if (count % 2000 === 0) console.log(JSON.stringify({ checked: count, totals }));
    }
  }
} finally { await ledger.close(); }
const sourcePinsUnchanged = JSON.stringify(sourcePins) === JSON.stringify(await pins());
const summary = { generatedAt: new Date().toISOString(), scope: 'Real generated PDF bytes: complete ordered speech tokens and stream word offsets through the original parser and PDF.js. No OCR recognition or live browser highlight claim.',
  family, patterns: records.length / 2, checks: count, totals, failed: failures.length, sourcePins, sourcePinsUnchanged,
  elapsedMs: Math.round(performance.now() - started), complete: failures.length === 0 && sourcePinsUnchanged };
await writeFile(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
await writeFile(path.join(output, 'failures.json'), JSON.stringify(failures, null, 2) + '\n');
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
await writeFile(path.join(output, 'report.html'), `<!doctype html><html lang="en"><meta charset="utf-8"><title>PDF reading order audit</title><style>body{font:14px system-ui;margin:24px}td,th{padding:6px;border-bottom:1px solid #ddd;text-align:left}tr[data-status=failed]{color:#a00}</style><h1>PDF reading order audit</h1><p>${count} individually recorded checks; ${failures.length} failed. Full expected/actual token arrays and PDF hashes are in results.jsonl.</p><p>${escape(summary.scope)}</p><table><thead><tr><th>Pattern</th><th>Parser</th><th>Result</th><th>Parameters</th></tr></thead><tbody>${records.map(record => `<tr data-status="${record.status}"><td>${record.id}</td><td>${record.backend}</td><td>${record.status}</td><td>${escape(JSON.stringify(record.parameters))}</td></tr>`).join('\n')}</tbody></table></html>`);
console.log(JSON.stringify({ output, ...summary, sourcePins: undefined }, null, 2));
if (!summary.complete) process.exitCode = 1;
