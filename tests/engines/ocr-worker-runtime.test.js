import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createOcrWorkerRuntime } from '../../src/engines/ocr-worker-runtime.js';
const mocks = vi.hoisted(() => ({ compute: vi.fn(), model: vi.fn(), adapter: vi.fn(), primary: vi.fn() }));
vi.mock('../../src/engines/tesseract-line-compute.js', () => ({ WasmTesseractCompute: { create: mocks.compute } }));
vi.mock('../../src/engines/tesseract-line-model.js', () => ({ TesseractLineModel: { create: mocks.model } }));
vi.mock('../../src/engines/tesseract-line-recognizer.js', () => ({ tesseractLineSession: mocks.adapter }));
vi.mock('../../src/engines/wasm-ocr-runtime.js', () => ({ createWasmOcrRuntime: mocks.primary }));
let engine, model, primary, recognizeLines, failFetch;
beforeEach(() => {
  vi.resetAllMocks(); failFetch = false;
  engine = { dispose: vi.fn(async () => null) }; model = { dispose: vi.fn(async () => null) };
  primary = { recognize: vi.fn(async () => ({ data: { blocks: [] } })), dispose: vi.fn(async () => null) };
  recognizeLines = vi.fn(async () => [{ blocks: [] }]);
  mocks.compute.mockResolvedValue(engine); mocks.model.mockResolvedValue(model); mocks.primary.mockResolvedValue(primary); mocks.adapter.mockReturnValue({ recognizeLines });
  vi.stubGlobal('fetch', vi.fn(async url => ({ ok: !(failFetch && String(url).endsWith('.json')), status: 404, arrayBuffer: async () => String(url).endsWith('.json')
    ? new TextEncoder().encode('{"fixture":true}').buffer : Uint8Array.of(String(url).endsWith('.bin') ? 7 : 9).buffer })));
  vi.stubGlobal('crypto', { subtle: { digest: async (_, bytes) => {
    const hash = new Uint8Array(bytes)[0] === 7 ? 'ab437a3f500394377ad7da98c77d3d8477eb2423697b0e3849afbc3f5593c53a' : '31b613c896e253ddc6f38df9f26a23d4ed844b7484cf6169870a5c7d6ff064c0';
    return Uint8Array.from(hash.match(/../g), value => parseInt(value, 16)).buffer;
  } } });
});
afterEach(() => vi.unstubAllGlobals());

it('loads only independent English data for GPU verification and reuses one arena/model', async () => {
  const runtime = createOcrWorkerRuntime('https://localhost/');
  expect(fetch).not.toHaveBeenCalled();
  await runtime.recognizeLine({}); await runtime.recognizeLine({});
  expect(mocks.compute).toHaveBeenCalledOnce(); expect(mocks.model).toHaveBeenCalledOnce(); expect(mocks.primary).not.toHaveBeenCalled();
  expect(mocks.model.mock.calls[0][3]).toEqual({ engine }); expect(fetch).toHaveBeenCalledTimes(3);
  await runtime.dispose(); await runtime.dispose(); expect(engine.dispose).toHaveBeenCalledOnce(); expect(model.dispose).toHaveBeenCalledOnce();
});

it('keeps English weights unloaded during clear CPU primary recognition and shares its native arena', async () => {
  const runtime = createOcrWorkerRuntime('https://localhost/');
  await runtime.recognize({ width: 100, height: 100 });
  expect(mocks.primary.mock.calls[0][1].engine).toBe(engine); expect(mocks.model).not.toHaveBeenCalled();
  expect(fetch).toHaveBeenCalledTimes(1);
  await runtime.dispose(); expect(primary.dispose).toHaveBeenCalledOnce(); expect(engine.dispose).toHaveBeenCalledOnce();
});

it('reports missing learned bytes, permits a later explicit retry and keeps the valid arena', async () => {
  const runtime = createOcrWorkerRuntime('https://localhost/'); failFetch = true;
  await expect(runtime.recognizeLine({})).rejects.toThrow('unavailable');
  failFetch = false; await runtime.recognizeLine({}); expect(mocks.compute).toHaveBeenCalledOnce(); expect(mocks.model).toHaveBeenCalledOnce();
  await runtime.dispose(); expect(engine.dispose).toHaveBeenCalledOnce();
});

it('waits for active line work before cleanup, rejects stale results and enforces serial ownership', async () => {
  let complete;
  recognizeLines.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  const runtime = createOcrWorkerRuntime('https://localhost/'), active = runtime.recognizeLine({});
  const assertion = expect(active).rejects.toThrow('closed'); await vi.waitFor(() => expect(complete).toBeTypeOf('function'));
  await expect(runtime.recognizeLine({})).rejects.toThrow('busy');
  const closing = runtime.dispose(); expect(model.dispose).not.toHaveBeenCalled(); complete([{ blocks: [] }]);
  await assertion; await closing; expect(model.dispose).toHaveBeenCalledOnce(); expect(engine.dispose).toHaveBeenCalledOnce();
});
