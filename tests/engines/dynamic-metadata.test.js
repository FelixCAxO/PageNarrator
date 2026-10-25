import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { WebGpuOnnxSession } from '../../src/engines/webgpu-onnx-session.js';
import { WasmKokoroCompute } from '../../src/engines/kokoro-cpu-compute.js';

it('releases completed segment scratch and recomputes value-dependent dimensions within a fixed arena', async () => {
  const engine = await WasmKokoroCompute.create(readFileSync('public/native/kokoro-engine.wasm'), { maxBytes: 1024 * 1024 });
  const node = (opType, inputs, output, attrs = {}) => ({ opType, domain: '', name: output, inputs, outputs: [output],
    attributes: new Map(Object.entries(attrs).map(([name, value]) => [name, { name, type: Array.isArray(value) ? 7 : 2, value }])) });
  const graph = { initializers: [], inputs: [{ name: 'wave', dataType: 1, dims: [65536] }], outputs: [{ name: 'out', dataType: 1, dims: ['samples'] }],
    nodes: [node('Relu', ['wave'], 'first'), node('Relu', ['first'], 'second'), node('ReduceSum', ['second'], 'sum', { keepdims: 0 }),
      node('Cast', ['sum'], 'count', { to: 7 }), node('Unsqueeze', ['count'], 'shape', { axes: [0] }), node('ConstantOfShape', ['shape'], 'out')] };
  const session = new WebGpuOnnxSession({ graph, opsets: [{ version: 17 }], functions: [] }, engine, false, 1024 * 1024);
  try {
    for (const scale of [1, 2]) {
      const result = (await session.run({ wave: { data: new Float32Array(65536).fill(scale), shape: [65536] } })).out;
      expect(result.shape).toEqual([65536 * scale]); expect(result.data.every(value => value === 0)).toBe(true);
      expect(session.lastRun.metadataReadbacks).toBe(1); expect(session.lastRun.cacheHit).toBe(false);
      expect(engine.memory.buffer.byteLength).toBeLessThanOrEqual(1024 * 1024);
      expect(engine.buffers.size).toBe(0); expect(engine.tensors.size).toBe(0);
    }
  } finally { await session.dispose(); await engine.dispose(); }
});

it('materializes undeclared DequantizeLinear intermediates with their scale precision', async () => {
  const engine = await WasmKokoroCompute.create(readFileSync('public/native/kokoro-engine.wasm'));
  const scalar = (name, dataType, data) => ({ name, dataType, dims: [], rawData: new Uint8Array(data.buffer), typedData: new Map(), externalData: new Map() });
  const graph = { inputs: [{ name: 'x', dataType: 2, dims: [] }], outputs: [{ name: 'out', dataType: 1, dims: ['n'] }],
    initializers: [scalar('scale', 1, Float32Array.of(.5)), scalar('start', 1, Float32Array.of(0)), scalar('step', 1, Float32Array.of(.5))], nodes: [
      { opType: 'DequantizeLinear', inputs: ['x', 'scale'], outputs: ['limit'], attributes: new Map() },
      { opType: 'Range', inputs: ['start', 'limit', 'step'], outputs: ['out'], attributes: new Map() },
    ] };
  const session = new WebGpuOnnxSession({ graph, opsets: [{ version: 17 }], functions: [] }, engine, false, 0);
  session.kokoro = await engine.createKokoroKernels();
  try {
    const result = (await session.run({ x: { data: Uint8Array.of(3), shape: [] } })).out;
    expect(result.type).toBe('float32'); expect([...result.data]).toEqual([0, .5, 1]);
  } finally { await session.dispose(); expect(engine.buffers.size).toBe(0); await engine.dispose(); }
});

it('preserves logical int32 metadata after device Cast rather than relabeling it as narrowed int64', async () => {
  const engine = await WasmKokoroCompute.create(readFileSync('public/native/kokoro-engine.wasm'));
  const integer = (name, value) => ({ name, dataType: 6, dims: [], rawData: new Uint8Array(Int32Array.of(value).buffer), typedData: new Map(), externalData: new Map() });
  const graph = { inputs: [{ name: 'x', dataType: 2, dims: [] }], outputs: [{ name: 'out', dataType: 6, dims: ['n'] }],
    initializers: [integer('zero', 0), integer('one', 1)], nodes: [
      { opType: 'Cast', inputs: ['x'], outputs: ['limit'], attributes: new Map([['to', { type: 2, value: 6 }]]) },
      { opType: 'Range', inputs: ['zero', 'limit', 'one'], outputs: ['out'], attributes: new Map() },
    ] };
  const session = new WebGpuOnnxSession({ graph, opsets: [{ version: 17 }], functions: [] }, engine, false, 0);
  try {
    for (const limit of [3, 5]) {
      const result = (await session.run({ x: { data: Uint8Array.of(limit), shape: [] } })).out;
      expect(result.type).toBe('int32'); expect([...result.data]).toEqual(Array.from({ length: limit }, (_, i) => i));
    }
  } finally { await session.dispose(); expect(engine.buffers.size).toBe(0); await engine.dispose(); }
});

it('executes long constant embedding gathers and concatenations beyond the bounded metadata budget', async () => {
  const constant = (name, dataType, dims, data) => ({ name, dataType, dims, rawData: new Uint8Array(data.buffer), typedData: new Map(), externalData: new Map() });
  const weights = Float32Array.from({ length: 256 }, (_, index) => (index - 128) / 256);
  for (const opType of ['Gather', 'Concat']) {
    const engine = await WasmKokoroCompute.create(readFileSync('public/native/kokoro-engine.wasm'), { maxBytes: 1024 * 1024 });
    const initializers = [constant('weight', 1, [1, 256], weights)], shape = opType === 'Gather' ? [1, 150, 256] : [70, 256];
    if (opType === 'Gather') initializers.push(constant('indices', 7, [1, 150], new BigInt64Array(150)));
    const graph = { inputs: [], outputs: [{ name: 'out', dataType: 1, dims: shape }], initializers, nodes: [{ opType,
      inputs: opType === 'Gather' ? ['weight', 'indices'] : new Array(70).fill('weight'), outputs: ['out'],
      attributes: new Map([['axis', { type: 2, value: 0 }]]) }] };
    const session = new WebGpuOnnxSession({ graph, opsets: [{ version: 17 }], functions: [] }, engine, false, 1024 * 1024);
    try {
      for (let run = 0; run < 2; run++) {
        const result = (await session.run({})).out;
        expect(result.shape).toEqual(shape); expect(result.type).toBe('float32');
        expect([...result.data]).toEqual(Array.from({ length: result.data.length }, (_, index) => weights[index % weights.length]));
      }
    } finally { await session.dispose(); expect(engine.buffers.size).toBe(0); expect(engine.tensors.size).toBe(0); await engine.dispose(); }
  }
});
