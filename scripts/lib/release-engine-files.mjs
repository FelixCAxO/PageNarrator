// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { closeSync, openSync, readFileSync, readSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

export const ORIGINAL_RUNTIME_FILES = Object.freeze([
  ...['kernels', 'engine', 'kokoro-engine', 'kokoro-parallel', 'ocr-engine', 'ocr-lstm-engine'].flatMap(name =>
    ['wasm', 'json'].map(extension => ({ path: `native/${name}.${extension}`, source: `public/native/${name}.${extension}` }))),
  ...['english.wasm', 'english.json', 'pronunciations.bin', 'pronunciations.json'].map(name =>
    ({ path: `assets/phonemizer/${name}`, source: `public/assets/phonemizer/${name}` })),
  { path: 'assets/pdf-engine/pdf.wasm', source: 'native/pdf.wasm' },
]);

/** Prebuild checks source hashes; packaging must retain those exact checked artifacts. */
export function verifyOriginalEngineFiles(directory, allFiles = []) {
  const binaries = new Set();
  for (const file of ORIGINAL_RUNTIME_FILES) {
    const bytes = readFileSync(resolve(directory, file.path));
    if (!bytes.equals(readFileSync(new URL(`../../${file.source}`, import.meta.url)))) throw new Error(`Packaged original engine/data mismatch: ${file.path}`);
    if (file.path.endsWith('.wasm')) verifyOriginalEngineImports(file.path, WebAssembly.Module.imports(new WebAssembly.Module(bytes)));
    if (file.path.endsWith('.wasm')) binaries.add(createHash('sha256').update(bytes).digest('hex'));
  }
  for (const path of allFiles) {
    if (!isWasmProgram(directory, path)) continue;
    const digest = createHash('sha256').update(readFileSync(resolve(directory, path))).digest('hex');
    if (!binaries.has(digest)) throw new Error(`Unrecognized executable WASM in release package: ${path}`);
  }
}

/** Only the separately verified shared speech module may import platform memory. */
export function verifyOriginalEngineImports(path, imports) {
  if (path === 'native/kokoro-parallel.wasm') {
    if (imports.length === 1 && imports[0].module === 'env' && imports[0].name === 'memory' && imports[0].kind === 'memory') return;
  } else if (imports.length === 0) return;
  throw new Error(`Original engine imports an executable or unexpected runtime: ${path}`);
}

function isWasmProgram(directory, path) {
  if (/\.wasm$/i.test(path)) return true;
  const header = Buffer.alloc(4), file = openSync(resolve(directory, path), 'r');
  try {
    return readSync(file, header, 0, 4, 0) === 4 && header.readUInt32BE(0) === 0x0061736d;
  } finally { closeSync(file); }
}
