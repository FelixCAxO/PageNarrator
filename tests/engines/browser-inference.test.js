import { beforeEach, expect, it, vi } from 'vitest';
import { createBrowserInferenceEngine, InferenceSession, Tensor } from '../../src/engines/browser-inference.js';
import { WebGpuCompute } from '../../src/engines/webgpu-compute.js';
import { WebGpuOnnxSession } from '../../src/engines/webgpu-onnx-session.js';

vi.mock('../../src/engines/webgpu-compute.js', () => ({ WebGpuCompute: { create: vi.fn() } }));
vi.mock('../../src/engines/webgpu-onnx-session.js', () => ({ WebGpuOnnxSession: { create: vi.fn() } }));

let compute, models;
beforeEach(() => {
  vi.resetAllMocks(); models = [];
  compute = { dispose: vi.fn(async () => null) };
  WebGpuCompute.create.mockResolvedValue(compute);
  WebGpuOnnxSession.create.mockImplementation(async () => {
    const model = { inputNames: ['x'], outputNames: ['y'], dispose: vi.fn(async () => null),
      run: vi.fn(async ({ x }) => ({ y: { data: x.data.slice(), shape: x.shape } })) };
    models.push(model); return model;
  });
});

it('validates tensor storage and refuses disposed input', async () => {
  expect(() => new Tensor('float32', new Int32Array(1), [1])).toThrow();
  expect(() => new Tensor('float32', new Float32Array(2), [3])).toThrow();
  const tensor = new Tensor('float32', Float32Array.of(7), [1]);
  const session = await InferenceSession.create(new Uint8Array(1));
  expect((await session.run({ x: tensor })).y.data).toEqual(Float32Array.of(7));
  tensor.dispose(); await expect(session.run({ x: tensor })).rejects.toThrow(/live/);
  await session.release();
});

it('shares one GPU device across concurrent model loads and closes all sessions', async () => {
  const engine = createBrowserInferenceEngine();
  await Promise.all([1, 2, 3].map(() => engine.InferenceSession.create(new Uint8Array(1))));
  expect(WebGpuCompute.create).toHaveBeenCalledTimes(1);
  expect(WebGpuCompute.create).toHaveBeenCalledWith({ float16: false });
  expect(WebGpuOnnxSession.create.mock.calls.every(([, options]) => options.engine === compute)).toBe(true);
  await Promise.all([engine.dispose(), engine.dispose()]);
  expect(models.every(model => model.dispose.mock.calls.length === 1)).toBe(true);
  expect(compute.dispose).toHaveBeenCalledTimes(1);
  await expect(engine.InferenceSession.create(new Uint8Array(1))).rejects.toThrow(/disposed/);
});

it('explicitly negotiates one shared half-capable device without changing active sessions', async () => {
  const engine = createBrowserInferenceEngine({ float16: true });
  await Promise.all([1, 2].map(() => engine.InferenceSession.create(new Uint8Array(1))));
  expect(WebGpuCompute.create).toHaveBeenCalledTimes(1);
  expect(WebGpuCompute.create).toHaveBeenCalledWith({ float16: true });
  expect(models).toHaveLength(2);
  await engine.dispose();
  expect(compute.dispose).toHaveBeenCalledTimes(1);
  expect(() => createBrowserInferenceEngine({ float16: 'true' })).toThrow(/boolean/);
});

it('waits for an in-flight device load before disposing it', async () => {
  let complete;
  WebGpuCompute.create.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  const engine = createBrowserInferenceEngine();
  const loading = expect(engine.InferenceSession.create(new Uint8Array(1))).rejects.toThrow(/disposed/);
  const closing = engine.dispose();
  expect(compute.dispose).not.toHaveBeenCalled();
  complete(compute); await loading; await closing;
  expect(WebGpuOnnxSession.create).not.toHaveBeenCalled();
  expect(compute.dispose).toHaveBeenCalledTimes(1);
});

it('cleans a model that finishes loading after closure was requested', async () => {
  let complete;
  const lateModel = { inputNames: [], outputNames: [], dispose: vi.fn(async () => null) };
  WebGpuOnnxSession.create.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  const engine = createBrowserInferenceEngine();
  const loading = expect(engine.InferenceSession.create(new Uint8Array(1))).rejects.toThrow(/disposed/);
  await vi.waitFor(() => expect(complete).toBeTypeOf('function'));
  const closing = engine.dispose(); complete(lateModel); await loading; await closing;
  expect(lateModel.dispose).toHaveBeenCalledTimes(1); expect(compute.dispose).toHaveBeenCalledTimes(1);
});

it('releases the shared device even if one model fails to close', async () => {
  const engine = createBrowserInferenceEngine();
  await Promise.all([1, 2].map(() => engine.InferenceSession.create(new Uint8Array(1))));
  const failure = new Error('Model cleanup failed'); models[0].dispose.mockRejectedValue(failure);
  await expect(engine.dispose()).rejects.toBe(failure);
  expect(models[1].dispose).toHaveBeenCalledTimes(1); expect(compute.dispose).toHaveBeenCalledTimes(1);
});

it('forgets individually released models without keeping them for a second cleanup', async () => {
  const engine = createBrowserInferenceEngine();
  const session = await engine.InferenceSession.create(new Uint8Array(1));
  await Promise.all([session.release(), session.release()]);
  await engine.dispose();
  expect(models[0].dispose).toHaveBeenCalledTimes(1);
});
