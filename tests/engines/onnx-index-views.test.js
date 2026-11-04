import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { executeIndexNode } from '../../src/engines/onnx-metadata.js';
import { WebGpuOnnxSession } from '../../src/engines/webgpu-onnx-session.js';
import { WasmKokoroCompute } from '../../src/engines/kokoro-cpu-compute.js';

it.each([
  [[1, 8, 259, 128], 'Slice', { starts: [0], ends: [(1n << 63n) - 1n], axes: [2] }, [1, 8, 259, 128]],
  [[1, 8, 77], 'Transpose', { perm: [1, 0, 2] }, [8, 1, 77]],
  [[2, 3], 'Transpose', { perm: [0, 1] }, [2, 3]],
  [[0, 3], 'Slice', { starts: [0], ends: [3], axes: [1] }, [0, 3]],
  [[], 'Transpose', {}, []],
])('aliases storage only when indexing preserves the full linear order: %j %s', (shape, opType, attrs, expected) => {
  const input = { cpu: false, shape, dataType: 'float16' };
  const batch = { view: vi.fn((input, shape) => ({ input, shape })), index: vi.fn() };
  const result = executeIndexNode({ opType, attrs, inputs: ['x'] }, { value: () => input, batch });
  expect(batch.view).toHaveBeenCalledWith(input, expected);
  expect(batch.index).not.toHaveBeenCalled();
  expect(result.shape).toEqual(expected);
});

it.each([
  [[2, 3], 'Transpose', { perm: [1, 0] }],
  [[7], 'Slice', { starts: [0], ends: [6] }],
  [[7], 'Slice', { starts: [1], ends: [7] }],
  [[7], 'Slice', { starts: [-1], ends: [-100], axes: [0], steps: [-1] }],
  [[7], 'Slice', { starts: [0], ends: [7], axes: [0], steps: [2] }],
])('retains real indexing work for reordered, partial or strided data: %j %s', (shape, opType, attrs) => {
  const input = { cpu: false, shape }, batch = { view: vi.fn(), index: vi.fn(() => 'indexed') };
  const modernSlice = opType === 'Slice' && Object.hasOwn(attrs, 'steps');
  const inputs = modernSlice ? ['x', 'starts', 'ends', 'axes', 'steps'] : ['x'];
  expect(executeIndexNode({ opType, attrs: modernSlice ? {} : attrs, inputs },
    { value: () => input, numbers: name => attrs[name], batch })).toBe('indexed');
  expect(batch.view).not.toHaveBeenCalled(); expect(batch.index).toHaveBeenCalledOnce();
});

it('validates indexing attributes before choosing a view', () => {
  const input = { cpu: false, shape: [2, 3] }, batch = { view: vi.fn(), index: vi.fn() };
  for (const [opType, attrs] of [['Transpose', { perm: [0, 0] }], ['Slice', { starts: [0], ends: [3], axes: [1], steps: [0] }]]) {
    expect(() => executeIndexNode({ opType, attrs, inputs: ['x'] }, { value: () => input, batch })).toThrow();
  }
  expect(batch.view).not.toHaveBeenCalled(); expect(batch.index).not.toHaveBeenCalled();
});

it('keeps view outputs, writable ScatterND copies, replay updates and disposal independent', async () => {
  const engine = await WasmKokoroCompute.create(readFileSync('extension/public/native/kokoro-engine.wasm'));
  const attributes = values => new Map(Object.entries(values).map(([key, value]) => [key, { type: 7, value }]));
  const graph = { initializers: [], inputs: [{ name: 'x', dataType: 1, dims: [4] },
    { name: 'indices', dataType: 7, dims: [1, 1] }, { name: 'updates', dataType: 1, dims: [1] }],
  outputs: ['same', 'changed', 'sum'].map(name => ({ name, dataType: 1, dims: [4] })), nodes: [
    { opType: 'Slice', inputs: ['x'], outputs: ['same'], attributes: attributes({ starts: [0], ends: [4], axes: [0] }) },
    { opType: 'ScatterND', inputs: ['x', 'indices', 'updates'], outputs: ['changed'], attributes: new Map() },
    { opType: 'Add', inputs: ['same', 'changed'], outputs: ['sum'], attributes: new Map() },
  ] };
  const session = new WebGpuOnnxSession({ graph, functions: [] }, engine, false, 4096);
  session.kokoro = await engine.createKokoroKernels();
  try {
    for (const values of [[1, 2, 3, 4], [5, 6, 7, 8]]) {
      const result = await session.run({ x: { data: Float32Array.from(values), shape: [4] },
        indices: { data: BigInt64Array.of(0n), shape: [1, 1] }, updates: { data: Float32Array.of(99), shape: [1] } });
      expect([...result.same.data]).toEqual(values);
      expect([...result.changed.data]).toEqual([99, ...values.slice(1)]);
      expect([...result.sum.data]).toEqual([values[0] + 99, ...values.slice(1).map(value => 2 * value)]);
      result.same.data.fill(-1); expect(result.changed.data[0]).toBe(99);
    }
    expect(session.lastRun.cacheHit).toBe(true);
  } finally {
    await session.dispose(); expect(engine.buffers.size).toBe(0); expect(engine.tensors.size).toBe(0); await engine.dispose();
  }
});
