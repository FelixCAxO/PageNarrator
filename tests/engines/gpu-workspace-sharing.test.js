import { afterEach, expect, it, vi } from 'vitest';
import { WebGpuCompute } from '../../src/engines/webgpu-compute.js';

afterEach(() => vi.unstubAllGlobals());
function engine() {
  vi.stubGlobal('GPUBufferUsage', { STORAGE: 128, COPY_SRC: 4, COPY_DST: 8 });
  return new WebGpuCompute({ addEventListener() {}, lost: new Promise(() => {}),
    limits: { maxBufferSize: 1e6, maxStorageBufferBindingSize: 1e6 },
    createCommandEncoder: () => ({}), createBuffer: ({ size }) => ({ size, destroy: vi.fn() }),
    queue: { onSubmittedWorkDone: async () => {}, writeBuffer() {} } }, false);
}

it('shares submitted workspace but waits for every view in the current batch before reuse', () => {
  const gpu = engine(), previous = gpu.batch({ capture: true }), original = previous.output([1024]); previous.submitted = true;
  const batch = gpu.batch({ capture: true, borrowedBuffers: [original.buffer] });
  const first = batch.output([1024]), view = batch.view(first, [1024]);
  expect(first.buffer).toBe(original.buffer); batch.recycle(first);
  const separate = batch.output([2]); expect(separate.buffer).not.toBe(original.buffer);
  batch.recycle(view);
  expect(batch.output([2]).buffer).toBe(original.buffer);
  expect(gpu.tensors.has(original)).toBe(true);
  expect(batch.allocationCount).toBe(1); expect(batch.reuseCount).toBe(2);
});

it('chooses the smaller available loan before a larger recycled buffer', () => {
  const gpu = engine(), old = gpu.batch(), small = old.output([16]); old.submitted = true;
  const batch = gpu.batch({ borrowedBuffers: [small.buffer] }), large = batch.output([1024]);
  batch.recycle(large);
  expect(batch.output([8]).buffer).toBe(small.buffer);
  expect(batch.output([1024]).buffer).toBe(large.buffer);
});

it('keeps input/weight aliases and validation flags outside lendable workspaces', () => {
  const gpu = engine(), input = gpu.upload(Float32Array.of(1, 2), [2]), batch = gpu.batch();
  const view = batch.view(input, [1, 2]);
  expect(batch.workspaceBuffers.has(view.buffer)).toBe(false);
  const reusable = batch.output([16]); batch.recycle(reusable);
  const flag = batch.validationFlag();
  expect(flag.buffer).not.toBe(reusable.buffer);
  expect(batch.workspaceBuffers.has(flag.buffer)).toBe(false);
  expect(batch.output([16]).buffer).toBe(reusable.buffer);
});

it('rejects foreign, released and unsubmitted workspace buffers', async () => {
  const gpu = engine(), other = engine(), foreign = other.batch().output([2]);
  expect(() => gpu.batch({ borrowedBuffers: [foreign.buffer] })).toThrow('submitted storage');
  const old = gpu.batch(), tensor = old.output([2]);
  expect(() => gpu.batch({ borrowedBuffers: [tensor.buffer] })).toThrow('submitted storage');
  old.submitted = true; await gpu.release(tensor);
  expect(() => gpu.batch({ borrowedBuffers: [tensor.buffer] })).toThrow('submitted storage');
});

it('retains shared scratch until the last plan releases its explicit hold', async () => {
  const gpu = engine(), old = gpu.batch(), original = old.output([64]); old.submitted = true;
  const oldHold = gpu.tensor([64], null, original.buffer), next = gpu.batch({ borrowedBuffers: [original.buffer] });
  const temporary = next.output([32]); next.recycle(temporary); next.submitted = true;
  const nextHold = gpu.tensor([64], null, original.buffer);
  await gpu.releaseMany([original, oldHold], [original.buffer]);
  expect(original.buffer.destroy).not.toHaveBeenCalled();
  expect(gpu.buffers.has(original.buffer)).toBe(true);
  await gpu.releaseMany([nextHold], next.scratchBuffers());
  expect(original.buffer.destroy).toHaveBeenCalledTimes(1);
  expect(gpu.buffers.size).toBe(0); expect(gpu.tensors.size).toBe(0);
});
