// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Only the original parser and manifest-pinned declarative font/mapping data. */
export function copyOriginalPdfAssets() {
  let root;
  return {
    name: 'copy-original-pdf-assets',
    configResolved(config) { root = config.root; },
    generateBundle() {
      if (!root) throw new Error('PDF assets require a resolved build root.');
      const parser = readFileSync(resolve(root, 'native/pdf.wasm'));
      const parserManifest = JSON.parse(readFileSync(resolve(root, 'native/pdf.json')));
      if (createHash('sha256').update(parser).digest('hex') !== parserManifest.wasmSha256) throw new Error('PDF parser binary pin mismatch.');
      this.emitFile({ type: 'asset', fileName: 'assets/pdf-engine/pdf.wasm', source: parser });
      for (const directory of ['pdf-data', 'pdf-cmaps']) {
        const base = resolve(root, 'vendor', directory);
        const bytes = readFileSync(resolve(base, 'manifest.json'));
        const manifest = JSON.parse(bytes);
        if (manifest.executableCode !== false || !Array.isArray(manifest.files)) throw new Error('Invalid PDF data manifest.');
        this.emitFile({ type: 'asset', fileName: `assets/${directory}/manifest.json`, source: bytes });
        for (const file of manifest.files) {
          if (!/^[A-Za-z0-9_.\/-]+$/.test(file.path) || file.path.startsWith('/') || file.path.split('/').includes('..')) throw new Error('Invalid PDF data path.');
          const source = readFileSync(resolve(base, file.path));
          if (source.length !== file.bytes || createHash('sha256').update(source).digest('hex') !== file.sha256) throw new Error(`PDF data pin mismatch: ${file.path}.`);
          this.emitFile({ type: 'asset', fileName: `assets/${directory}/${file.path}`, source });
        }
      }
    },
  };
}
