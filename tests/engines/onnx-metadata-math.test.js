import { expect, it } from 'vitest';
import { executeMetadataMath } from '../../src/engines/onnx-metadata-math.js';
import { metadataTensor } from '../../src/engines/onnx-metadata.js';
import { halfStorageShader, castShader } from '../../src/engines/webgpu-precision-shaders.js';
import { MATMUL_SHADER } from '../../src/engines/webgpu-shaders.js';
import { metadataInputNames } from '../../src/engines/onnx-metadata-inputs.js';

function run(opType, inputs, attrs = {}) {
  return executeMetadataMath({ opType, inputs: inputs.map((_, i) => String(i)), attrs },
    { value: name => inputs[Number(name)], numbers: name => inputs[Number(name)].data });
}

it('evaluates exact broadcast shape arithmetic and bool selection without GPU readbacks', () => {
  const shape = metadataTensor([2, 1, 7], [3]), scalar = metadataTensor([-1], []);
  expect(run('Mul', [shape, scalar]).data).toEqual([-2, -1, -7]);
  const equal = run('Equal', [shape, metadataTensor([1], [])]);
  expect(equal.dataType).toBe(9); expect(equal.data).toEqual([0, 1, 0]);
  expect(run('Where', [equal, metadataTensor([9], []), shape]).data).toEqual([2, 9, 7]);
  expect(run('Div', [metadataTensor([-7, 7], [2]), metadataTensor([2], [])]).data).toEqual([-3, 3]);
  expect(() => run('Mul', [metadataTensor([Number.MAX_SAFE_INTEGER], []), metadataTensor([2], [])])).toThrow(/exact/);
});

it('expands bounded metadata and preserves fp16 rounding at explicit Cast nodes', () => {
  const expanded = run('Expand', [metadataTensor([3, 4], [1, 2]), metadataTensor([3, 2], [2])]);
  expect(expanded.shape).toEqual([3, 2]); expect(expanded.data).toEqual([3, 4, 3, 4, 3, 4]);
  expect(run('Expand', [metadataTensor([1], []), metadataTensor([1025], [1])])).toBeNull();
  expect(run('Cast', [metadataTensor([1 + 2 ** -11], [1], 1)], { to: 10 }).data).toEqual([1]);
  expect(() => run('Cast', [metadataTensor([Infinity], [1], 1)], { to: 7 })).toThrow(/integer/);
});

it('retains declared floating precision during constant arithmetic and promotes large broadcasts to the backend', () => {
  expect(run('Add', [metadataTensor([16777216], [], 1), metadataTensor([1], [], 1)]).data).toEqual([16777216]);
  expect(run('Mul', [metadataTensor([1.0009765625], [], 10), metadataTensor([1.0009765625], [], 10)]).data).toEqual([1.001953125]);
  expect(run('Add', [metadataTensor(new Array(1024).fill(1), [1024, 1], 1), metadataTensor([1, 2], [1, 2], 1)])).toBeNull();
});

it('truncates quantized Cast values before later float arithmetic and rejects unsupported integer overflow', () => {
  for (const [type, value, expected] of [[2, 1.9, 1], [3, -1.9, -1], [2, 255.9, 255], [3, -128.9, -128]]) {
    const byte = run('Cast', [metadataTensor([value], [], 1)], { to: type });
    expect(byte.data).toEqual([expected]); expect(run('Cast', [byte], { to: 1 }).data).toEqual([expected]);
  }
  for (const [type, value] of [[2, -1], [2, 256], [3, -129], [3, 128], [3, Infinity]]) {
    expect(() => run('Cast', [metadataTensor([value], [], 1)], { to: type })).toThrow(/integer range/);
  }
  expect(() => run('Add', [metadataTensor([2147483647], [], 6), metadataTensor([1], [], 6)])).toThrow(/int32/);
});

it('rounds generated Range values before comparison in the declared floating precision', () => {
  const range = run('Range', [metadataTensor([0], [], 1), metadataTensor([Math.fround(.31)], [], 1), metadataTensor([Math.fround(.1)], [], 1)]);
  expect(range.data).toEqual([0, Math.fround(.1), Math.fround(.2), Math.fround(.3)]);
  expect(run('Equal', [range, metadataTensor([Math.fround(.3)], [], 1)]).data).toEqual([0, 0, 0, 1]);
});

it('specializes only static shader storage while preserving fp32 accumulation and nested indexes', () => {
  const half = halfStorageShader(MATMUL_SHADER);
  expect(half).toContain('enable f16;');
  expect(half).toContain('lhs: array<f16>');
  expect(half).toContain('tileL: array<f32, 256>');
  expect(half).toContain('a = f32(lhs[baseA + (group.y * 16u + r) * cfg[2u] + block + c]);');
  expect(half).toContain('= f16(sum00);');
  expect(castShader('float16', 'float32')).toContain('dst[i] = f32(f32(src[i]))');
});

it('keys only value-dependent shape feeds while leaving ordinary tokens and floating inference on GPU', () => {
  const node = (opType, inputs, output) => ({ opType, inputs, outputs: [output] });
  const nodes = [node('Gather', ['positions', 'zero'], 'first'), node('Unsqueeze', ['first', 'axes'], 'start'),
    node('Shape', ['tokens'], 'tokenShape'), node('ReduceSum', ['wave'], 'duration'),
    node('Slice', ['wave', 'start', 'tokenShape'], 'sliced'), node('Range', ['zero', 'duration', 'one'], 'steps')];
  expect([...metadataInputNames(nodes, ['positions', 'tokens', 'wave'])]).toEqual(['positions']);
});

it('walks deeply nested metadata dependencies without consuming the JavaScript call stack', () => {
  const nodes = Array.from({ length: 20000 }, (_, i) => ({ opType: 'Identity', inputs: [i ? `v${i - 1}` : 'shape'], outputs: [`v${i}`] }));
  nodes.push({ opType: 'Reshape', inputs: ['wave', 'v19999'], outputs: ['out'] });
  expect([...metadataInputNames(nodes, ['shape', 'wave'])]).toEqual(['shape']);
});
