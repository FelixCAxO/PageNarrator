import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = new URL('../native/engine.cpp', import.meta.url);
const output = new URL('../public/native/engine.wasm', import.meta.url);
const metadata = new URL('../public/native/engine.json', import.meta.url);
const hash = url => createHash('sha256').update(readFileSync(url)).digest('hex');
const flags = ['c++', '-target', 'wasm32-freestanding', '-std=c++20', '-O3', '-msimd128',
  '-ffp-contract=off', '-fno-exceptions', '-fno-rtti', '-fno-builtin', '-nostdlib',
  '-Wl,-z,stack-size=65536,--no-entry,--export=pn_abi_version,--export=pn_matmul,--export=pn_binary,--export=pn_unary,--export=__heap_base,--export-memory,--initial-memory=131072,--max-memory=536870912,--strip-all'];

if (process.argv.includes('--check')) {
  const recorded = JSON.parse(readFileSync(metadata, 'utf8'));
  if (recorded.sourceSha256 !== hash(source) || recorded.wasmSha256 !== hash(output)
    || JSON.stringify(recorded.flags) !== JSON.stringify(flags)) throw new Error('First-party engine source/binary mismatch. Rebuild with Zig 0.15.2.');
  console.log('First-party engine source and binary hashes match.');
} else {
  const compiler = process.env.PN_ZIG || 'zig';
  const version = spawnSync(compiler, ['version'], { encoding: 'utf8' });
  if (version.status !== 0 || version.stdout.trim() !== '0.15.2') throw new Error('Set PN_ZIG to the Zig 0.15.2 executable.');
  mkdirSync(new URL('../public/native/', import.meta.url), { recursive: true });
  const built = spawnSync(compiler, [...flags, fileURLToPath(source), '-o', fileURLToPath(output)], { cwd: root, stdio: 'inherit' });
  if (built.status !== 0) throw new Error(`First-party engine compilation failed (${built.status}).`);
  const module = await WebAssembly.compile(readFileSync(output));
  if (WebAssembly.Module.imports(module).length) throw new Error('First-party engine unexpectedly imports a runtime.');
  writeFileSync(metadata, `${JSON.stringify({ abi: 1, compiler: 'Zig 0.15.2 (Clang C++)', flags,
    sourceSha256: hash(source), wasmSha256: hash(output), imports: [] }, null, 2)}\n`);
  console.log(`Built first-party C++/WASM engine: ${readFileSync(output).byteLength} bytes, no runtime imports.`);
}
