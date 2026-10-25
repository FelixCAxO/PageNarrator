// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = new URL('../native/ocr-engine.cpp', import.meta.url);
const shared = new URL('../native/engine.cpp', import.meta.url);
const output = new URL('../public/native/ocr-engine.wasm', import.meta.url);
const metadata = new URL('../public/native/ocr-engine.json', import.meta.url);
const hash = url => createHash('sha256').update(readFileSync(url)).digest('hex');
const exports = ['pn_abi_version', 'pn_unary', 'pn_ocr_unary', 'pn_ocr_binary', 'pn_ocr_matmul', 'pn_ocr_conv', 'pn_ocr_reduce',
  'pn_ocr_pool', 'pn_ocr_resize', 'pn_ocr_index', 'pn_ocr_concat', 'pn_ocr_gather', 'pn_ocr_norm', 'pn_ocr_softmax', 'pn_ocr_argmax', 'pn_ocr_copy', '__heap_base'];
const flags = ['c++', '-target', 'wasm32-freestanding', '-std=c++20', '-O3', '-msimd128', '-ffp-contract=off',
  '-fno-exceptions', '-fno-rtti', '-fno-builtin', '-nostdlib',
  `-Wl,-z,stack-size=65536,--no-entry,${exports.map(name => `--export=${name}`).join(',')},--export-memory,--initial-memory=131072,--max-memory=536870912,--strip-all`];

if (process.argv.includes('--check')) {
  const recorded = JSON.parse(readFileSync(metadata, 'utf8'));
  if (recorded.sourceSha256 !== hash(source) || recorded.sharedSourceSha256 !== hash(shared) || recorded.wasmSha256 !== hash(output)
    || JSON.stringify(recorded.flags) !== JSON.stringify(flags)) throw new Error('OCR engine source/binary mismatch. Rebuild with Zig 0.15.2.');
  if (WebAssembly.Module.imports(await WebAssembly.compile(readFileSync(output))).length) throw new Error('OCR engine must not import executable code.');
  console.log('First-party OCR source and binary hashes match.');
} else {
  const compiler = process.env.PN_ZIG || 'zig';
  const version = spawnSync(compiler, ['version'], { encoding: 'utf8' });
  if (version.status !== 0 || version.stdout.trim() !== '0.15.2') throw new Error('Set PN_ZIG to the Zig 0.15.2 executable.');
  mkdirSync(new URL('../public/native/', import.meta.url), { recursive: true });
  const built = spawnSync(compiler, [...flags, fileURLToPath(source), '-o', fileURLToPath(output)], { cwd: root, stdio: 'inherit' });
  if (built.status !== 0) throw new Error(`OCR engine compilation failed (${built.status}).`);
  if (WebAssembly.Module.imports(await WebAssembly.compile(readFileSync(output))).length) throw new Error('OCR engine unexpectedly imports a runtime.');
  writeFileSync(metadata, `${JSON.stringify({ abi: 1, compiler: 'Zig 0.15.2 (Clang C++)', flags,
    sourceSha256: hash(source), sharedSourceSha256: hash(shared), wasmSha256: hash(output), imports: [] }, null, 2)}\n`);
  console.log(`Built first-party OCR C++/WASM: ${readFileSync(output).byteLength} bytes, no imports.`);
}
