import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { REQUIRED_RELEASE_FILES, RELEASE_PACKAGE_CLEAN_ASSERTIONS, assertReleasePackage, findScriptInterpreter } from '../../scripts/assert-release-package.mjs';
import { ORIGINAL_RUNTIME_FILES } from '../../scripts/lib/release-engine-files.mjs';

async function withPackage(run) {
  const root = mkdtempSync(join(tmpdir(), 'pagenarrator-package-policy-'));
  const put = (path, data = 'export {};') => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), data);
  };
  try {
    for (const path of REQUIRED_RELEASE_FILES) put(path);
    for (const { path, source } of ORIGINAL_RUNTIME_FILES) {
      put(path, readFileSync(source));
    }
    put('manifest.json', JSON.stringify({
      manifest_version: 3, version: '1.1.1',
      content_security_policy: { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'" },
      cross_origin_embedder_policy: { value: 'credentialless' },
      cross_origin_opener_policy: { value: 'same-origin' },
    }));
    await run(root, put);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('on-demand voice package policy', () => {
  it.each(['.env', 'assets/.env.local', '.dev.vars', 'private.pem', 'assets/private.key'])(
    'rejects private configuration or keys: %s', async (file) => withPackage(async (root, put) => {
      put(file, 'private configuration');
      await expect(assertReleasePackage(root, { packageVersion: '1.1.1' })).rejects.toThrow(/private configuration or key file/);
    }),
  );
  it('rejects phonemizer runtime bytes that do not match their source manifest', async () => withPackage(async (root, put) => {
    put('assets/phonemizer/english.wasm', 'unverified bytes');
    await expect(assertReleasePackage(root, { packageVersion: '1.1.1' })).rejects.toThrow('Packaged original engine/data mismatch');
  }));

  it('rejects the opaque upstream phonemizer even beside a verified replacement', async () => withPackage(async (root, put) => {
    put('assets/old-phonemizer.js', 'const opaque = "datafile_js/espeakng.worker.data";');
    await expect(assertReleasePackage(root, { packageVersion: '1.1.1' })).rejects.toThrow('opaque upstream phonemizer');
  }));
  it.each(['assets/innocent-name.wasm', 'assets/innocent-name.WASM', 'assets/innocent-name.WaSm',
    'assets/innocent-name.WASM.BIN', 'assets/innocent-name.dat', 'assets/innocent-name'])(
    'rejects an unrecognized renamed WASM program: %s', async (path) => withPackage(async (root, put) => {
    put(path, Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0));
    await expect(assertReleasePackage(root, { packageVersion: '1.1.1' })).rejects.toThrow(/Unrecognized executable WASM/);
  }));
  it('rejects malformed uppercase WASM even without its binary signature', async () => withPackage(async (root, put) => {
    put('assets/innocent-name.WASM', Uint8Array.of(1, 2, 3));
    await expect(assertReleasePackage(root, { packageVersion: '1.1.1' })).rejects.toThrow(/Unrecognized executable WASM/);
  }));
  it('rejects a package missing the project GPL license', async () => withPackage(async (root) => {
    rmSync(join(root, 'legal/GPL-3.0.txt'));
    await expect(assertReleasePackage(root, { packageVersion: '1.1.1' })).rejects.toThrow('legal/GPL-3.0.txt');
  }));

  it.each(['Font-Awesome-LICENSE.txt', 'MarVoSym-OFL.txt', 'PDF-Symbols-NOTICE.txt'])(
    'requires the retained font-symbol data notice %s', async name => withPackage(async root => {
      rmSync(join(root, 'legal', name));
      await expect(assertReleasePackage(root, { packageVersion: '1.1.1' })).rejects.toThrow(`legal/${name}`);
    }),
  );

  it.each(['onnx/chatterbox/ort.webgpu.bundle.min.mjs', 'assets/local-voice-package-runtime.js', 'assets/custom-voice-permissions.js'])(
    'rejects a retired voice runtime: %s', async (file) => withPackage(async (root, put) => {
      put(file);
      await expect(assertReleasePackage(root, { packageVersion: '1.1.1' })).rejects.toThrow(/retired custom voice runtime/);
    }),
  );
  it.each(['onnx/ort.webgpu.bundle.min.mjs', 'assets/pdf.worker.mjs', 'assets/pdfjs/wasm/openjpeg.wasm',
    'assets/ocr/tesseract-core-simd-lstm.wasm.js', 'assets/phonemizer/espeak.wasm', 'assets/transformers.web.js'])(
    'rejects a retired executable engine: %s', async (file) => withPackage(async (root, put) => {
      put(file);
      await expect(assertReleasePackage(root, { packageVersion: '1.1.1' })).rejects.toThrow(/retired executable runtime/);
    }),
  );
  it.each(['config.json', 'tokenizer.json', 'onnx/model.onnx', 'voices/af_heart.bin'])(
    'rejects packaged Kokoro data: %s', async (file) => withPackage(async (root, put) => {
      put(`voice-packs/kokoro/onnx-community/Kokoro-82M-v1.0-ONNX/${file}`, 'model data');
      await expect(assertReleasePackage(root, { packageVersion: '1.1.1' })).rejects.toThrow(/built-in voice data/);
    }),
  );

  it('allows model-data downloads while requiring packaged JavaScript and WASM', async () => withPackage(async (root, put) => {
    put('assets/model-data.js', 'env.remoteHost = "https://huggingface.co/"; await fetch("https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/pinned/onnx/model.onnx");');
    await expect(assertReleasePackage(root, { packageVersion: '1.1.1' })).resolves.toMatchObject({ ok: true });
    rmSync(join(root, 'native/kokoro-engine.wasm'));
    await expect(assertReleasePackage(root, { packageVersion: '1.1.1' })).rejects.toThrow(/Missing required release file.*wasm/);
  }));

  it.each([
    'await import("https://example.com/runtime.mjs");',
    'new Worker("https://example.com/runtime.js");',
    'importScripts("https://example.com/runtime.js");',
    'eval("remote code");',
    'const wasmPath = "https://cdn.jsdelivr.net/npm/runtime.wasm";',
    'await fetch("https://example.com/runtime.wasm");',
    'await fetch(`https://example.com/${name}.mjs`);',
    'new Function("return remoteCode");',
  ])('rejects remote executable runtime loading: %s', async (source) => withPackage(async (root, put) => {
    put('assets/remote-runtime.js', source);
    await expect(assertReleasePackage(root, { packageVersion: '1.1.1' })).rejects.toThrow(/blocked remote|must not contain eval/);
  }));
});

describe('release package script-interpreter guard', () => {
  it('rejects a bundled QuickJS runtime by file name or by a script that loads it', () => {
    expect(findScriptInterpreter('assets/pdfjs/wasm/quickjs-eval.wasm')).toBe('QuickJS JavaScript interpreter');
    expect(findScriptInterpreter('assets/pdfjs/wasm/quickjs-eval.js')).toBe('QuickJS JavaScript interpreter');
    expect(findScriptInterpreter('assets/pdf.sandbox.mjs', 'await import("./pdfjs/wasm/quickjs-eval.js");'))
      .toBe('QuickJS JavaScript interpreter');
  });

  it('does not mistake original engines or retained model data for a script interpreter', () => {
    for (const filePath of [
      'assets/pdf-engine/pdf.wasm',
      'native/ocr-engine.wasm',
      'native/kokoro-engine.wasm',
      'assets/ocr/english-lstm.bin',
    ]) {
      expect(findScriptInterpreter(filePath, 'export default 1;'), filePath).toBeNull();
    }
    expect(RELEASE_PACKAGE_CLEAN_ASSERTIONS).toContain('no bundled script interpreter');
  });
});
