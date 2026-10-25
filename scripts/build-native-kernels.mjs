import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = new URL('../native/kernels.cpp', import.meta.url);
const binary = new URL('../public/native/kernels.wasm', import.meta.url);
const metadata = new URL('../public/native/kernels.json', import.meta.url);
const hash = url => createHash('sha256').update(readFileSync(url)).digest('hex');
const flags = ['c++', '-target', 'wasm32-freestanding', '-std=c++20', '-O3', '-msimd128',
  '-ffp-contract=off', '-fno-exceptions', '-fno-rtti', '-fno-builtin', '-nostdlib',
  '-Wl,-z,stack-size=65536,--no-entry,--export=pcm_process,--export=rgba_pack,--export=detector_components,--export=__heap_base,--export-memory,--initial-memory=131072,--max-memory=134217728,--strip-all'];

if (process.argv.includes('--check')) {
  const recorded = JSON.parse(readFileSync(metadata, 'utf8'));
  if (recorded.sourceSha256 !== hash(source) || recorded.wasmSha256 !== hash(binary)
      || JSON.stringify(recorded.flags) !== JSON.stringify(flags)) {
    throw new Error('Native kernel source/binary mismatch. Run npm run build:native with Zig 0.15.2.');
  }
  console.log('Native kernel source and binary hashes match.');
} else {
  const compiler = process.env.PN_ZIG || 'zig';
  const version = spawnSync(compiler, ['version'], { encoding: 'utf8' });
  if (version.status !== 0 || version.stdout.trim() !== '0.15.2') {
    throw new Error('Set PN_ZIG to the Zig 0.15.2 executable to rebuild the C++ WebAssembly kernels.');
  }
  mkdirSync(new URL('../public/native/', import.meta.url), { recursive: true });
  const result = spawnSync(compiler, [...flags, fileURLToPath(source), '-o', fileURLToPath(binary)], {
    cwd: root, stdio: 'inherit',
  });
  if (result.status !== 0) throw new Error(`Native kernel compilation failed (${result.status}).`);
  writeFileSync(metadata, `${JSON.stringify({ compiler: 'Zig 0.15.2 (Clang C++)', flags,
    sourceSha256: hash(source), wasmSha256: hash(binary) }, null, 2)}\n`);
  console.log(`Built native kernels: ${readFileSync(binary).byteLength} bytes.`);
}
