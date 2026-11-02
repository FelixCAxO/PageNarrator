import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { eliminateHalfCastRoundTrips, reuseIdenticalTransforms } from '../../src/engines/onnx-optimize.js';
import { WebGpuOnnxSession } from '../../src/engines/webgpu-onnx-session.js';
import { WasmKokoroCompute } from '../../src/engines/kokoro-cpu-compute.js';
import { selectExecutionPlan } from '../../src/engines/onnx-execution-plan.js';

const node = (opType, input, output, attrs = {}) => ({ opType, inputs: [input], outputs: [output], attrs });

it('removes half-to-float-to-half round trips while preserving lossy narrowing and requested widened outputs', () => {
  const nodes = [node('Cast', 'half', 'wide', { to: 1 }), node('Cast', 'wide', 'back', { to: 10 }),
    node('Cast', 'float', 'narrow', { to: 10 }), node('Cast', 'narrow', 'expanded', { to: 1 })];
  const types = new Map([['half', 10], ['wide', 1], ['float', 1], ['narrow', 10]]);
  const result = eliminateHalfCastRoundTrips(nodes, types);
  expect(result[1]).toMatchObject({ opType: 'Identity', inputs: ['half'], outputs: ['back'] });
  for (const i of [0, 2, 3]) expect(result[i]).toBe(nodes[i]);
  expect(nodes[1].opType).toBe('Cast');
});

it('reuses identical typed transforms and follows their aliases without merging different inputs or attributes', () => {
  const nodes = [node('Cast', 'x', 'a', { to: 1 }), node('Cast', 'x', 'b', { to: 1 }),
    node('Shape', 'a', 'sa', { start: 0, end: 1 }), node('Shape', 'b', 'sb', { end: 1, start: 0 }),
    node('Cast', 'y', 'other', { to: 1 }), node('Cast', 'x', 'integer', { to: 6 }),
    node('Shape', 'a', 'different', { start: 1, end: 2 }), node('Shape', 'a', 'unsafe', { start: NaN })];
  const result = reuseIdenticalTransforms(nodes);
  expect(result[1]).toMatchObject({ opType: 'Identity', inputs: ['a'], outputs: ['b'], attrs: {} });
  expect(result[3]).toMatchObject({ opType: 'Identity', inputs: ['sa'], outputs: ['sb'], attrs: {} });
  for (const i of [0, 2, 4, 5, 6, 7]) expect(result[i]).toBe(nodes[i]);
  expect(nodes[1].opType).toBe('Cast');
});

it('follows repeated float32 casts and Identity while preserving separately requested widened outputs', () => {
  const nodes = [node('Cast', 'half', 'wide', { to: 1 }), node('Identity', 'wide', 'alias'),
    node('Cast', 'alias', 'same', { to: 1 }), node('Cast', 'same', 'back', { to: 10 })];
  const types = new Map([['half', 10], ['wide', 1], ['alias', 1], ['same', 1], ['back', 10]]);
  const result = eliminateHalfCastRoundTrips(nodes, types);
  expect(result[3]).toMatchObject({ opType: 'Identity', inputs: ['half'], outputs: ['back'], attrs: {} });
  expect(selectExecutionPlan(result, ['back']).nodes.map(n => n.opType)).toEqual(['Identity']);
  expect(selectExecutionPlan(result, ['wide', 'same', 'back']).nodes.map(n => n.opType)).toEqual(['Cast', 'Identity', 'Cast', 'Identity']);
  expect(nodes[3].opType).toBe('Cast');
});

it.each(['Add', 'Reshape', 'Transpose', 'Gather', 'Relu'])('stops half-origin propagation at %s', op => {
  const nodes = [node('Cast', 'half', 'wide', { to: 1 }), node(op, 'wide', 'changed'),
    node('Identity', 'changed', 'alias'), node('Cast', 'alias', 'same', { to: 1 }), node('Cast', 'same', 'back', { to: 10 })];
  const types = new Map([['half', 10], ...['wide', 'changed', 'alias', 'same'].map(n => [n, 1])]);
  expect(eliminateHalfCastRoundTrips(nodes, types)[4]).toBe(nodes[4]);
});

it('retains lossy float32 narrowing and integer conversions while optimizing later redundant widening', () => {
  const nodes = [node('Cast', 'float', 'half', { to: 10 }), node('Cast', 'half', 'wide', { to: 1 }),
    node('Cast', 'wide', 'same', { to: 1 }), node('Cast', 'same', 'back', { to: 10 }),
    node('Cast', 'wide', 'integer', { to: 6 }), node('Cast', 'integer', 'expanded', { to: 1 }), node('Cast', 'expanded', 'rounded', { to: 10 })];
  const types = new Map([['float', 1], ['half', 10], ['wide', 1], ['same', 1], ['integer', 6], ['expanded', 1]]);
  const result = eliminateHalfCastRoundTrips(nodes, types);
  expect(result[0]).toBe(nodes[0]);
  expect(result[3]).toMatchObject({ opType: 'Identity', inputs: ['half'] });
  expect(result[6]).toBe(nodes[6]);
});

it('requires ordinary single-input/output casts and attribute-free Identity aliases', () => {
  for (const middle of [node('Identity', 'wide', 'alias', { extra: 1 }),
    { ...node('Identity', 'wide', 'alias'), domain: 'other' },
    { ...node('Cast', 'wide', 'alias', { to: 1 }), domain: 'other' },
    node('Cast', 'wide', 'alias', { to: 1, extra: 1 }),
    { ...node('Cast', 'wide', 'alias', { to: 1 }), outputs: ['alias', 'extra'] }]) {
    const nodes = [node('Cast', 'half', 'wide', { to: 1 }), middle, node('Cast', 'alias', 'back', { to: 10 })];
    expect(eliminateHalfCastRoundTrips(nodes, new Map([['half', 10], ['alias', 1]]))[2]).toBe(nodes[2]);
  }
});

it('keeps named outputs, repeated input updates, plan replay and cleanup correct when casts share one tensor', async () => {
  const engine = await WasmKokoroCompute.create(readFileSync('public/native/kokoro-engine.wasm'));
  const cast = output => ({ opType: 'Cast', inputs: ['x'], outputs: [output], attributes: new Map([['to', { type: 2, value: 1 }]]) });
  const graph = { initializers: [], inputs: [{ name: 'x', dims: [4], dataType: 6 }],
    outputs: ['a', 'b', 'sum'].map(name => ({ name, dims: [4], dataType: 1 })), nodes: [cast('a'), cast('b'),
      { opType: 'Add', inputs: ['a', 'b'], outputs: ['sum'], attributes: new Map() }] };
  const session = new WebGpuOnnxSession({ graph, functions: [] }, engine, false, 4096);
  try {
    for (const values of [[3, -3, 7, -7], [1, -1, 2, -2]]) {
      const result = await session.run({ x: { data: Int32Array.from(values), shape: [4] } });
      expect([...result.a.data]).toEqual(values);
      expect([...result.b.data]).toEqual(values);
      expect([...result.sum.data]).toEqual(values.map(value => value * 2));
      result.a.data.fill(99); expect([...result.b.data]).toEqual(values);
    }
    expect(session.lastRun.cacheHit).toBe(true);
    expect(session.cachedPlan.batch.commands).toHaveLength(2);
  } finally { await session.dispose(); expect(engine.buffers.size).toBe(0); expect(engine.tensors.size).toBe(0); await engine.dispose(); }
});
