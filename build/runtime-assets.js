// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { cpSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export const EXPECTED_RUNTIME_ASSET_PATHS = Object.freeze([
  "assets/pdf-engine/pdf.wasm",
  "native/engine.wasm",
  "native/kokoro-engine.wasm",
  "native/kokoro-parallel.wasm",
  "native/ocr-engine.wasm",
  "native/ocr-lstm-engine.wasm",
  "assets/phonemizer/english.wasm",
  "assets/phonemizer/pronunciations.bin",
  "voice-packs/selected-manifest.json",
]);

export function rejectRetiredRuntimeModules() {
  const retired = /(?:\/node_modules\/(?:@huggingface\/transformers|@mozilla\/readability|kokoro-js|onnxruntime-web(?:-omnivoice)?|pdfjs-dist|tesseract\.js(?:-core)?|phonemizer)\/|\/vendor\/phonemizer\/)/;
  return { name: 'reject-retired-runtime-modules', generateBundle(_options, bundle) {
    for (const chunk of Object.values(bundle)) {
      for (const id of chunk.type === 'chunk' ? Object.keys(chunk.modules || {}) : []) {
        if (retired.test(id.replace(/\\/g, '/'))) throw new Error(`Retired executable runtime reached the browser bundle: ${id}`);
      }
    }
  } };
}

export function copyPublicRuntimeAssets() {
  let publicDir, outDir;
  return {
    name: 'copy-public-runtime-assets',
    config: () => ({ build: { copyPublicDir: false } }),
    configResolved(config) {
      publicDir = config.publicDir;
      outDir = resolve(config.root, config.build.outDir);
    },
    writeBundle() {
      // ponytail: retain source model files for local fixtures; exclude their whole subtree from releases.
      if (publicDir) cpSync(publicDir, outDir, {
        recursive: true,
        filter: (source) => {
          if (source === join(publicDir, 'voice-packs', 'kokoro')) return false;
          if (/\.(?:[cm]?js|html?|xhtml)$/i.test(source) && statSync(source).isFile()) {
            throw new Error(`Public assets must not contain executable JS/HTML outside the verified module graph: ${source}`);
          }
          return true;
        },
      });
    },
  };
}

export function emitOnDemandContentScriptLoader() {
  const getContentEntry = (bundle) => Object.values(bundle).find((item) => (
    item.type === 'chunk'
    && item.facadeModuleId
    && item.facadeModuleId.replace(/\\/g, '/').endsWith('/src/content.js')
  ));

  return {
    name: 'emit-on-demand-content-script-loader',
    enforce: 'post',
    renderCrxManifest(manifest, bundle) {
      const contentChunk = getContentEntry(bundle);
      if (!contentChunk) throw new Error('Missing content module entry in extension build.');

      const resources = new Set();
      const pending = [contentChunk.fileName];
      while (pending.length) {
        const fileName = pending.pop();
        if (resources.has(fileName)) continue;
        const item = bundle[fileName];
        if (item?.type !== 'chunk') {
          throw new Error(`Unresolved content module dependency: ${fileName}`);
        }
        resources.add(fileName);
        pending.push(...item.imports, ...item.dynamicImports);
      }

      // This post hook replaces CRX-generated resources with the injected module graph.
      return {
        ...manifest,
        web_accessible_resources: [{ resources: [...resources].sort(), matches: ['<all_urls>'] }],
      };
    },
    generateBundle(_, bundle) {
      const contentChunk = getContentEntry(bundle);
      if (!contentChunk) return;

      this.emitFile({
        type: 'asset',
        fileName: 'src/content.js',
        source: `(function () {
  'use strict';

  const injectTime = performance.now();
  (async () => {
    const module = await import(
      /* @vite-ignore */
      chrome.runtime.getURL(${JSON.stringify(contentChunk.fileName)})
    );
    module.onExecute?.({ perf: { injectTime, loadTime: performance.now() - injectTime } });
  })().catch(console.error);
})();
`,
      });
    },
  };
}
