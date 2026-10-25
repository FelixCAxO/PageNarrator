// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Build verification only: no compilation, downloading, or manifest rewriting.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

for (const script of ['build-browser-phonemizer', 'build-pronunciation-data', 'build-ocr-engine', 'build-ocr-lstm-engine',
  'build-kokoro-engine', 'build-kokoro-parallel', 'build-native-pdf', 'import-pdf-data', 'import-pdf-cmaps', 'import-pdf-glyphs', 'import-pdf-unicode', 'import-pdf-symbols']) {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL(`${script}.mjs`, import.meta.url)), '--check'], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`Browser engine artifact check failed: ${script}.`);
}
const directory = new URL('../public/assets/ocr/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('english-lstm.json', directory), 'utf8'));
if (manifest.candidateOnly !== false || manifest.productionSelection !== 'independent-line-verification' || manifest.source?.license !== 'Apache-2.0'
  || !Array.isArray(manifest.licenseFiles) || manifest.licenseFiles.length !== 2) throw new Error('Invalid retained English OCR data declaration.');
for (const file of [manifest.weights, ...manifest.licenseFiles]) {
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(file.path)) throw new Error('Retained OCR data must use a local basename.');
  const bytes = readFileSync(new URL(file.path, directory));
  if (bytes.length !== file.bytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error(`Retained OCR data/notice mismatch: ${file.path}.`);
}
console.log('Original browser engine binaries and retained data/notices match their sources.');
