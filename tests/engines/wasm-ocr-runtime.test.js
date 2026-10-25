import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createWasmOcrRuntime } from '../../src/engines/wasm-ocr-runtime.js';

const mocks = vi.hoisted(() => ({ createEngine: vi.fn(), createSession: vi.fn(), detect: vi.fn(), recognize: vi.fn() }));
vi.mock('../../src/engines/wasm-ocr-compute.js', () => ({ WasmOcrCompute: { create: mocks.createEngine } }));
vi.mock('../../src/engines/browser-inference.js', () => ({ InferenceSession: { create: mocks.createSession }, Tensor: class {} }));
vi.mock('../../src/lib/native-kernels.js', () => ({ initializeNativeKernels: async () => null }));
vi.mock('../../src/lib/pdf-ocr-detector.js', () => ({ detectPdfOcrLines: mocks.detect, recognizePdfOcrDetectedLines: mocks.recognize }));

const hashes = ['193bab7a04fca699a6c82e6abb5b81bdb28177f0abd4062552b04908dafb19f8',
  'c3a4550768b962131ed08dde81e73e2258f2c1d32a0e2ecb0fd80a223c6252f5',
  'b50d01361bea9087ccb896a6381c1a8334e2af14ae0f1036571bd06cdc3832bf'];
let engine, detector, recognizer, corrupt, alphabet;
beforeEach(() => {
  vi.resetAllMocks(); corrupt = false;
  alphabet = Array(18710).fill('a'); alphabet[0] = ''; alphabet[18709] = ' ';
  engine = { dispose: vi.fn(async () => {}) };
  detector = { release: vi.fn(async () => {}) };
  recognizer = { release: vi.fn(async () => {}) };
  mocks.createEngine.mockResolvedValue(engine);
  mocks.createSession.mockResolvedValueOnce(detector).mockResolvedValueOnce(recognizer);
  mocks.detect.mockResolvedValue([{ x0: 1, y0: 1, x1: 20, y1: 20 }]);
  mocks.recognize.mockResolvedValue([{ bbox: { x0: 1, y0: 1, x1: 20, y1: 20 }, words: [{ text: 'English', bbox: { x0: 1, y0: 1, x1: 20, y1: 20 } }] }]);
  vi.stubGlobal('fetch', vi.fn(async url => ({ ok: true, arrayBuffer: async () => {
    const path = new URL(url).pathname;
    if (path.endsWith('alphabet.json')) return new TextEncoder().encode(JSON.stringify(alphabet)).buffer;
    return Uint8Array.of(path.endsWith('tiny-det.onnx') ? 1 : path.endsWith('small-rec.onnx') ? 2 : 0).buffer;
  } })));
  vi.stubGlobal('crypto', { subtle: { digest: vi.fn(async (_, bytes) => {
    const first = new Uint8Array(bytes)[0], hash = corrupt ? '0'.repeat(64) : hashes[first === 1 ? 0 : first === 2 ? 1 : 2];
    return Uint8Array.from(hash.match(/../g), value => parseInt(value, 16)).buffer;
  }) } });
});
afterEach(() => { vi.unstubAllGlobals(); });

it('loads pinned local data once and uses more source detail only for explicit crop retries', async () => {
  const runtime = await createWasmOcrRuntime('chrome-extension://test/');
  expect(mocks.createSession.mock.calls.every(([, options]) => options.engine === engine && options.executionProviders[0] === 'wasm')).toBe(true);
  const image = { width: 100, height: 200 };
  expect((await runtime.recognize(image)).data.blocks[0].paragraphs[0].lines[0].words[0].text).toBe('English');
  expect(mocks.detect.mock.calls[0][3]).toBe(640);
  await runtime.recognize(image, { mode: 'crop' }); expect(mocks.detect.mock.calls[1][3]).toBe(1280);
  expect(fetch).toHaveBeenCalledTimes(4);
  await runtime.dispose(); await runtime.dispose();
  expect(detector.release).toHaveBeenCalledOnce(); expect(recognizer.release).toHaveBeenCalledOnce(); expect(engine.dispose).toHaveBeenCalledOnce();
  await expect(runtime.recognize(image)).rejects.toThrow(/closed/);
});

it('rejects missing packaged models and corrupted hashes before executing their graph', async () => {
  corrupt = true;
  await expect(createWasmOcrRuntime('chrome-extension://test/')).rejects.toThrow(/corrupt/);
  expect(mocks.createEngine).not.toHaveBeenCalled();
  fetch.mockResolvedValue({ ok: false, status: 404 });
  await expect(createWasmOcrRuntime('chrome-extension://test/')).rejects.toThrow(/unavailable/);
  expect(mocks.createEngine).not.toHaveBeenCalled();
});

it('releases every successful partial load when another session fails', async () => {
  mocks.createSession.mockReset().mockResolvedValueOnce(detector).mockRejectedValueOnce(new Error('Recognizer rejected'));
  await expect(createWasmOcrRuntime('chrome-extension://test/')).rejects.toThrow('Recognizer rejected');
  expect(detector.release).toHaveBeenCalledOnce(); expect(engine.dispose).toHaveBeenCalledOnce();
});

it('validates the dictionary and image bounds without making a recognition call', async () => {
  alphabet = [''];
  await expect(createWasmOcrRuntime('chrome-extension://test/')).rejects.toThrow(/alphabet/);
  expect(detector.release).toHaveBeenCalledOnce(); expect(recognizer.release).toHaveBeenCalledOnce(); expect(engine.dispose).toHaveBeenCalledOnce();
  expect(mocks.recognize).not.toHaveBeenCalled();
});

it('closes the native arena even when session cleanup rejects', async () => {
  const runtime = await createWasmOcrRuntime('chrome-extension://test/');
  detector.release.mockRejectedValue(new Error('Session release failed'));
  await runtime.dispose();
  expect(recognizer.release).toHaveBeenCalledOnce(); expect(engine.dispose).toHaveBeenCalledOnce();
});
