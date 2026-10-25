import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { copyPublicRuntimeAssets, rejectRetiredRuntimeModules } from "../../build/runtime-assets.js";

describe('runtime asset build helpers', () => {
  it.each(['@huggingface/transformers', '@mozilla/readability', 'kokoro-js', 'onnxruntime-web', 'onnxruntime-web-omnivoice',
    'pdfjs-dist', 'tesseract.js', 'tesseract.js-core', 'phonemizer'])('rejects a renamed bundle that includes retired %s code', (name) => {
    const bundle = { 'assets/unrelated-name.js': { type: 'chunk', modules: { [`C:/project/node_modules/${name}/runtime.js`]: {} } } };
    expect(() => rejectRetiredRuntimeModules().generateBundle({}, bundle)).toThrow(/Retired executable runtime/);
  });

  it('allows original code and retained data rather than treating data attribution as executable code', () => {
    const bundle = {
      'assets/original.js': { type: 'chunk', modules: { 'C:/project/src/engines/webgpu-compute.js': {}, 'C:/project/vendor/pdf-glyphs/mappings.json': {} } },
      'assets/pdf-data/font.pfb': { type: 'asset', source: 'licensed font data' },
    };
    expect(() => rejectRetiredRuntimeModules().generateBundle({}, bundle)).not.toThrow();
  });

  it('copies public runtime assets without shipping the retained Kokoro source data', () => {
    const root = mkdtempSync(join(tmpdir(), 'pagenarrator-public-assets-'));
    const publicDir = join(root, 'public').replace(/\\/g, '/');
    const files = [
      'voice-packs/selected-manifest.json',
      'voice-packs/kokoro/onnx-community/Kokoro-82M-v1.0-ONNX/onnx/model.onnx',
      'voice-packs/kokoro/onnx-community/Kokoro-82M-v1.0-ONNX/tokenizer.json',
      'voice-packs/kokoro/onnx-community/Kokoro-82M-v1.0-ONNX/voices/af_heart.bin',
      'assets/ocr/recognizer.onnx',
      'legal/THIRD_PARTY_NOTICES.txt',
    ];
    try {
      for (const file of files) {
        mkdirSync(dirname(join(publicDir, file)), { recursive: true });
        writeFileSync(join(publicDir, file), file);
      }
      const plugin = copyPublicRuntimeAssets();
      expect(readFileSync(new URL('../../vite.config.js', import.meta.url), 'utf8')).toContain('copyPublicRuntimeAssets(),');
      expect(plugin.config()).toEqual({ build: { copyPublicDir: false } });
      plugin.configResolved({ root, publicDir, build: { outDir: 'dist' } });
      plugin.writeBundle();
      for (const file of files) {
        expect(readFileSync(join(publicDir, file), 'utf8')).toBe(file);
        expect(existsSync(join(root, 'dist', file)), file).toBe(!file.startsWith('voice-packs/kokoro/'));
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['assets/renamed-runtime.js', 'assets/renamed-runtime.mjs', 'assets/renamed-runtime.CJS',
    'renamed-viewer.html', 'renamed-viewer.HTM', 'renamed-viewer.xhtml'])(
    'rejects public executable files outside the checked module graph: %s', (filename) => {
      const root = mkdtempSync(join(tmpdir(), 'pagenarrator-public-executable-'));
      try {
        const publicDir = join(root, 'public'), source = join(publicDir, filename);
        mkdirSync(dirname(source), { recursive: true });
        writeFileSync(source, filename.toLowerCase().endsWith('js') ? 'export const renamedRetiredEngine = true;' : '<script src="assets/renamed-runtime.js"></script>');
        const plugin = copyPublicRuntimeAssets();
        plugin.configResolved({ root, publicDir, build: { outDir: 'dist' } });
        expect(() => plugin.writeBundle()).toThrow(/Public assets must not contain executable JS\/HTML/);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

});
