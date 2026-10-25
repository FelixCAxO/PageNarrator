import { expect, test } from '@playwright/test';
import { getVoiceOptions } from '../../src/lib/voice-registry.js';
import { launchExtensionContext, openExtensionPage } from './extension-fixture.js';

const MODEL_ASSET_TIMEOUT_MS = 180_000;
const SELECTED_MANIFEST_PATH = 'voice-packs/selected-manifest.json';
const BUILT_IN_VOICES = Object.freeze(
  getVoiceOptions({ includeDownloadable: false })
    .filter((voice) => voice.engine === 'kokoro' || voice.engine === 'piper'),
);
const REQUIRED_ASSET_PATHS = Object.freeze([
  'native/engine.wasm',
  'native/kokoro-engine.wasm',
  'native/ocr-engine.wasm',
  'native/ocr-lstm-engine.wasm',
  'assets/phonemizer/english.wasm',
  'assets/pdf-engine/pdf.wasm',
]);

// ONNX IR 8, opset 13: c = a + b, three float32 values. No model download needed.
const ADD_MODEL = 'CAg6TAoOCgFhCgFiEgFjIgNBZGQSB2NzcC1hZGRaDwoBYRIKCggIARIECgIIA1oPCgFiEgoKCAgBEgQKAggDYg8KAWMSCgoICAESBAoCCANCBAoAEA0=';

for (const provider of ['wasm', 'webgpu']) {
    test(`original engine computes real ${provider} addition under the release CSP`, async ({}, testInfo) => {
      test.setTimeout(MODEL_ASSET_TIMEOUT_MS);
      const { context, cleanup } = await launchExtensionContext({ testInfo });
      try {
        const page = await openExtensionPage(context, 'popup');
        const result = await page.evaluate(async ({ provider, model }) => {
          if (provider === 'wasm') {
            const bytes = await (await fetch(chrome.runtime.getURL('native/engine.wasm'))).arrayBuffer();
            const { instance, module } = await WebAssembly.instantiate(bytes), api = instance.exports;
            if (WebAssembly.Module.imports(module).length || api.pn_abi_version() !== 1) throw new Error('Unexpected original native ABI.');
            const start = Math.ceil(Number(api.__heap_base.value) / 16) * 16;
            if (start + 48 > api.memory.buffer.byteLength) api.memory.grow(1);
            new Float32Array(api.memory.buffer, start, 3).set([-1, -2, 3]);
            new Float32Array(api.memory.buffer, start + 16, 3).set([1, -1, 2]);
            api.pn_binary(start, start + 16, start + 32, 3, 0);
            return { data: Array.from(new Float32Array(api.memory.buffer, start + 32, 3)), cleanup: true };
          }
          if (!await navigator.gpu?.requestAdapter()) return { unsupported: true };
          const module = await import(chrome.runtime.getURL('assets/webgpu-onnx-session.js'));
          // Vite may shorten internal export names; identify the original session by its API.
          const Session = Object.values(module).find(value => typeof value === 'function'
            && typeof value.create === 'function' && typeof value.prototype?.run === 'function' && typeof value.prototype?.dispose === 'function');
          if (!Session) throw new Error('Original graph session is absent from the build.');
          const session = await Session.create(Uint8Array.from(atob(model), char => char.charCodeAt(0)));
          let data;
          try {
            const { c } = await session.run({
              a: { data: Float32Array.from([-1, -2, 3]), shape: [3] },
              b: { data: Float32Array.from([1, -1, 2]), shape: [3] },
            });
            data = Array.from(c.data);
          } finally {
            await session.dispose();
          }
          return { data, cleanup: session.engine.buffers.size === 0 && session.engine.tensors.size === 0 };
        }, { provider, model: ADD_MODEL });
        test.skip(result.unsupported, 'Native WebGPU is unavailable on this host.');
        expect(result.data).toEqual([0, -3, 5]);
        expect(result.cleanup).toBe(true);
      } finally {
        await cleanup();
      }
    });
}

test('loads the voice catalog and original executable engines from the built extension', async ({}, testInfo) => {
  test.setTimeout(MODEL_ASSET_TIMEOUT_MS);

  const { context, cleanup } = await launchExtensionContext({ testInfo });
  try {
    const page = await openExtensionPage(context, 'popup');
    const result = await page.evaluate(loadVoiceAssetsFromExtension, {
      assetPaths: REQUIRED_ASSET_PATHS,
      manifestPath: SELECTED_MANIFEST_PATH,
    });

    expect(result.manifest.ok, describeAssetResult(result.manifest)).toBe(true);
    expect(result.manifest.jsonOk, describeAssetResult(result.manifest)).toBe(true);
    expect([...result.manifest.modelIds].sort()).toEqual(BUILT_IN_VOICES.map((voice) => voice.id).sort());

    expect(result.assets).toHaveLength(REQUIRED_ASSET_PATHS.length);
    for (const asset of result.assets) {
      expect(asset.ok, describeAssetResult(asset)).toBe(true);
      expect(asset.extensionUrl, asset.path).toMatch(/^chrome-extension:\/\//);
      expect(asset.responseUrl, asset.path).toMatch(/^chrome-extension:\/\//);
      expect(asset.byteLength, asset.path).toBeGreaterThanOrEqual(minimumBytesForAsset(asset.path));
      expect(asset.prefixText, asset.path).not.toMatch(/version https:\/\/git-lfs|<!doctype|<html/i);
      if (asset.path.endsWith('.wasm')) expect(asset.wasmOk, asset.path).toBe(true);
      if (asset.path.endsWith('.json')) {
        expect(asset.jsonOk, describeAssetResult(asset)).toBe(true);
      }
    }

  } finally {
    await cleanup();
  }
});

function minimumBytesForAsset(path) {
  if (/\.wasm$/i.test(path)) return 1024;
  if (/\.mjs$/i.test(path)) return 1024;
  return 1;
}

function describeAssetResult(result) {
  return JSON.stringify({
    path: result.path,
    status: result.status,
    ok: result.ok,
    byteLength: result.byteLength,
    extensionUrl: result.extensionUrl,
    responseUrl: result.responseUrl,
    jsonOk: result.jsonOk,
    jsonError: result.jsonError,
    prefixText: result.prefixText,
  }, null, 2);
}

async function loadVoiceAssetsFromExtension({ assetPaths, manifestPath }) {
  const manifest = await loadJsonAsset(manifestPath);
  const assets = [];
  for (const path of assetPaths) {
    assets.push(await loadAsset(path));
  }
  return { manifest, assets };

  async function loadAsset(path) {
    if (path.endsWith('.json')) return loadJsonAsset(path);

    const extensionUrl = chrome.runtime.getURL(path);
    const response = await fetch(extensionUrl, { cache: 'no-store' });
    if (!response.ok) {
      return {
        path,
        extensionUrl,
        responseUrl: response.url,
        status: response.status,
        ok: false,
        byteLength: 0,
        prefixText: '',
      };
    }

    let details;
    if (path.endsWith('.wasm')) {
      const bytes = new Uint8Array(await response.arrayBuffer()), module = await WebAssembly.compile(bytes);
      details = { byteLength: bytes.length, prefixText: decodePrefix(bytes), wasmOk: WebAssembly.Module.imports(module).length === 0 };
    } else details = await countResponseBytes(response);
    return {
      path,
      extensionUrl,
      responseUrl: response.url,
      status: response.status,
      ok: true,
      ...details,
    };
  }

  async function loadJsonAsset(path) {
    const extensionUrl = chrome.runtime.getURL(path);
    const response = await fetch(extensionUrl, { cache: 'no-store' });
    const text = response.ok ? await response.text() : '';
    let parsed = null;
    let jsonError = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch (error) {
      jsonError = error?.message || String(error);
    }
    return {
      path,
      extensionUrl,
      responseUrl: response.url,
      status: response.status,
      ok: response.ok,
      byteLength: new TextEncoder().encode(text).byteLength,
      prefixText: text.slice(0, 120),
      jsonOk: response.ok && !jsonError,
      jsonError,
      modelIds: Array.isArray(parsed?.models) ? parsed.models.map((model) => model.id) : [],
    };
  }

  async function countResponseBytes(response) {
    const reader = response.body?.getReader?.();
    if (!reader) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      return {
        byteLength: bytes.byteLength,
        prefixText: decodePrefix(bytes),
      };
    }

    let byteLength = 0;
    let prefix = new Uint8Array(0);
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (prefix.byteLength < 120) {
        const remaining = 120 - prefix.byteLength;
        const next = new Uint8Array(prefix.byteLength + Math.min(remaining, value.byteLength));
        next.set(prefix);
        next.set(value.slice(0, remaining), prefix.byteLength);
        prefix = next;
      }
    }
    return { byteLength, prefixText: decodePrefix(prefix) };
  }

  function decodePrefix(bytes) {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }
}
