// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const sources = ['ocr-lstm-engine.cpp', 'ocr-engine.cpp', 'engine.cpp'];
const hash = path => createHash('sha256').update(readFileSync(new URL(path, import.meta.url))).digest('hex');
const base = JSON.parse(readFileSync(new URL('../public/native/ocr-engine.json', import.meta.url), 'utf8'));
const added = ['pn_tess_tables', 'pn_tess_seed', 'pn_tess_conv', 'pn_tess_pool', 'pn_tess_lstm', 'pn_tess_affine'];
const flags = base.flags.map(flag => flag.startsWith('-Wl,') ? `${flag},${added.map(name => `--export=${name}`).join(',')}` : flag);
const wasm = new URL('../public/native/ocr-lstm-engine.wasm', import.meta.url), metadata = new URL('../public/native/ocr-lstm-engine.json', import.meta.url);
const sourceHashes = Object.fromEntries(sources.map(name => [name, hash(`../native/${name}`)]));
if (process.argv.includes('--check')) {
  const previous = JSON.parse(readFileSync(metadata, 'utf8'));
  if (JSON.stringify(previous.sources) !== JSON.stringify(sourceHashes) || previous.wasmSha256 !== hash('../public/native/ocr-lstm-engine.wasm')
    || JSON.stringify(previous.flags) !== JSON.stringify(flags)) throw new Error('Original OCR LSTM source/binary mismatch.');
} else {
  const compiler = process.env.PN_ZIG || 'zig';
  const version = spawnSync(compiler, ['version'], { encoding: 'utf8' });
  if (version.status !== 0 || version.stdout.trim() !== '0.15.2') throw new Error('Set PN_ZIG to Zig0.15.2.');
  const built = spawnSync(compiler, [...flags, fileURLToPath(new URL('../native/ocr-lstm-engine.cpp', import.meta.url)), '-o', fileURLToPath(wasm)], { cwd: root, stdio: 'inherit' });
  if (built.status !== 0) throw new Error('Original OCR LSTM compilation failed.');
  writeFileSync(metadata, `${JSON.stringify({ abi: 1, compiler: 'Zig0.15.2 (Clang C++)', flags, sources: sourceHashes,
    wasmSha256: hash('../public/native/ocr-lstm-engine.wasm'), imports: [] }, null, 2)}\n`);
}
if (WebAssembly.Module.imports(await WebAssembly.compile(readFileSync(wasm))).length) throw new Error('Original OCR LSTM must not import executable code.');
console.log(`Original OCR LSTM WASM verified: ${readFileSync(wasm).length}bytes, zeroimports.`);
