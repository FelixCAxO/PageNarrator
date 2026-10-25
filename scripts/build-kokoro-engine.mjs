// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const files = ['native/kokoro-engine.cpp', 'native/ocr-engine.cpp', 'native/engine.cpp'];
const output = new URL('../public/native/kokoro-engine.wasm', import.meta.url), metadata = new URL('../public/native/kokoro-engine.json', import.meta.url);
const hash = url => createHash('sha256').update(readFileSync(url)).digest('hex');
const exports = ['pn_abi_version', 'pn_unary', 'pn_ocr_unary', 'pn_ocr_binary', 'pn_ocr_matmul', 'pn_ocr_conv', 'pn_ocr_reduce', 'pn_ocr_pool', 'pn_ocr_resize', 'pn_ocr_index', 'pn_ocr_concat', 'pn_ocr_gather', 'pn_ocr_norm', 'pn_ocr_softmax', 'pn_ocr_argmax', 'pn_ocr_copy',
  'pn_kokoro_unary', 'pn_kokoro_layer_norm', 'pn_kokoro_lstm', 'pn_kokoro_stft', 'pn_kokoro_snake', 'pn_kokoro_cumsum', 'pn_kokoro_scatter', 'pn_kokoro_conv_transpose',
  'pn_kokoro_dynamic_quantize', 'pn_kokoro_dequantize', 'pn_kokoro_matmul_integer', 'pn_kokoro_conv_integer', 'pn_kokoro_dynamic_lstm', 'pn_kokoro_cast', 'pn_kokoro_compare', 'pn_kokoro_where', 'pn_kokoro_pad', 'pn_kokoro_gather', 'pn_kokoro_integer_binary', 'pn_kokoro_range', 'pn_kokoro_fill', 'pn_kokoro_power', '__heap_base'];
const flags = ['c++', '-target', 'wasm32-freestanding', '-std=c++20', '-O3', '-msimd128', '-ffp-contract=off', '-fno-exceptions', '-fno-rtti', '-fno-builtin', '-nostdlib',
  `-Wl,-z,stack-size=65536,--no-entry,${exports.map(name => `--export=${name}`).join(',')},--export-memory,--initial-memory=131072,--max-memory=536870912,--strip-all`];
const sourceSha256 = () => Object.fromEntries(files.map(file => [file, hash(new URL(`../${file}`, import.meta.url))]));
if (process.argv.includes('--check')) {
  const recorded = JSON.parse(readFileSync(metadata, 'utf8'));
  if (JSON.stringify(recorded.sourceSha256) !== JSON.stringify(sourceSha256()) || recorded.wasmSha256 !== hash(output)
    || JSON.stringify(recorded.flags) !== JSON.stringify(flags)) throw new Error('Speech engine source/binary mismatch; rebuild with Zig 0.15.2.');
} else {
  const compiler = process.env.PN_ZIG || 'zig', version = spawnSync(compiler, ['version'], { encoding: 'utf8' });
  if (version.status !== 0 || version.stdout.trim() !== '0.15.2') throw new Error('Set PN_ZIG to Zig 0.15.2.');
  mkdirSync(new URL('../public/native/', import.meta.url), { recursive: true });
  const built = spawnSync(compiler, [...flags, fileURLToPath(new URL(`../${files[0]}`, import.meta.url)), '-o', fileURLToPath(output)], { cwd: root, stdio: 'inherit' });
  if (built.status !== 0) throw new Error(`Speech C++ compilation failed (${built.status}).`);
  writeFileSync(metadata, `${JSON.stringify({ abi: 1, compiler: 'Zig 0.15.2 (Clang C++)', flags, sourceSha256: sourceSha256(), wasmSha256: hash(output), imports: [] }, null, 2)}\n`);
}
if (WebAssembly.Module.imports(await WebAssembly.compile(readFileSync(output))).length) throw new Error('Speech engine must not import executable code.');
console.log(`First-party speech C++/WASM verified: ${readFileSync(output).byteLength} bytes, no imports.`);
