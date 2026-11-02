import { afterEach, expect, it, vi } from 'vitest';
import { WebGpuCompute } from '../../src/engines/webgpu-compute.js';
import { WebGpuOnnxSession } from '../../src/engines/webgpu-onnx-session.js';
import { planGpuWorkspace } from '../../src/engines/gpu-workspace-plan.js';

afterEach(() => vi.unstubAllGlobals());
function engine() {
  vi.stubGlobal('GPUBufferUsage', { STORAGE: 128, COPY_SRC: 4, COPY_DST: 8 });
  const gpu = new WebGpuCompute({ addEventListener() {}, removeEventListener() {}, lost: new Promise(() => {}),
    limits: { maxBufferSize: 1e6, maxStorageBufferBindingSize: 1e6 },
    createCommandEncoder: () => ({ finish: () => ({}) }), createBuffer: ({ size }) => ({ size, destroy: vi.fn() }),
    queue: { submit() {}, onSubmittedWorkDone: async () => {}, writeBuffer() {} } }, false);
  gpu.read = async tensor => new Float32Array(tensor.length);
  return gpu;
}
async function release(gpu, batch) {
  batch.cancel({ retainParameters: true });
  await gpu.releaseMany([...batch.outputs], [...batch.scratchBuffers(), ...batch.parameters]);
}

it('packs overlapping lifetimes by capacity and leaves touching intervals free to share', () => {
  const intervals = [{ bytes: 4, start: 0, end: 2 }, { bytes: 8, start: 1, end: 3 }, { bytes: 8, start: 3, end: 5 }];
  const plan = planGpuWorkspace(intervals);
  expect(plan.capacities.reduce((sum, n) => sum + n, 0)).toBe(12);
  expect(plan.slots[1]).toBe(plan.slots[2]); expect(plan.slots[0]).not.toBe(plan.slots[1]);
  expect(Object.isFrozen(plan.capacities)).toBe(true); expect(Object.isFrozen(plan.slots)).toBe(true);
});

it('learns logical sizes and all live views, then allocates only the colored capacities', async () => {
  const gpu = engine(), first = gpu.batch({ recordWorkspace: true });
  const a = first.output([1]), view = first.view(a, [1]); first.recycle(a);
  const b = first.output([2]); first.recycle(view); first.recycle(b);
  const c = first.output([4]); first.recycle(c);
  const plan = first.planWorkspace();
  expect(first.allocatedBytes).toBe(28); expect(plan.capacities).toEqual([16, 4]);
  await release(gpu, first); expect(gpu.buffers.size).toBe(0);
  const next = gpu.batch({ workspacePlan: plan });
  const x = next.output([1]), alias = next.view(x, [1]); next.recycle(x);
  const y = next.output([2]); expect(y.buffer).not.toBe(alias.buffer);
  next.recycle(alias); next.recycle(y); const z = next.output([4]); next.recycle(z);
  expect(next.allocatedBytes).toBe(20); expect(next.allocationCount).toBe(2);
  expect(next.placementHits).toBe(3); expect(next.placementFallbacks).toBe(0);
  await release(gpu, next); expect(gpu.buffers.size).toBe(0); expect(gpu.tensors.size).toBe(0);
});

it('falls back for a stale live-view assignment, smaller capacity and exhausted hints', async () => {
  const gpu = engine(), plan = { capacities: [16], slots: [0, 0, 0] }, batch = gpu.batch({ workspacePlan: plan });
  plan.capacities[0] = 4; plan.slots.fill(99);
  const a = batch.output([4]), view = batch.view(a, [4]); batch.recycle(a);
  const b = batch.output([4]); expect(b.buffer).not.toBe(view.buffer);
  const c = batch.output([8]); expect(c.buffer.size).toBe(32);
  batch.recycle(view); batch.recycle(b); batch.recycle(c);
  const d = batch.output([1]);
  expect(batch.placementHits).toBe(1); expect(batch.placementFallbacks).toBe(3);
  expect(d.buffer.size).toBeGreaterThanOrEqual(4);
  await release(gpu, batch); expect(gpu.buffers.size).toBe(0);
});

it('keeps feed aliases, independent batches and validation flags outside planned slots', async () => {
  const gpu = engine(), input = gpu.upload(Float32Array.of(7), [1]), batch = gpu.batch({ workspacePlan: { capacities: [16], slots: [0, 0] } });
  const view = batch.view(input, [1]), a = batch.output([4]); batch.recycle(a);
  const flag = batch.validationFlag(), other = gpu.batch(), separate = other.output([4]);
  const b = batch.output([4]);
  expect(b.buffer).toBe(a.buffer); expect(b.buffer).not.toBe(flag.buffer);
  expect(b.buffer).not.toBe(input.buffer); expect(b.buffer).not.toBe(separate.buffer);
  expect(batch.workspaceBuffers.has(view.buffer)).toBe(false); expect(batch.workspaceBuffers.has(flag.buffer)).toBe(false);
  await release(gpu, batch); await release(gpu, other); await gpu.release(input);
  expect(gpu.buffers.size).toBe(0);
});

it.each([
  { capacities: [3], slots: [0] }, { capacities: [0], slots: [0] }, { capacities: [1e6 + 4], slots: [0] },
  { capacities: [NaN], slots: [0] }, { capacities: [4], slots: [-1] }, { capacities: [4], slots: [1] },
  { capacities: new Array(513).fill(4), slots: [0] }, { capacities: [4], slots: new Array(513).fill(0) },
])('rejects invalid or unbounded workspace metadata before allocation: %j', plan => {
  const gpu = engine(); expect(() => gpu.batch({ workspacePlan: plan })).toThrow('Invalid workspace placement'); expect(gpu.buffers.size).toBe(0);
});

it('stops tracing oversized graphs and does not produce a partial assignment', async () => {
  const gpu = engine(), batch = gpu.batch({ recordWorkspace: true });
  for (let i = 0; i < 513; i++) batch.recycle(batch.output([1]));
  expect(batch.workspaceTrace).toBeNull(); expect(batch.planWorkspace()).toBeNull();
  await release(gpu, batch); expect(gpu.buffers.size).toBe(0);
});

it('cleans up partial slots after an allocation failure without retaining unowned reservations', async () => {
  const gpu = engine(), batch = gpu.batch({ workspacePlan: { capacities: [16, 8], slots: [0, 1] } });
  const a = batch.output([4]);
  gpu.device.createBuffer = () => { throw new Error('allocation failed'); };
  expect(() => batch.output([2])).toThrow('allocation failed'); expect(batch.allocationCount).toBe(1);
  await release(gpu, batch); expect(a.buffer.destroy).toHaveBeenCalledOnce(); expect(gpu.buffers.size).toBe(0);
});

function session(gpu, count = 1) {
  const widths = [1, 2, 3, 4, 1];
  const graph = { initializers: [], inputs: [{ name: 'x', dataType: 1, dims: ['n'] }], outputs: [{ name: 'y', dataType: 1, dims: ['n'] }],
    nodes: widths.map((_, i) => ({ name: String(i), opType: 'Relu', inputs: [i ? `v${i - 1}` : 'x'], outputs: [i === widths.length - 1 ? 'y' : `v${i}`], attributes: new Map() })) };
  const result = new WebGpuOnnxSession({ graph, functions: [] }, gpu, false, 1, count);
  result.execute = (node, batch, value) => batch.output([node.name === '4' ? value(node.inputs[0]).length / 4 : widths[Number(node.name)]]);
  return result;
}

it('keeps only two CPU hints for uncached shapes, applies them on repeat, and clears them at disposal', async () => {
  const gpu = engine(), s = session(gpu), feed = n => ({ x: { data: new Float32Array(n), shape: [n] } });
  await s.run(feed(1)); expect(s.workspacePlans.size).toBe(1); expect(s.lastRun.intermediateBytes).toBe(40);
  expect(gpu.buffers.size).toBe(0); expect(s.cachedPlans.size).toBe(0);
  await s.run(feed(1)); expect(s.lastRun.intermediateBytes).toBe(28);
  expect(s.lastRun.workspacePlacement).toEqual({ hits: 5, fallbacks: 0 }); expect(gpu.buffers.size).toBe(0);
  await s.run(feed(2)); await s.run(feed(3)); expect(s.workspacePlans.size).toBe(2);
  await s.dispose(); expect(s.workspacePlans.size).toBe(0); expect(gpu.buffers.size).toBe(0); expect(gpu.tensors.size).toBe(0);
});

it('discards a failed hint only after output reads settle, then can learn again', async () => {
  const gpu = engine(), s = session(gpu), feeds = { x: { data: Float32Array.of(0), shape: [1] } };
  await s.run(feeds); const read = gpu.read;
  gpu.read = async () => { throw new Error('read failed'); };
  await expect(s.run(feeds)).rejects.toThrow('read failed'); expect(s.workspacePlans.size).toBe(0); expect(gpu.buffers.size).toBe(0);
  gpu.read = read; await s.run(feeds); expect(s.workspacePlans.size).toBe(1); await s.dispose();
});

it('leaves two-plan GPU sharing outside CPU placement hints', async () => {
  const gpu = engine(), s = session(gpu, 2);
  await s.run({ x: { data: Float32Array.of(0), shape: [1] } });
  expect(s.workspacePlans.size).toBe(0); expect(s.lastRun.workspacePlacement).toBeUndefined();
  await s.dispose(); expect(gpu.buffers.size).toBe(0);
});

it('drops stale hints across dynamic metadata readback and releases both batches', async () => {
  const gpu = engine(), graph = { initializers: [], inputs: [{ name: 'x', dataType: 1, dims: [1] }], outputs: [{ name: 'y', dataType: 1, dims: [1] }],
    nodes: [
      { opType: 'Relu', inputs: ['x'], outputs: ['a'], attributes: new Map() },
      { opType: 'Cast', inputs: ['a'], outputs: ['b'], attributes: new Map([['to', { type: 2, value: 6 }]]) },
      { opType: 'Relu', inputs: ['b'], outputs: ['y'], attributes: new Map() },
    ] };
  const s = new WebGpuOnnxSession({ graph, functions: [] }, gpu, false, 1);
  s.execute = (node, batch) => node.opType === 'Cast' ? { cpu: true, dataType: 6, shape: [1], data: [0] } : batch.output([1]);
  s.workspacePlans.set(JSON.stringify([['y'], [[1]], [0], []]), { capacities: [16], slots: [0, 0] });
  await s.run({ x: { data: Float32Array.of(0), shape: [1] } });
  expect(s.lastRun.metadataReadbacks).toBe(1); expect(s.workspacePlans.size).toBe(0);
  expect(gpu.buffers.size).toBe(0); expect(gpu.tensors.size).toBe(0); await s.dispose();
});

it('rejects overlapping runs and waits for a pending read before disposal', async () => {
  const gpu = engine(), s = session(gpu), feeds = { x: { data: Float32Array.of(0), shape: [1] } };
  await s.run(feeds);
  let finishRead;
  gpu.read = tensor => new Promise(resolve => { finishRead = () => resolve(new Float32Array(tensor.length)); });
  const run = s.run(feeds);
  await expect(s.run(feeds)).rejects.toThrow('already has an active inference');
  const disposed = s.dispose(); expect(gpu.buffers.size).toBeGreaterThan(0);
  finishRead(); await run; await disposed;
  expect(gpu.buffers.size).toBe(0); expect(gpu.tensors.size).toBe(0); expect(s.workspacePlans.size).toBe(0);
});
