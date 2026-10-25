import { beforeEach, expect, it, vi } from 'vitest';
import { WebGpuOnnxSession } from '../../src/engines/webgpu-onnx-session.js';
import { WebGpuCompute } from '../../src/engines/webgpu-compute.js';
import { decodeOnnxModel } from '../../src/engines/onnx-model.js';

vi.mock('../../src/engines/onnx-model.js', () => ({ decodeOnnxModel: vi.fn() }));
vi.mock('../../src/engines/webgpu-compute.js', async original => ({
  ...await original(), WebGpuCompute: { create: vi.fn() },
}));

const info = (name, dataType = 1) => ({ name, dataType, dims: [2] });
const cast = (input, output, to) => ({ opType: 'Cast', domain: '', inputs: [input], outputs: [output],
  attributes: new Map([['to', { type: 2, value: to }]]) });
const half = { dataType: 10, dims: [1], rawData: Uint8Array.of(0, 60), typedData: new Map(), externalData: new Map(), dataLocation: 0 };
const attribute = value => new Map([['value', { type: 4, value }]]);
let graph, compute;
beforeEach(() => {
  vi.resetAllMocks();
  graph = { initializers: [], inputs: [info('x')], outputs: [info('y')], values: [], nodes: [cast('x', 'y', 1)] };
  decodeOnnxModel.mockImplementation(() => ({ graph, functions: [] }));
  compute = { device: { features: new Set(['shader-f16']) }, prepareCnn: vi.fn(async () => {}), dispose: vi.fn(async () => {}) };
  WebGpuCompute.create.mockResolvedValue(compute);
});

it('negotiates half support for a float32 graph with an intermediate-only half cast', async () => {
  graph.nodes = [cast('x', 'h', 10), cast('h', 'y', 1)];
  await WebGpuOnnxSession.create(new Uint8Array());
  expect(WebGpuCompute.create).toHaveBeenCalledWith({ float16: true });
});

it.each(['Constant', 'ConstantOfShape'])('negotiates half support for %s tensor attributes', async opType => {
  graph.inputs = opType === 'Constant' ? [] : [info('shape', 7)];
  graph.nodes = [{ opType, domain: '', inputs: opType === 'Constant' ? [] : ['shape'], outputs: ['h'], attributes: attribute(half) }, cast('h', 'y', 1)];
  await WebGpuOnnxSession.create(new Uint8Array());
  expect(WebGpuCompute.create).toHaveBeenCalledWith({ float16: true });
});

it('honors half intermediate value declarations and leaves ordinary float32 requests unchanged', async () => {
  await WebGpuOnnxSession.create(new Uint8Array());
  expect(WebGpuCompute.create).toHaveBeenLastCalledWith({ float16: false });
  graph.nodes = [cast('x', 'h', 10), cast('h', 'y', 1)];
  graph.values = [info('h', 10)];
  await WebGpuOnnxSession.create(new Uint8Array());
  expect(WebGpuCompute.create).toHaveBeenLastCalledWith({ float16: true });
});

it('rejects an incapable caller-owned GPU device before preparing or disposing it', async () => {
  graph.nodes = [cast('x', 'h', 10), cast('h', 'y', 1)];
  compute.device.features.clear();
  await expect(WebGpuOnnxSession.create(new Uint8Array(), { engine: compute })).rejects.toThrow(/shader-f16|fp16/);
  expect(compute.prepareCnn).not.toHaveBeenCalled();
  expect(compute.dispose).not.toHaveBeenCalled();
  expect(WebGpuCompute.create).not.toHaveBeenCalled();
});
