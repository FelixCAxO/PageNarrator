import { afterEach, expect, it, vi } from 'vitest';
import { WebGpuCompute } from '../../src/engines/webgpu-compute.js';
afterEach(() => vi.unstubAllGlobals());

it('reuses larger scratch storage only after all tensor views stop owning it', () => {
  vi.stubGlobal('GPUBufferUsage', { STORAGE: 128, COPY_SRC: 4, COPY_DST: 8 });
  const engine = new WebGpuCompute({ addEventListener() {}, lost: new Promise(() => {}),
    limits: { maxBufferSize: 1e6, maxStorageBufferBindingSize: 1e6 },
    createCommandEncoder: () => ({}), createBuffer: ({ size }) => ({ size }) }, false);
  const batch = engine.batch({ capture: true });
  const large = batch.output([1024]), view = batch.view(large, [1024]);
  batch.recycle(large);
  const small = batch.output([2]); expect(small.buffer).not.toBe(large.buffer);
  batch.recycle(view);
  const next = batch.output([2]); expect(next.buffer).toBe(large.buffer);
  expect(batch.allocationCount).toBe(2); expect(batch.reuseCount).toBe(1);
});

it('keeps cached dispatches ordered in a compute pass and ends it around buffer copies', () => {
  const events = [];
  const encoder = {
    beginComputePass() {
      events.push('begin');
      return { setPipeline: pipeline => events.push(pipeline), setBindGroup() {}, dispatchWorkgroups() {}, end: () => events.push('end') };
    },
    copyBufferToBuffer: () => events.push('copy'), finish: () => 'commands',
  };
  const engine = new WebGpuCompute({ addEventListener() {}, lost: new Promise(() => {}),
    createCommandEncoder: () => encoder, queue: { submit: () => events.push('submit') } }, false);
  const batch = engine.batch({ capture: true });
  batch.submitted = true;
  const dispatch = pipeline => ({ pipeline, group: {}, x: 1, y: 1, z: 1 });
  batch.commands.push(dispatch('first'), dispatch('second'), { copy: true, bytes: 4 }, dispatch('third'), dispatch('fourth'));
  batch.replay();
  expect(events).toEqual(['begin', 'first', 'second', 'end', 'copy', 'begin', 'third', 'fourth', 'end', 'submit']);
});
