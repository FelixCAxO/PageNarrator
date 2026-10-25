import { describe, expect, it } from 'vitest';
import { gemmPlan, layerNormalizationPlan, lstmPlan, stftPlan, referenceLstm, referenceStft, referenceLayerNormalization } from '../../src/engines/kokoro-kernels-shape.js';
import { createKokoroKernels } from '../../src/engines/kokoro-kernels.js';

describe('Kokoro graph-specific planners', () => {
  it('validates transposed Gemm inner dimensions and output-only bias broadcasting', () => {
    expect(gemmPlan([1, 128], [1024, 128], [1024], { transB: 1 }).shape).toEqual([1, 1024]);
    expect(gemmPlan([128, 2], [128, 12], [2, 12], { transA: 1 }).shape).toEqual([2, 12]);
    for (const args of [[[1, 128], [128, 4], [2, 4]], [[1, 128], [127, 4]], [[1, 128], [128, 4], null, { alpha: 2 }]]) expect(() => gemmPlan(...args)).toThrow();
  });
  it('checks actual bidirectional H256 contracts and refuses unsupported dimensions', () => {
    const plan = lstmPlan([50, 1, 640], [2, 1024, 640], [2, 1024, 256], [2, 2048], [2, 1, 256], [2, 1, 256], { hiddenSize: 256 });
    expect(plan.shape).toEqual([50, 2, 1, 256]); expect(plan.stateShape).toEqual([2, 1, 256]);
    expect(() => lstmPlan([50, 1, 640], [2, 1024, 640], [2, 1024, 256], [2, 2048], [2, 1, 256], [2, 1, 255], { hiddenSize: 256 })).toThrow();
    expect(() => lstmPlan([50, 1, 640], [2, 1024, 640], [2, 1024, 256], [2, 2048], [2, 1, 256], [2, 1, 256], { hiddenSize: 257 })).toThrow();
  });
  it('checks the pinned real 20-sample spectral contract with five-sample hop', () => {
    expect(stftPlan([1, 35], [20], { frameLength: 20, frameStep: 5 }).shape).toEqual([1, 4, 11, 2]);
    expect(stftPlan([2, 19, 1], [20], { frameLength: 20, frameStep: 5 }).shape).toEqual([2, 0, 11, 2]);
    for (const args of [[[1, 35, 2], [20], { frameLength: 20, frameStep: 5 }], [[1, 35], [20], { frameLength: 20, frameStep: 0 }], [[1, 35], [19], { frameLength: 20, frameStep: 5 }]]) expect(() => stftPlan(...args)).toThrow();
  });
  it('rejects unsupported normalization axes, feature scales and epsilon', () => {
    expect(layerNormalizationPlan([2, 3, 512], [512], [512], { epsilon: 1e-12 })).toMatchObject({ rows: 6, width: 512 });
    expect(() => layerNormalizationPlan([2, 3, 512], [3], [3])).toThrow();
    expect(() => layerNormalizationPlan([2, 3, 512], [512], null, { axis: 1 })).toThrow();
    expect(() => layerNormalizationPlan([2, 3, 512], [512], null, { epsilon: NaN })).toThrow();
  });
});

describe('independent scalar reference cases', () => {
  it('normalizes each row with centered variance, including constant high-offset features', () => {
    const actual = referenceLayerNormalization(Float32Array.of(1, 2, 3, 11, 12, 13), [2, 3], Float32Array.of(1, 1, 1), null, { epsilon: 0 });
    expect(actual[0]).toBeCloseTo(-Math.sqrt(1.5), 6); expect(actual[1]).toBe(0); expect(actual[2]).toBeCloseTo(Math.sqrt(1.5), 6);
    expect(Array.from(actual.slice(3))).toEqual(Array.from(actual.slice(0, 3)));
    const constant = referenceLayerNormalization(new Float32Array(128).fill(1e6), [1, 128], new Float32Array(128).fill(2), new Float32Array(128).fill(3), { epsilon: 1e-12 });
    expect(constant.every(value => value === 3)).toBe(true);
  });
  it('uses ONNX i/o/f/c gate order and stores reverse outputs at their original sequence times', () => {
    const weights = new Float32Array(8); weights[3] = weights[7] = 1;
    const [y, h, c] = referenceLstm(Float32Array.of(1, 2), weights, new Float32Array(8), new Float32Array(16),
      new Float32Array(2), new Float32Array(2), [2, 1, 1], { hiddenSize: 1, direction: 'bidirectional' });
    const cForward1 = .5 * Math.tanh(1), cForward2 = .5 * cForward1 + .5 * Math.tanh(2);
    const cReverse1 = .5 * Math.tanh(2), cReverse2 = .5 * cReverse1 + .5 * Math.tanh(1);
    expect(y[0]).toBeCloseTo(.5 * Math.tanh(cForward1), 6);
    expect(y[1]).toBeCloseTo(.5 * Math.tanh(cReverse2), 6);
    expect(y[2]).toBeCloseTo(.5 * Math.tanh(cForward2), 6);
    expect(y[3]).toBeCloseTo(.5 * Math.tanh(cReverse1), 6);
    expect(h[0]).toBe(y[2]); expect(h[1]).toBe(y[1]);
    expect(c[0]).toBeCloseTo(cForward2, 6); expect(c[1]).toBeCloseTo(cReverse2, 6);
  });
  it('retains initial states for empty sequences and never shares state storage with inputs', () => {
    const h0 = Float32Array.of(.2), c0 = Float32Array.of(.3);
    const [y, h, c] = referenceLstm(new Float32Array(), new Float32Array(4), new Float32Array(4), new Float32Array(8), h0, c0, [0, 1, 1], { hiddenSize: 1, direction: 'forward' });
    expect(y.length).toBe(0); expect(h).toEqual(h0); expect(c).toEqual(c0); expect(h).not.toBe(h0); expect(c).not.toBe(c0);
  });
  it('matches real Fourier DC and phase, including separate signal batches', () => {
    const dc = referenceStft(Float32Array.of(1, 1, 1, 1), [1, 4], new Float32Array(4).fill(1), { frameLength: 4, frameStep: 2 });
    expect(dc[0]).toBe(4); expect(dc[1]).toBe(0); for (const value of dc.slice(2)) expect(Math.abs(value)).toBeLessThan(1e-6);
    const signal = referenceStft(Float32Array.of(0, 1, 0, -1, 0, -1, 0, 1), [2, 4], new Float32Array(4).fill(1), { frameLength: 4, frameStep: 1 });
    expect(signal[2]).toBeCloseTo(0, 6); expect(signal[3]).toBe(-2); expect(signal[9]).toBe(2);
  });
});

it('encodes recurrent projection and three output slots within eight storage bindings, reclaiming private temporaries', async () => {
  const calls = [], recycled = new Set();
  const kernels = await createKokoroKernels({ pipeline: async (code, name) => ({ code, name }) });
  const tensor = shape => ({ shape, dataType: 'float32' });
  const batch = {
    check: (...values) => { if (values.some(value => value.dataType !== 'float32')) throw new Error('dtype'); },
    view: (_, shape) => tensor(shape), index: (_, plan) => tensor(plan.shape), output: tensor,
    matmul: (a, b) => tensor([Math.max(a.shape[0], b.shape[0]), a.shape.at(-2), b.shape.at(-1)]),
    recycle: value => recycled.add(value), dispatchTensors: (...args) => calls.push(args),
  };
  const outputs = kernels.lstm(batch, tensor([3, 2, 4]), tensor([2, 8, 4]), tensor([2, 8, 2]), tensor([2, 16]), tensor([2, 2, 2]), tensor([2, 2, 2]), { hiddenSize: 2 });
  expect(outputs.map(value => value.shape)).toEqual([[3, 2, 2, 2], [2, 2, 2], [2, 2, 2]]);
  expect(outputs.some(value => recycled.has(value))).toBe(false); expect(recycled.size).toBe(5);
  expect(calls).toHaveLength(1); expect(calls[0][1]).toHaveLength(7); // Seven tensors plus one configuration storage binding.
  expect(calls[0].slice(3)).toEqual([2, 2]);
});
