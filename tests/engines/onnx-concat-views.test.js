import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { executeIndexNode } from '../../src/engines/onnx-metadata.js';
import { WebGpuOnnxSession } from '../../src/engines/webgpu-onnx-session.js';
import { WasmKokoroCompute } from '../../src/engines/kokoro-cpu-compute.js';

const tensor = (shape, dataType = 'float16') => ({ shape, dataType, owned: true });
function context(inputs, axis) {
  const batch = { view: vi.fn((input, shape) => ({ input, shape })), concat: vi.fn(() => 'copied'),
    checkOwnership: vi.fn((...items) => { if (items.some(item => !item.owned)) throw new Error('Foreign tensor.'); }) };
  return { batch, run: () => executeIndexNode({ opType: 'Concat', inputs: inputs.map((_, i) => String(i)), attrs: { axis } },
    { value: name => inputs[Number(name)], batch }) };
}
it.each([
  [[1, 8, 7, 128], [1, 8, 0, 128], -2, 'float16'],
  [[2, 3], [0, 3], 0, 'float32'], [[3], [0], -1, 'int32'], [[3], [0], 0, 'bool'],
])('reuses the one nonempty device input after validating all inputs: %j', (shape, empty, axis, type) => {
  const live = tensor(shape, type), inputs = [tensor(empty, type), live, tensor(empty, type)], c = context(inputs, axis);
  expect(c.run()).toEqual({ input: live, shape });
  expect(c.batch.checkOwnership).toHaveBeenCalledWith(...inputs); expect(c.batch.concat).not.toHaveBeenCalled();
});
it('keeps a single-input Concat as an independently owned tensor view', () => {
  const live = tensor([2, 3]), c = context([live], 1);
  expect(c.run()).toEqual({ input: live, shape: [2, 3] }); expect(c.batch.view).toHaveBeenCalledOnce();
});
it.each([[[0, 3], [0, 3]], [[1, 3], [2, 3]]])('retains the ordinary concat path for %j', (...shapes) => {
  const inputs = shapes.map(shape => tensor(shape)), c = context(inputs, 0);
  expect(c.run()).toBe('copied'); expect(c.batch.concat).toHaveBeenCalledWith(inputs, 0); expect(c.batch.view).not.toHaveBeenCalled();
});
it.each([
  [[tensor([0, 3]), tensor([2, 3])], 3, /axis/],
  [[tensor([0, 4]), tensor([2, 3])], 0, /shapes/],
  [[{ ...tensor([0, 3]), owned: false }, tensor([2, 3])], 0, /Foreign/],
])('rejects invalid inputs before creating a view', (inputs, axis, message) => {
  const c = context(inputs, axis); expect(c.run).toThrow(message); expect(c.batch.view).not.toHaveBeenCalled();
});
it('preserves the backend type-mismatch rejection even for an empty input', () => {
  const c = context([tensor([0], 'float32'), tensor([2])], 0);
  c.batch.concat.mockImplementation(() => { throw new Error('Original type error.'); });
  expect(c.run).toThrow('Original type error'); expect(c.batch.view).not.toHaveBeenCalled();
});
it('preserves named outputs, writable ScatterND results, cached updates and disposal on the CPU engine', async () => {
  const engine = await WasmKokoroCompute.create(readFileSync('public/native/kokoro-engine.wasm'));
  const node = (opType, inputs, output, attributes = new Map()) => ({ opType, inputs, outputs: [output], attributes });
  const graph = { initializers: [], inputs: [{ name: 'x', dataType: 1, dims: [4] }, { name: 'e', dataType: 1, dims: [0] },
    { name: 'indices', dataType: 7, dims: [1, 1] }, { name: 'updates', dataType: 1, dims: [1] }],
  outputs: ['cat', 'changed', 'sum'].map(name => ({ name, dataType: 1, dims: [4] })), nodes: [
    node('Concat', ['e', 'x', 'e'], 'cat', new Map([['axis', { type: 2, value: 0 }]])),
    node('ScatterND', ['cat', 'indices', 'updates'], 'changed'), node('Add', ['cat', 'changed'], 'sum'),
  ] };
  const session = new WebGpuOnnxSession({ graph, functions: [] }, engine, false, 4096); session.kokoro = await engine.createKokoroKernels();
  try {
    for (const values of [[1, 2, 3, 4], [5, 6, 7, 8]]) {
      const out = await session.run({ x: { shape: [4], data: Float32Array.from(values) }, e: { shape: [0], data: new Float32Array() },
        indices: { shape: [1, 1], data: BigInt64Array.of(0n) }, updates: { shape: [1], data: Float32Array.of(99) } });
      expect([...out.cat.data]).toEqual(values); expect([...out.changed.data]).toEqual([99, ...values.slice(1)]);
      expect([...out.sum.data]).toEqual([values[0] + 99, ...values.slice(1).map(x => 2 * x)]);
      out.cat.data.fill(-1); expect(out.changed.data[0]).toBe(99);
    }
    expect(session.lastRun.cacheHit).toBe(true);
  } finally { await session.dispose(); expect(engine.buffers.size).toBe(0); expect(engine.tensors.size).toBe(0); await engine.dispose(); }
});
