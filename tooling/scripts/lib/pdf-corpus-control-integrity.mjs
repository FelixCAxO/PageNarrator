// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Development report integrity only. No PDF, oracle, model or browser is opened here.
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const PIN_FILES = [
  'engines/native/pdf.wasm', 'engines/native/pdf.json',
  // Exact source/header inputs hashed by tooling/scripts/build-native-pdf.mjs.
  'engines/native/pdf.cpp',
  'engines/native/pdf-type1.cpp',
  'engines/native/pdf-codecs.cpp',
  'engines/native/pdf-jpeg.cpp',
  'engines/native/pdf-fax.cpp',
  'engines/native/pdf-jbig2.cpp',
  'engines/native/pdf-mq.h',
  'engines/native/pdf-crypto.cpp',
  'engines/native/pdf-crypto.h',
  'engines/native/pdf-jpx.cpp',
  'engines/native/pdf-inline.cpp',
  'engines/native/pdf-cff-path.cpp',
  'engines/native/pdf-ttf-path.cpp',
  'tests/fixtures/pdf-acceptance-manifest.js', 'tests/helpers/pdf-benchmark-gold.js',
  'tooling/scripts/probe-pdf-engine.mjs', 'tooling/scripts/pdf-acceptance-metrics.mjs',
  'tooling/scripts/lib/pdf-corpus-control-integrity.mjs',
  'src/lib/highlight-search.js', 'src/lib/logger.js', 'src/lib/numeric-matrix.js',
  'src/lib/pdf-extraction.js', 'src/lib/pdf-page-model.js',
  'src/lib/pdf-vertical-model.js',
  'src/lib/speech-chunks.js', 'src/lib/speech-tokenization.js', 'src/lib/storage-keys.js',
  'src/lib/tuning-config.js',
];
const PIN_DIRECTORIES = ['src/pdf', 'engines/vendor/pdf-data', 'engines/vendor/pdf-cmaps',
  'engines/vendor/pdf-glyphs', 'engines/vendor/pdf-unicode', 'engines/vendor/pdf-symbols'];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const hashPattern = /^[a-f0-9]{64}$/u;
const fail = message => { throw new Error('Invalid current PDF corpus control: ' + message); };
const equal = (actual, expected) => JSON.stringify(actual) === JSON.stringify(expected);

// Shared by producer and parity consumer so their complete pin sets cannot diverge.
export async function readPdfCorpusImplementationPins(root) {
  const files = new Set(PIN_FILES);
  async function visit(relative) {
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      const filename = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await visit(filename);
      else if (entry.isFile()) files.add(filename);
      else throw new Error(`Unsupported PDF pin entry ${filename}.`);
    }
  }
  for (const directory of PIN_DIRECTORIES) await visit(directory);
  const pins = [];
  for (const filename of [...files].sort()) {
    const bytes = await readFile(path.join(root, filename));
    pins.push({ path: filename, bytes: bytes.length, sha256: sha256(bytes) });
  }
  return pins;
}

// Preserve the existing sourceSha256 algorithm, independently of the larger pin set.
export async function readPdfCorpusSourceSha256(root) {
  const hash = createHash('sha256');
  for (const name of (await readdir(path.join(root, 'src/pdf'))).filter(name => name.endsWith('.js')).sort()) {
    hash.update(name); hash.update(await readFile(path.join(root, 'src/pdf', name)));
  }
  return hash.digest('hex');
}

export function assertCurrentPdfCorpusControl(own, { records, goldEvidence, implementationPins, sourceSha256, wasmSha256 }) {
  if (!Array.isArray(records) || records.length !== 100) fail('expected exact100-record manifest.');
  if (!own || own.schemaVersion !== 1 || own.controlIntegrityVersion !== 1 || own.backend !== 'original' || own.total !== 100 || own.parsed !== 100
    || !Array.isArray(own.records) || own.records.length !== 100) fail('complete parsed100-record set required.');
  if (!own.failures || Array.isArray(own.failures) || typeof own.failures !== 'object' || Object.keys(own.failures).length) fail('parsed100 control has missing/nonempty parse-failure summary.');
  const ids = new Set();
  for (let index = 0; index < records.length; index++) {
    const expected = records[index], actual = own.records[index];
    if (!actual || ids.has(actual.id)) fail('missing/duplicate record at index ' + index + '.');
    ids.add(actual.id);
    for (const key of ['id', 'source', 'pageNumber', 'categories']) {
      if (!equal(actual[key], expected[key])) fail('record identity/order/' + key + ' differs at index ' + index + '.');
    }
    if (actual.sha256 !== expected.sha256 || actual.status !== 'parsed') fail('source digest/status differs for ' + expected.id + '.');
    if (typeof actual.text !== 'string' || typeof actual.speech !== 'string' || typeof actual.readingOrder !== 'boolean'
      || ![actual.items, actual.narrationErrors, actual.unmappedGlyphs, actual.recognizedSymbolGlyphs].every(value => Number.isSafeInteger(value) && value >= 0)) {
      fail('parsed result fields missing/malformed for ' + expected.id + '.');
    }
  }
  if (own.readingOrderPassed !== own.records.filter(record => record.readingOrder && record.unmappedGlyphs === 0).length
    || own.narrationClean !== own.records.filter(record => record.narrationErrors === 0 && record.unmappedGlyphs === 0).length
    || own.recognizedSymbolGlyphs !== own.records.reduce((sum, record) => sum + record.recognizedSymbolGlyphs, 0)) fail('summary counts disagree with complete records.');
  if (!hashPattern.test(sourceSha256) || !hashPattern.test(wasmSha256) || own.sourceSha256 !== sourceSha256 || own.wasmSha256 !== wasmSha256) {
    fail('current source/WASM digest differs or is missing.');
  }
  if (own.implementationPinsUnchanged !== true || !Array.isArray(implementationPins) || !implementationPins.length
    || !Array.isArray(own.implementationPins) || own.implementationPins.length !== implementationPins.length) fail('current implementation pin set missing/drifted.');
  for (let index = 0; index < implementationPins.length; index++) {
    const expected = implementationPins[index], actual = own.implementationPins[index];
    if (!actual || !['path', 'bytes', 'sha256'].every(key => actual[key] === expected[key])) fail('current implementation pin differs at index ' + index + '.');
  }
  const pageModel = implementationPins.find(pin => pin.path === 'src/lib/pdf-page-model.js');
  const wasm = implementationPins.find(pin => pin.path === 'engines/native/pdf.wasm');
  if (!pageModel || !hashPattern.test(pageModel.sha256) || !wasm || wasm.sha256 !== wasmSha256) fail('required page-model/WASM pin absent/inconsistent.');
  if (!goldEvidence || !own.goldEvidence || typeof own.goldEvidence.path !== 'string' || !own.goldEvidence.path.trim()) fail('explicit historical gold evidence missing.');
  for (const key of ['bytes', 'sha256', 'historicalManifestSha256', 'historicalRealPaperRecords']) {
    if (own.goldEvidence[key] !== goldEvidence[key]) fail('historical gold evidence differs: ' + key + '.');
  }
  return Object.freeze({ records: 100, currentImplementationPins: implementationPins.length,
    sourceSha256, wasmSha256, pageModelSha256: pageModel.sha256, goldSha256: goldEvidence.sha256 });
}
