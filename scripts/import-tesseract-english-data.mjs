// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Data-only importer. It never loads or compiles the upstream OCR executor.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { resolve } from 'node:path';
import { decodeTesseractEnglishData } from '../src/engines/tesseract-data.js';

const accepted = process.argv.includes('--accepted-independent');
const args = process.argv.slice(2).filter(value => value !== '--accepted-independent');
const input = args[0], output = resolve(args[1] || '.cache/tesseract-english-candidate');
if (!input) throw new Error('Usage: node scripts/import-tesseract-english-data.mjs RETAINED-eng.traineddata[.gz] [OUTPUT_DIRECTORY] [--accepted-independent]');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const source = await readFile(input), compressed = source[0] === 31 && source[1] === 139;
if (compressed && hash(source) !== 'ed350f3752f81ee8f38769edc14d92d997dababe23b565c59879372cc46a2468') throw new Error('Retained English model gzip pin differs.');
const bytes = compressed ? gunzipSync(source, { maxOutputLength: 32 * 1024 * 1024 }) : source;
if (hash(bytes) !== 'daa0c97d651c19fba3b25e81317cd697e9908c8208090c94c3905381c23fc047') throw new Error('Retained English traineddata pin differs.');
const model = decodeTesseractEnglishData(bytes), chunks = [];
let offset = 0;
function append(data) {
  const padding = (16 - offset % 16) % 16;
  if (padding) { chunks.push(Buffer.alloc(padding)); offset += padding; }
  const result = { offset, bytes: data.byteLength };
  chunks.push(Buffer.from(data.buffer, data.byteOffset, data.byteLength)); offset += data.byteLength; return result;
}
const json = JSON.parse(JSON.stringify(model, (key, value) => {
  if (value instanceof Int8Array) return { type: 'int8', ...append(value) };
  if (value instanceof Float64Array) return { type: 'float32', ...append(Float32Array.from(value)) };
  return value;
}));
const weights = Buffer.concat(chunks);
await mkdir(output, { recursive: true });
const manifest = { schema: 'pagenarrator-english-lstm-v1', candidateOnly: !accepted,
  productionSelection: accepted ? 'independent-line-verification' : 'unchanged',
  source: { model: 'tesseract-ocr/tessdata/eng.traineddata', revision: '590567f20dc044f6948a8e2c61afc714c360ad0e',
    sha256: hash(bytes), bytes: bytes.length, gitBlobSha1: 'f4744c201359d02ced6914c77f0de68ee9bbdd74', license: 'Apache-2.0',
    upstream: 'https://github.com/tesseract-ocr/tessdata/blob/590567f20dc044f6948a8e2c61afc714c360ad0e/eng.traineddata',
    licenseUrl: 'https://github.com/tesseract-ocr/tessdata/blob/590567f20dc044f6948a8e2c61afc714c360ad0e/COPYING',
    retainedMirror: '@tesseract.js-data/eng@1.0.0/4.0.0/eng.traineddata.gz',
    transformation: 'Learned LSTM int8 matrices and character recoder only; scales rounded to float32; no DAWG dictionaries, legacy classifier or executable code.' },
  weights: { path: accepted ? 'english-lstm.bin' : 'weights.bin', bytes: weights.length, sha256: hash(weights) }, ...json };
if (accepted) {
  const notices = [
    ['english-lstm-COPYING.txt', new URL('../vendor/ocr-data/tessdata-COPYING.txt', import.meta.url)],
    ['english-lstm-LICENSE.txt', new URL('../public/legal/Apache-2.0.txt', import.meta.url)],
  ];
  manifest.licenseFiles = [];
  for (const [path, url] of notices) {
    const notice = await readFile(url);
    if (path.endsWith('COPYING.txt') && hash(notice) !== '85c31da65107d18490666cc8e3af6373b5303fb57f82b97119d47ad219896800') throw new Error('Pinned upstream learned-data notice differs.');
    if (path.endsWith('LICENSE.txt') && !notice.toString('utf8').includes('Version 2.0, January 2004')) throw new Error('Full Apache 2.0 license text is missing.');
    await writeFile(resolve(output, path), notice);
    manifest.licenseFiles.push({ path, bytes: notice.length, sha256: hash(notice) });
  }
}
await writeFile(resolve(output, manifest.weights.path), weights);
await writeFile(resolve(output, accepted ? 'english-lstm.json' : 'model.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Imported retained learned data only: ${weights.length} bytes, ${manifest.alphabet.length} classes; ${manifest.productionSelection}.`);
