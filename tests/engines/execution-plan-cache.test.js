import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { WebGpuOnnxSession } from '../../src/engines/webgpu-onnx-session.js';
import { WasmOcrCompute } from '../../src/engines/wasm-ocr-compute.js';

async function setup(budget) {
  const engine = await WasmOcrCompute.create(readFileSync('public/native/ocr-engine.wasm'));
  const graph = { initializers: [], inputs: [{ name: 'x', dataType: 1, dims: ['n'] }], outputs: [{ name: 'y', dataType: 1, dims: ['n'] }],
    nodes: [{ name: 'relu', opType: 'Relu', inputs: ['x'], outputs: ['y'], attributes: new Map() }] };
  const session = new WebGpuOnnxSession({ graph, opsets: [{ version: 17 }], functions: [] }, engine, false, budget, 2);
  return { engine, session };
}

it('replays alternating shapes with changed feed values and evicts the least recently used plan', async () => {
  const { engine, session } = await setup(4096);
  try {
    for (const [index, [length, cacheHit]] of [[32, false], [64, false], [32, true], [96, false], [64, false]].entries()) {
      const data = Float32Array.from({ length }, (_, i) => (i - 12) * (index + 1));
      const result = (await session.run({ x: { data, shape: [length] } })).y;
      expect([...result.data]).toEqual([...data].map(value => Math.max(0, value)));
      expect(session.lastRun.cacheHit).toBe(cacheHit);
      expect(session.cachedPlans.size).toBeLessThanOrEqual(2);
    }
  } finally { await session.dispose(); expect(engine.buffers.size).toBe(0); expect(engine.tensors.size).toBe(0); await engine.dispose(); }
});

it('uploads aliased feeds once, preserves mutations and never reuses aliases for independent inputs', async () => {
  const engine = await WasmOcrCompute.create(readFileSync('public/native/ocr-engine.wasm'));
  const graph = { initializers: [], inputs: ['x', 'z'].map(name => ({ name, dataType: 1, dims: ['n'] })), outputs: [{ name: 'y', dataType: 1, dims: ['n'] }],
    nodes: [{ name: 'sum', opType: 'Add', inputs: ['x', 'z'], outputs: ['y'], attributes: new Map() }] };
  const session = new WebGpuOnnxSession({ graph, opsets: [{ version: 17 }], functions: [] }, engine, false, 4096, 2);
  const shared = Float32Array.of(-2, 3), feed = data => ({ data, shape: [2] });
  try {
    expect([...(await session.run({ x: feed(shared), z: feed(shared) })).y.data]).toEqual([-4, 6]);
    expect(session.cachedPlan.inputs.get('x')).toBe(session.cachedPlan.inputs.get('z'));
    let writes = 0;
    const write = engine.write.bind(engine);
    engine.write = (...args) => { writes += 1; return write(...args); };
    shared.set([4, 5]);
    expect([...(await session.run({ x: feed(shared), z: feed(shared) })).y.data]).toEqual([8, 10]);
    expect(session.lastRun.cacheHit).toBe(true);
    expect(writes).toBe(1);
    expect([...(await session.run({ x: feed(shared), z: feed(Float32Array.of(10, 20)) })).y.data]).toEqual([14, 25]);
    expect(session.lastRun.cacheHit).toBe(false);
    expect(session.cachedPlan.inputs.get('x')).not.toBe(session.cachedPlan.inputs.get('z'));
  } finally { await session.dispose(); expect(engine.buffers.size).toBe(0); await engine.dispose(); }
});

it('drops host model payload references and still disposes its owned engine when plan cleanup fails', async () => {
  const { engine, session } = await setup(4096);
  session.ownsEngine = true;
  session.initializers.set('large', { rawData: new Uint8Array(1024 * 1024) });
  session.releasePlan = async () => { throw new Error('Injected plan-release failure'); };
  await expect(session.dispose()).rejects.toThrow('Injected plan-release failure');
  expect(session.model).toBeNull(); expect(session.initializers.size).toBe(0); expect(session.nodes.length).toBe(0);
  expect(engine.closed).toBe(true); expect(engine.memory).toBeNull();
});

it('keeps cached metadata outputs independent from caller shape and data mutations', async () => {
  const engine = await WasmOcrCompute.create(readFileSync('public/native/ocr-engine.wasm'));
  const graph = { initializers: [], inputs: [{ name: 'x', dataType: 1, dims: [2, 3] }], outputs: [{ name: 's', dataType: 7, dims: [2] }],
    nodes: [{ name: 'shape', opType: 'Shape', inputs: ['x'], outputs: ['s'], attributes: new Map() }] };
  const session = new WebGpuOnnxSession({ graph, functions: [] }, engine, false, 4096, 2);
  const feeds = { x: { data: new Float32Array(6), shape: [2, 3] } };
  try {
    const first = (await session.run(feeds)).s;
    expect(first.shape).toEqual([2]); expect([...first.data]).toEqual([2n, 3n]);
    first.shape[0] = 99; first.data[0] = 100n;
    const second = (await session.run(feeds)).s;
    expect(session.lastRun.cacheHit).toBe(true);
    expect(second.shape).toEqual([2]); expect([...second.data]).toEqual([2n, 3n]);
    expect(first.shape).toEqual([99]); expect([...first.data]).toEqual([100n, 3n]);
  } finally { await session.dispose(); expect(engine.buffers.size).toBe(0); expect(engine.tensors.size).toBe(0); await engine.dispose(); }
});

it('uploads large weights once and detaches small metadata from their backing payload', async () => {
  const engine = await WasmOcrCompute.create(readFileSync('public/native/ocr-engine.wasm'));
  const payload = new Float32Array(2048).fill(2);
  const tensor = (name, offset, length) => ({ name, dims: [length], dataType: 1,
    rawData: new Uint8Array(payload.buffer, offset * 4, length * 4), typedData: new Map(), externalData: new Map(), dataLocation: 0 });
  const graph = { initializers: [tensor('weight', 0, 1050), tensor('metadata', 1500, 1)],
    inputs: [{ name: 'x', dataType: 1, dims: [1050] }], outputs: [{ name: 'y', dataType: 1, dims: [1050] }],
    nodes: [{ opType: 'Add', name: 'add', inputs: ['x', 'weight'], outputs: ['y'], attributes: new Map() }] };
  const session = new WebGpuOnnxSession({ graph, functions: [] }, engine, false, 1024 * 1024, 2);
  try {
    session.releaseHostWeights();
    expect(session.initializers.get('weight').rawData).toBeNull();
    const metadata = session.initializers.get('metadata').rawData;
    expect(metadata.buffer).not.toBe(payload.buffer); expect(metadata.byteLength).toBe(4);
    expect(session.model.graph.initializers).toEqual([]); expect(session.model.graph.nodes).toEqual([]);
    const weight = session.weights.get('weight');
    for (const n of [3, 7]) {
      const result = (await session.run({ x: { data: new Float32Array(1050).fill(n), shape: [1050] } })).y;
      expect([...result.data]).toEqual(new Array(1050).fill(n + 2));
      expect(session.weights.get('weight')).toBe(weight);
    }
  } finally { await session.dispose(); expect(engine.buffers.size).toBe(0); await engine.dispose(); }
});

it('recycles unused named outputs before later operators allocate scratch storage', async () => {
  const engine = await WasmOcrCompute.create(readFileSync('public/native/ocr-engine.wasm'));
  const graph = { initializers: [], inputs: [{ name: 'x', dataType: 1, dims: [4] }], outputs: [{ name: 'y', dataType: 1, dims: [2] }], nodes: [
    { name: 'split', opType: 'Split', inputs: ['x'], outputs: ['kept', 'unused'], attributes: new Map([['axis', { type: 2, value: 0 }], ['split', { type: 7, value: [2, 2] }]]) },
    { name: 'relu', opType: 'Relu', inputs: ['kept'], outputs: ['y'], attributes: new Map() },
  ] };
  const session = new WebGpuOnnxSession({ graph, functions: [] }, engine, false, 4096, 2);
  try {
    expect([...(await session.run({ x: { data: Float32Array.of(-2, 3, 4, 5), shape: [4] } })).y.data]).toEqual([0, 3]);
    expect(session.lastRun.allocations).toBe(2);
    expect([...(await session.run({ x: { data: Float32Array.of(7, -1, 2, 3), shape: [4] } })).y.data]).toEqual([7, 0]);
    expect(session.lastRun.cacheHit).toBe(true);
  } finally { await session.dispose(); expect(engine.buffers.size).toBe(0); await engine.dispose(); }
});

it('releases both cached shapes from a shared engine even when one completion reports failure', async () => {
  const { engine, session } = await setup(4096);
  for (const length of [32, 64]) await session.run({ x: { data: new Float32Array(length), shape: [length] } });
  const release = engine.releaseMany.bind(engine); let calls = 0;
  engine.releaseMany = async (...args) => { await release(...args); if (++calls === 1) throw new Error('Injected completion failure'); };
  try {
    await expect(session.dispose()).rejects.toThrow('Injected completion failure');
    expect(calls).toBe(2); expect(engine.buffers.size).toBe(0); expect(engine.tensors.size).toBe(0);
    expect(engine.closed).toBe(false); expect(session.model).toBeNull();
  } finally { await engine.dispose(); }
});

it('applies one shared retained-byte budget to both shapes and releases all storage after errors', async () => {
  const { engine, session } = await setup(512);
  try {
    for (const length of [32, 64, 32, 128]) {
      await session.run({ x: { data: new Float32Array(length), shape: [length] } });
      expect([...session.cachedPlans.values()].reduce((sum, plan) => sum + plan.stats.planBytes, 0)).toBeLessThanOrEqual(512);
    }
    await expect(session.run({ x: { data: new Float32Array(2), shape: [3] } })).rejects.toThrow(/count/);
  } finally { await session.dispose(); expect(engine.buffers.size).toBe(0); expect(engine.tensors.size).toBe(0); await engine.dispose(); }
});
