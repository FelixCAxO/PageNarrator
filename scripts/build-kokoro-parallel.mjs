// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const file = path => new URL(`../${path}`, import.meta.url);
const hash = path => createHash('sha256').update(readFileSync(file(path))).digest('hex');
const original = JSON.parse(readFileSync(file('public/native/kokoro-engine.json'), 'utf8'));
for (const [path, expected] of Object.entries(original.sourceSha256)) {
  if (hash(path) !== expected) throw new Error(`Original speech source changed: ${path}. Rebuild its single-worker engine first.`);
}
if (hash('public/native/kokoro-engine.wasm') !== original.wasmSha256) throw new Error('Original speech binary does not match its source manifest.');
const sources = ['native/kokoro-parallel.cpp', ...Object.keys(original.sourceSha256)];
const sourceSha256 = () => Object.fromEntries(sources.map(path => [path, hash(path)]));
const flags = [...original.flags, '-matomics', '-mbulk-memory',
  '-Wl,--shared-memory,--import-memory,--export=__stack_pointer,--export=pn_parallel_abi_version,--export=pn_kokoro_conv_integer_rows'];
const output = file('public/native/kokoro-parallel.wasm');
const metadata = file('public/native/kokoro-parallel.json');
const imports = [{ module: 'env', name: 'memory', kind: 'memory' }];
const parallelAbi = 0x504e5201;

if (process.argv.includes('--check')) {
  const recorded = JSON.parse(readFileSync(metadata, 'utf8'));
  if (recorded.abi !== 1 || recorded.parallelAbi !== parallelAbi || recorded.maximumMemoryBytes !== 536870912
    || JSON.stringify(recorded.sourceSha256) !== JSON.stringify(sourceSha256())
    || recorded.originalWasmSha256 !== original.wasmSha256
    || recorded.wasmSha256 !== hash('public/native/kokoro-parallel.wasm')
    || JSON.stringify(recorded.flags) !== JSON.stringify(flags)
    || JSON.stringify(recorded.imports) !== JSON.stringify(imports)) {
    throw new Error('Parallel speech source/binary mismatch; rebuild with Zig 0.15.2.');
  }
} else {
  const compiler = process.env.PN_ZIG || 'zig';
  const version = spawnSync(compiler, ['version'], { encoding: 'utf8' });
  if (version.status !== 0 || version.stdout.trim() !== '0.15.2') throw new Error('Set PN_ZIG to Zig 0.15.2.');
  mkdirSync(file('public/native/'), { recursive: true });
  const built = spawnSync(compiler, [...flags, fileURLToPath(file(sources[0])), '-o', fileURLToPath(output)], { cwd: root, stdio: 'inherit' });
  if (built.status !== 0) throw new Error(`Parallel speech C++ compilation failed (${built.status}).`);
  writeFileSync(metadata, `${JSON.stringify({ abi: 1, parallelAbi, compiler: 'Zig 0.15.2 (Clang C++)',
    flags, sourceSha256: sourceSha256(), originalWasmSha256: original.wasmSha256,
    wasmSha256: hash('public/native/kokoro-parallel.wasm'), imports, maximumMemoryBytes: 536870912 }, null, 2)}\n`);
}
const module = new WebAssembly.Module(readFileSync(output));
if (JSON.stringify(WebAssembly.Module.imports(module)) !== JSON.stringify(imports)) throw new Error('Parallel speech allows exactly one platform memory import, with no executable imports.');
const names = new Map(WebAssembly.Module.exports(module).map(item => [item.name, item.kind]));
for (const [name, kind] of [['memory', 'memory'], ['__heap_base', 'global'], ['__stack_pointer', 'global'],
  ['pn_abi_version', 'function'], ['pn_parallel_abi_version', 'function'], ['pn_kokoro_conv_integer_rows', 'function']]) {
  if (names.get(name) !== kind) throw new Error(`Parallel speech export missing or invalid: ${name}.`);
}
console.log(`Original parallel speech C++/WASM verified: ${readFileSync(output).byteLength} bytes, platform memory import only.`);
