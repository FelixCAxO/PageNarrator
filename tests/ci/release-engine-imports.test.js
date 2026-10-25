import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { verifyOriginalEngineImports } from '../../scripts/lib/release-engine-files.mjs';

const shared = 'native/kokoro-parallel.wasm';
const memory = { module: 'env', name: 'memory', kind: 'memory' };

it('admits the actual bundled parallel module and retains the zero-import single-worker engine', () => {
  for (const name of ['kokoro-parallel', 'kokoro-engine']) {
    const module = new WebAssembly.Module(readFileSync(new URL(`../../public/native/${name}.wasm`, import.meta.url)));
    const imports = WebAssembly.Module.imports(module);
    expect(imports).toEqual(name === 'kokoro-parallel' ? [memory] : []);
    expect(() => verifyOriginalEngineImports(`native/${name}.wasm`, imports)).not.toThrow();
  }
});

it.each([
  [shared, []],
  [shared, [memory, { module: 'env', name: 'execute', kind: 'function' }]],
  [shared, [{ ...memory, kind: 'function' }]],
  [shared, [{ ...memory, name: 'other' }]],
  [shared, [{ ...memory, module: 'remote' }]],
  ['native/kokoro-engine.wasm', [memory]],
  ['native/other.wasm', [memory]],
])('rejects unexpected imports in %s', (path, imports) => {
  expect(() => verifyOriginalEngineImports(path, imports)).toThrow(/unexpected runtime/);
});
