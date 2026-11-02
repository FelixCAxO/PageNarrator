import { afterEach, expect, it, vi } from 'vitest';
import { WebGpuCompute } from '../../src/engines/webgpu-compute.js';

afterEach(() => vi.unstubAllGlobals());
function setup() {
  vi.stubGlobal('GPUBufferUsage', { STORAGE: 128, COPY_SRC: 4, COPY_DST: 8 });
  const encoded = [], submitted = [], consumed = new Set();
  const device = { addEventListener() {}, removeEventListener() {}, lost: new Promise(() => {}),
    limits: { maxBufferSize: 1e8, maxStorageBufferBindingSize: 1e8, maxComputeWorkgroupsPerDimension: 65535 },
    createBuffer: ({ size }) => ({ size, destroy: vi.fn() }), createBindGroup: value => value,
    createCommandEncoder: vi.fn(() => {
      const operations = []; let active = false;
      return {
        beginComputePass() {
          expect(active).toBe(false); active = true; let label;
          return { setPipeline: pipeline => { label = pipeline.label; }, setBindGroup() {},
            dispatchWorkgroups: () => { expect(active).toBe(true); operations.push({ kind: 'dispatch', label }); encoded.push(label); },
            end: () => { expect(active).toBe(true); active = false; } };
        },
        copyBufferToBuffer(source, offset, destination, targetOffset, bytes) { expect(active).toBe(false); operations.push({ kind: 'copy', source, destination, bytes }); },
        finish() { expect(active).toBe(false); return { operations }; },
      };
    }),
    queue: { writeBuffer: vi.fn(), onSubmittedWorkDone: vi.fn(async () => {}), submit: vi.fn(buffers => {
      expect(buffers).toHaveLength(1);
      for (const buffer of buffers) { expect(consumed.has(buffer)).toBe(false); consumed.add(buffer); submitted.push(buffer.operations); }
    }) },
  };
  const gpu = new WebGpuCompute(device, false), batch = gpu.batch({ capture: true });
  const dispatch = label => batch.dispatchTensors({ label, getBindGroupLayout() {} }, [], Uint32Array.of(1), 1);
  return { gpu, batch, dispatch, encoded, submitted, device };
}
async function release(gpu, batch) {
  if (!batch.submitted) batch.cancel({ retainParameters: true });
  await gpu.releaseMany([...batch.outputs], [...batch.scratchBuffers(), ...batch.parameters]);
}

it.each([0, 1, 255, 256, 257, 512, 513])('submits and replays %i commands once in ordered bounded buffers', async count => {
  const { gpu, batch, dispatch, encoded, submitted, device } = setup();
  for (let i = 0; i < count; i++) dispatch(i);
  expect(submitted).toHaveLength(0);
  batch.submit({ retainParameters: true });
  const pieces = Math.max(1, Math.ceil(count / 256));
  expect(submitted).toHaveLength(pieces); expect(submitted.every(ops => ops.length <= 256)).toBe(true);
  expect(submitted.flat().map(op => op.label)).toEqual(Array.from({ length: count }, (_, i) => i));
  const retained = gpu.buffers.size; batch.replay();
  expect(gpu.buffers.size).toBe(retained); expect(device.createCommandEncoder).toHaveBeenCalledTimes(2 * pieces);
  expect(encoded).toEqual([...Array.from({ length: count }, (_, i) => i), ...Array.from({ length: count }, (_, i) => i)]);
  expect(submitted.slice(pieces).flat().map(op => op.label)).toEqual(Array.from({ length: count }, (_, i) => i));
  expect(batch.commands).toHaveLength(count); expect(batch.commandBuffers).toHaveLength(0); expect(batch.encoder).toBeNull();
  await release(gpu, batch); expect(gpu.buffers.size).toBe(0);
});

it.each([255, 256])('counts copies at a boundary following %i dispatches and preserves their bindings', async before => {
  const { gpu, batch, dispatch, submitted } = setup(), input = batch.output([1]);
  for (let i = 0; i < before; i++) dispatch(i);
  const output = batch.copy(input); dispatch('last'); batch.submit({ retainParameters: true });
  const operations = submitted.flat();
  expect(operations[before]).toEqual({ kind: 'copy', source: input.buffer, destination: output.buffer, bytes: 4 });
  expect(operations.at(-1).label).toBe('last'); expect(submitted).toHaveLength(2);
  const first = operations; submitted.length = 0; batch.replay(); expect(submitted.flat()).toEqual(first);
  await release(gpu, batch); expect(gpu.buffers.size).toBe(0);
});

it('does not consume a command slot for empty dispatches or zero-length copies', async () => {
  const { gpu, batch, dispatch, submitted } = setup();
  for (let i = 0; i < 256; i++) dispatch(i);
  batch.dispatchTensors(null, [], new Uint32Array(), 0); batch.copy(batch.output([0]));
  batch.submit({ retainParameters: true }); expect(submitted).toHaveLength(1); expect(submitted[0]).toHaveLength(256);
  await release(gpu, batch); expect(gpu.buffers.size).toBe(0);
});

it('cancels without submitting already finished buffers and releases every private parameter', async () => {
  const { gpu, batch, dispatch, submitted } = setup();
  for (let i = 0; i < 513; i++) dispatch(i);
  expect(batch.commandBuffers).toHaveLength(2); batch.cancel({ retainParameters: true });
  expect(submitted).toHaveLength(0); expect(batch.commandBuffers).toHaveLength(0); expect(batch.encoder).toBeNull();
  await release(gpu, batch); expect(gpu.buffers.size).toBe(0); expect(gpu.tensors.size).toBe(0);
});

it('drains a partially submitted capture before destroying buffers after queue failure', async () => {
  const { gpu, batch, dispatch, submitted, device } = setup();
  for (let i = 0; i < 513; i++) dispatch(i);
  const buffers = [...gpu.buffers], submit = device.queue.submit.getMockImplementation();
  device.queue.submit.mockImplementationOnce(submit).mockImplementationOnce(() => { throw new Error('queue failed'); });
  expect(() => batch.submit({ retainParameters: true })).toThrow('queue failed'); expect(submitted).toHaveLength(1);
  batch.cancel({ retainParameters: true });
  let finish; device.queue.onSubmittedWorkDone.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const pending = release(gpu, batch); await Promise.resolve(); expect(buffers.every(buffer => !buffer.destroy.mock.calls.length)).toBe(true);
  finish(); await pending; expect(buffers.every(buffer => buffer.destroy.mock.calls.length === 1)).toBe(true);
  expect(gpu.buffers.size).toBe(0); expect(batch.commandBuffers).toHaveLength(0);
});

it('clears partial replay state, resets validation once per replay, and recovers without new storage', async () => {
  const { gpu, batch, dispatch, device } = setup();
  const flag = batch.validationFlag(); for (let i = 0; i < 513; i++) dispatch(i);
  batch.submit({ retainParameters: true }); const buffers = gpu.buffers.size, writes = device.queue.writeBuffer.mock.calls.length;
  const submit = device.queue.submit.getMockImplementation();
  device.queue.submit.mockImplementationOnce(submit).mockImplementationOnce(() => { throw new Error('replay failed'); });
  expect(() => batch.replay()).toThrow('replay failed'); expect(batch.encoder).toBeNull(); expect(batch.commandBuffers).toHaveLength(0);
  batch.replay(); expect(gpu.buffers.size).toBe(buffers);
  expect(device.queue.writeBuffer.mock.calls.slice(writes).map(args => args[0])).toEqual([flag.buffer, flag.buffer]);
  await release(gpu, batch); expect(gpu.buffers.size).toBe(0);
});

it('submits each replay prefix before encoding the rest while keeping fresh captures unsubmitted', async () => {
  const { gpu, batch, dispatch, encoded, device } = setup(), atSubmission = [];
  const submit = device.queue.submit.getMockImplementation();
  device.queue.submit.mockImplementation(buffers => { atSubmission.push(encoded.length); return submit(buffers); });
  for (let i = 0; i < 513; i++) dispatch(i);
  expect(atSubmission).toEqual([]); batch.submit({ retainParameters: true });
  expect(atSubmission).toEqual([513, 513, 513]); batch.replay();
  expect(atSubmission.slice(3)).toEqual([769, 1025, 1026]);
  await release(gpu, batch); expect(gpu.buffers.size).toBe(0);
});
