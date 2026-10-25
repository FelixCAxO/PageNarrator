// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const source = new URL('../native/phonemizer.cpp', import.meta.url);
const output = new URL('../public/assets/phonemizer/english.wasm', import.meta.url);
const metadata = new URL('../public/assets/phonemizer/english.json', import.meta.url);
const hash = url => createHash('sha256').update(readFileSync(url)).digest('hex');
const flags = ['c++', '-target', 'wasm32-freestanding', '-std=c++20', '-O3', '-fno-exceptions', '-fno-rtti', '-fno-builtin', '-nostdlib',
  '-Wl,-z,stack-size=65536,--no-entry,--export=pn_abi_version,--export=pn_initialize,--export=pn_lookup,--export=pn_g2p,--export=__heap_base,--export-memory,--initial-memory=131072,--max-memory=33554432,--strip-all'];
if (process.argv.includes('--check')) {
  const recorded = JSON.parse(readFileSync(metadata, 'utf8'));
  if (recorded.sourceSha256 !== hash(source) || recorded.wasmSha256 !== hash(output) || JSON.stringify(recorded.flags) !== JSON.stringify(flags)) throw new Error('First-party phonemizer source/binary mismatch.');
  console.log('First-party phonemizer source and binary hashes match.');
} else {
  const compiler = process.env.PN_ZIG || 'zig';
  const version = spawnSync(compiler, ['version'], { encoding: 'utf8' });
  if (version.status !== 0 || version.stdout.trim() !== '0.15.2') throw new Error('Set PN_ZIG to Zig 0.15.2.');
  mkdirSync(new URL('../public/assets/phonemizer/', import.meta.url), { recursive: true });
  const built = spawnSync(compiler, [...flags, fileURLToPath(source), '-o', fileURLToPath(output)], { stdio: 'inherit' });
  if (built.status !== 0) throw new Error('First-party phonemizer compilation failed.');
  const module = await WebAssembly.compile(readFileSync(output));
  if (WebAssembly.Module.imports(module).length) throw new Error('Phonemizer unexpectedly imports an executable runtime.');
  writeFileSync(metadata, `${JSON.stringify({ abi: 1, compiler: 'Zig 0.15.2 (Clang C++)', flags, sourceSha256: hash(source), wasmSha256: hash(output), imports: [] }, null, 2)}\n`);
  console.log(`Built independent English phonemizer: ${readFileSync(output).length} bytes.`);
}
