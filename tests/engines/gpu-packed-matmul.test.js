import { afterEach, expect, it, vi } from 'vitest';
import { WebGpuCompute } from '../../src/engines/webgpu-compute.js';

afterEach(() => vi.unstubAllGlobals());

const BLACKWELL = { vendor: 'nvidia', architecture: 'blackwell', device: '', description: '' };

it.each([
  ['float16', 289, 1024, 3072, 'square', 32, 32, 6],
  ['float16', 289, 3072, 1024, 'packed', 16, 16, 6],
  ['float16', 45, 1024, 1024, 'k32', 16, 16, 1],
  ['float16', 45, 1024, 3072, 'packed', 16, 16, 1],
  ['float16', 55, 1024, 2048, 'k32', 16, 16, 1],
  ['float16', 128, 1024, 1024, 'k32', 16, 16, 1],
  ['float16', 129, 1024, 1024, 'packed', 16, 16, 1],
  ['float16', 17, 258, 130, 'k32', 16, 16, 6],
  ['float16', 17, 272, 130, 'k32', 16, 16, 6],
  ['float16', 17, 274, 130, 'k32', 16, 16, 6],
  ['float16', 128, 1024, 2048, 'wide', 32, 16, 6],
  ['float16', 191, 1024, 3072, 'wide', 32, 16, 6],
  ['float16', 193, 1026, 3074, 'square', 32, 32, 6],
  ['float16', 17, 254, 130, 'packed', 16, 16, 6],
  ['float16', 17, 256, 126, 'packed', 16, 16, 6],
  ['float16', 17, 257, 130, 'half', 16, 16, 6],
  ['float16', 17, 256, 129, 'half', 16, 16, 6],
  ['float32', 289, 1024, 3072, 'float', 16, 16, 6],
])('routes Blackwell %s projections %i/%i/%i with exact broadcast grids', (type, rows, inner, columns, pipeline, tileX, tileY, batches) => {
  vi.stubGlobal('GPUBufferUsage', { STORAGE: 128, COPY_SRC: 4, COPY_DST: 8 });
  const engine = new WebGpuCompute({ adapterInfo: BLACKWELL, addEventListener() {}, lost: new Promise(() => {}), features: new Set(['shader-f16']),
    limits: { maxBufferSize: 1e9, maxStorageBufferBindingSize: 1e9 },
    createCommandEncoder: () => ({}), createBuffer: ({ size }) => ({ size }) }, false);
  engine.half = { packedMatmul: 'packed', packedMatmulK32: 'k32', packedMatmulWide: 'wide', packedMatmul32: 'square', matmul: 'half' }; engine.matmulPipeline = 'float';
  const leftBatch = batches === 6 ? 2 : 1, rightBatch = batches === 6 ? 3 : 1;
  const batch = engine.batch(), a = batch.output([leftBatch, 1, rows, inner], type), b = batch.output([1, rightBatch, inner, columns], type);
  batch.dispatchTensors = vi.fn();
  const result = batch.matmul(a, b);
  expect(result.shape).toEqual([leftBatch, rightBatch, rows, columns]);
  expect(batch.dispatchTensors).toHaveBeenCalledWith(pipeline, [a, b, result], expect.any(Uint32Array),
    Math.ceil(columns / tileX), Math.ceil(rows / tileY), batches);
});

it.each([
  ['Intel', { vendor: 'intel', architecture: 'xe-lpg', device: '', description: '' }, 45, 1024, 1024, 1, 'packed', 64, 3],
  ['missing adapter info', undefined, 55, 1024, 2048, 1, 'packed', 128, 4],
  ['redacted adapter info', { vendor: '', architecture: '', device: '', description: '' }, 128, 1024, 1024, 1, 'packed', 64, 8],
  ['NVIDIA Ampere', { vendor: 'nvidia', architecture: 'ampere', device: '', description: '' }, 45, 1024, 1024, 1, 'packed', 64, 3],
  ['NVIDIA without architecture', { vendor: 'nvidia', architecture: '', device: '', description: '' }, 55, 1024, 2048, 1, 'packed', 128, 4],
  ['unknown vendor', { vendor: '', architecture: 'blackwell', device: '', description: '' }, 17, 258, 130, 6, 'packed', 9, 2],
  ['Intel wide grid', { vendor: 'intel', architecture: 'xe-lpg', device: '', description: '' }, 128, 1024, 2048, 6, 'wide', 64, 8],
  ['unidentified square grid', undefined, 193, 1026, 3074, 6, 'square', 97, 7],
])('keeps %s on its qualified route', (_adapter, adapterInfo, rows, inner, columns, batches, pipeline, x, y) => {
  vi.stubGlobal('GPUBufferUsage', { STORAGE: 128, COPY_SRC: 4, COPY_DST: 8 });
  const engine = new WebGpuCompute({ adapterInfo, addEventListener() {}, lost: new Promise(() => {}), features: new Set(['shader-f16']),
    limits: { maxBufferSize: 1e9, maxStorageBufferBindingSize: 1e9 },
    createCommandEncoder: () => ({}), createBuffer: ({ size }) => ({ size }) }, false);
  engine.half = { packedMatmul: 'packed', packedMatmulK32: 'k32', packedMatmulWide: 'wide', packedMatmul32: 'square', matmul: 'half' };
  const leftBatch = batches === 6 ? 2 : 1, rightBatch = batches === 6 ? 3 : 1;
  const batch = engine.batch(), a = batch.output([leftBatch, 1, rows, inner], 'float16'), b = batch.output([1, rightBatch, inner, columns], 'float16');
  batch.dispatchTensors = vi.fn();
  const output = batch.matmul(a, b);
  expect(output.shape).toEqual([leftBatch, rightBatch, rows, columns]);
  expect(batch.dispatchTensors).toHaveBeenCalledWith(pipeline, [a, b, output], expect.any(Uint32Array), x, y, batches);
});

it.each([
  ['Blackwell', BLACKWELL, 'PageNarrator packed half MatMul K32'],
  ['Intel', { vendor: 'intel', architecture: 'xe-lpg', device: '', description: '' }, undefined],
  ['missing adapter info', undefined, undefined],
])('prepares only qualified K32 pipelines on %s', async (_adapter, adapterInfo, expected) => {
  const engine = new WebGpuCompute({ adapterInfo, features: new Set(['shader-f16']), addEventListener() {}, lost: new Promise(() => {}) }, false);
  engine.pipeline = vi.fn(async (_code, label) => label);
  await engine.prepareCnn();
  expect(engine.half.packedMatmulK32).toBe(expected);
  if (expected === undefined) expect(engine.pipeline.mock.calls.some(([, label]) => label === 'PageNarrator packed half MatMul K32')).toBe(false);
});

it.each([
  ['requested adapter info', undefined, BLACKWELL, 'PageNarrator packed half MatMul K32'],
  ['shared device info', BLACKWELL, null, 'PageNarrator packed half MatMul K32'],
  ['older shared device', undefined, null, undefined],
])('uses %s when creating the engine', async (_source, adapterInfo, requestedInfo, expected) => {
  const device = { adapterInfo, features: new Set(['shader-f16']), addEventListener() {}, lost: new Promise(() => {}),
    createShaderModule: ({ label }) => ({ label, getCompilationInfo: async () => ({ messages: [] }) }),
    createComputePipelineAsync: async ({ label }) => label };
  const gpu = { requestAdapter: vi.fn(async () => ({ info: requestedInfo, features: device.features, requestDevice: async () => device })) };
  const engine = await WebGpuCompute.create({ gpu, ...(requestedInfo ? {} : { device }) });
  await engine.prepareCnn();
  expect(engine.half.packedMatmulK32).toBe(expected);
  expect(gpu.requestAdapter).toHaveBeenCalledTimes(requestedInfo ? 1 : 0);
});

it.each(['packedMatmul', 'packedMatmulK32', 'packedMatmulWide', 'packedMatmul32'])('binds %s configuration as a uniform', key => {
  vi.stubGlobal('GPUBufferUsage', { STORAGE: 128, UNIFORM: 64, COPY_SRC: 4, COPY_DST: 8 });
  const device = { addEventListener() {}, lost: new Promise(() => {}),
    limits: { maxBufferSize: 1e6, maxStorageBufferBindingSize: 1e6, maxComputeWorkgroupsPerDimension: 65535 },
    createBuffer: vi.fn(({ size }) => ({ size })), createBindGroup: value => value,
    createCommandEncoder: () => ({ beginComputePass: () => ({ setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() {} }) }),
    queue: { writeBuffer: vi.fn() } };
  const engine = new WebGpuCompute(device, false);
  engine.half = { packedMatmul: { getBindGroupLayout() {} }, packedMatmulK32: { getBindGroupLayout() {} }, packedMatmulWide: { getBindGroupLayout() {} }, packedMatmul32: { getBindGroupLayout() {} } };
  const batch = engine.batch();
  batch.dispatchTensors(engine.half[key], [], new Uint32Array(32), 1);
  expect(device.createBuffer).toHaveBeenLastCalledWith({ size: 128, usage: 72, label: 'PageNarrator dispatch parameters' });
});

it.each([
  ['float16', 66, 68, 'packed'], ['float16', 65, 68, 'half'], ['float16', 66, 67, 'half'],
  ['float16', 0, 68, 'packed'], ['float32', 66, 68, 'float'],
])('selects %s matmul for inner/output dimensions %i/%i', (type, inner, columns, pipeline) => {
  vi.stubGlobal('GPUBufferUsage', { STORAGE: 128, COPY_SRC: 4, COPY_DST: 8 });
  const engine = new WebGpuCompute({ addEventListener() {}, lost: new Promise(() => {}), features: new Set(['shader-f16']),
    limits: { maxBufferSize: 1e6, maxStorageBufferBindingSize: 1e6 },
    createCommandEncoder: () => ({}), createBuffer: ({ size }) => ({ size }) }, false);
  engine.half = { packedMatmul: 'packed', matmul: 'half' }; engine.matmulPipeline = 'float';
  const batch = engine.batch(), a = batch.output([2, 1, 33, inner], type), b = batch.output([1, 3, inner, columns], type);
  batch.dispatchTensors = vi.fn();
  const result = batch.matmul(a, b);
  expect(result.shape).toEqual([2, 3, 33, columns]);
  expect(batch.dispatchTensors).toHaveBeenCalledWith(pipeline, [a, b, result], expect.any(Uint32Array), Math.ceil(columns / 16), 3, 6);
});

it.each(['float16', 'float32'])('uploads the complete broadcast configuration with %s parameter usage', type => {
  vi.stubGlobal('GPUBufferUsage', { STORAGE: 128, UNIFORM: 64, COPY_SRC: 4, COPY_DST: 8 });
  const device = { addEventListener() {}, lost: new Promise(() => {}), features: new Set(['shader-f16']),
    limits: { maxBufferSize: 1e6, maxStorageBufferBindingSize: 1e6, maxComputeWorkgroupsPerDimension: 65535 },
    createBuffer: vi.fn(({ size }) => ({ size })), createBindGroup: value => value,
    createCommandEncoder: () => ({ beginComputePass: () => ({ setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() {} }) }),
    queue: { writeBuffer: vi.fn() } };
  const engine = new WebGpuCompute(device, false);
  engine.half = { packedMatmul: { getBindGroupLayout() {} } };
  engine.matmulPipeline = { getBindGroupLayout() {} };
  const batch = engine.batch(), a = batch.output([2, 1, 3, 34], type), b = batch.output([1, 3, 34, 38], type);
  const output = batch.matmul(a, b);
  expect(output.shape).toEqual([2, 3, 3, 38]);
  expect(device.createBuffer).toHaveBeenLastCalledWith({ size: 128, usage: type === 'float16' ? 72 : 136, label: 'PageNarrator dispatch parameters' });
  const [buffer, offset, config] = device.queue.writeBuffer.mock.calls[0];
  expect(buffer).toBe(batch.parameters[0]); expect(offset).toBe(0);
  expect(Array.from(config)).toEqual([
    3, 38, 34, 2, 0, 0, 0, 0,
    2, 3, 0, 0, 0, 0, 0, 0,
    1, 0, 0, 0, 0, 0, 0, 0,
    0, 1, 0, 0, 0, 0, 0, 0,
  ]);
});
