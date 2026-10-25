import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { copyOriginalPdfAssets } from '../../build/pdf-assets.js';

describe('original PDF packaged assets', () => {
  it('ships only the original import-free parser and every pinned data file and notice', async () => {
    const emitted = new Map(), plugin = copyOriginalPdfAssets();
    plugin.configResolved({ root: resolve('.') });
    plugin.generateBundle.call({ emitFile: asset => {
      expect(emitted.has(asset.fileName), asset.fileName).toBe(false);
      emitted.set(asset.fileName, asset.source);
    } });
    const parser = await WebAssembly.compile(emitted.get('assets/pdf-engine/pdf.wasm'));
    expect(WebAssembly.Module.imports(parser)).toEqual([]);
    let expectedFiles = 1;
    for (const directory of ['pdf-data', 'pdf-cmaps']) {
      const manifestBytes = readFileSync(`vendor/${directory}/manifest.json`);
      expect(emitted.get(`assets/${directory}/manifest.json`)).toEqual(manifestBytes);
      const manifest = JSON.parse(manifestBytes);
      expectedFiles += manifest.files.length + 1;
      for (const file of manifest.files) {
        const source = emitted.get(`assets/${directory}/${file.path}`);
        expect(source.length, file.path).toBe(file.bytes);
        expect(createHash('sha256').update(source).digest('hex'), file.path).toBe(file.sha256);
      }
    }
    expect(emitted.size).toBe(expectedFiles);
    expect([...emitted.keys()].filter(path => /\.(?:js|mjs|wasm)$/u.test(path))).toEqual(['assets/pdf-engine/pdf.wasm']);
  });
});
