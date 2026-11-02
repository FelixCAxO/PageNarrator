import { expect, it, vi } from 'vitest';
import { indexRangeInputNames } from '../../src/engines/onnx-metadata-inputs.js';
import { IntegerRangeProofError, integerAddRange, integerMultiplyRange, integerRange } from '../../src/engines/bounded-integers.js';
import { WebGpuOnnxSession } from '../../src/engines/webgpu-onnx-session.js';

const node = (opType, inputs, output) => ({ opType, inputs, outputs: [output], attrs: {} });
it('finds lookup sources through integer transforms and arithmetic while excluding shape controls', () => {
  const nodes = [node('Mul', ['tokens', 'scale'], 'offset'), node('Add', ['offset', 'bias'], 'indices'),
    node('Gather', ['weights', 'indices'], 'out'), node('Shape', ['data'], 'shape'), node('Gather', ['shape', 'axis'], 'dimension'),
    node('Gather', ['weights', 'control'], 'other')];
  const types = new Map(['tokens', 'scale', 'offset', 'bias', 'indices', 'shape', 'axis', 'dimension', 'control'].map(name => [name, 7]));
  types.set('data', 7); types.set('weights', 1); types.set('out', 1); types.set('other', 1);
  expect([...indexRangeInputNames(nodes, ['tokens', 'data', 'control'], types, new Set(['control']))]).toEqual(['tokens']);
});
it('does not cross float values, unknown types or foreign operators', () => {
  const types = new Map([['x', 1], ['integer', 6], ['idx', 7], ['foreign', 7]]);
  const nodes = [node('Cast', ['x'], 'integer'), node('Gather', ['weights', 'integer'], 'a'),
    { ...node('Identity', ['idx'], 'foreign'), domain: 'custom' }, node('Gather', ['weights', 'foreign'], 'b'),
    { ...node('Gather', ['weights', 'idx'], 'c'), domain: 'custom' }, node('Gather', ['weights', 'unknown'], 'd')];
  expect([...indexRangeInputNames(nodes, ['x', 'idx'], types, new Set())]).toEqual([]);
});
it('keeps input-validation errors distinct from conservative arithmetic-proof failures', () => {
  expect(() => integerRange([2147483648])).toThrow(RangeError);
  try { integerRange([2147483648]); } catch (error) { expect(error).not.toBeInstanceOf(IntegerRangeProofError); }
  for (const op of [integerAddRange, integerMultiplyRange]) {
    expect(() => op({ min: 2147483647, max: 2147483647 }, { min: 2, max: 2 })).toThrow(IntegerRangeProofError);
  }
});

function session() {
  const s = Object.create(WebGpuOnnxSession.prototype);
  Object.assign(s, { closed: false, running: null, outputNames: ['out'], nodes: [], indexRangeInputs: new Set(['ids']),
    cachedPlans: new Map(), weights: new Map(), initializers: new Map(), valueTypes: new Map(), metadataInputs: new Set(),
    booleanFeeds: new Map(), workspacePlans: new Map(), ownsEngine: false, engine: {} });
  return s;
}
it('drains a failed wider proof before retrying exact ranges once', async () => {
  const s = session(), events = [];
  s.infer = vi.fn(async () => {
    events.push('attempt');
    if (s.infer.mock.calls.length === 1) {
      s.rangeExpansionApplied = true;
      await Promise.resolve(); events.push('cleanup');
      throw new Error('ONNX Add', { cause: new IntegerRangeProofError('overflow') });
    }
    expect(s.indexRangeInputs.size).toBe(0); return { out: 'exact' };
  });
  expect(await s.run({})).toEqual({ out: 'exact' });
  expect(events).toEqual(['attempt', 'cleanup', 'attempt']); expect(s.running).toBe(null);
});
it.each([new RangeError('invalid indices'), new Error('device lost'), null])('does not retry unrelated errors: %s', async error => {
  const s = session(); s.infer = vi.fn(async () => { s.rangeExpansionApplied = true; throw error; });
  await expect(s.run({})).rejects.toBe(error); expect(s.infer).toHaveBeenCalledTimes(1);
});
it('does not retry arithmetic errors when no proof was widened and limits failed retries to two attempts', async () => {
  const s = session(); s.infer = vi.fn(async () => { throw new IntegerRangeProofError('overflow'); });
  await expect(s.run({})).rejects.toThrow('overflow'); expect(s.infer).toHaveBeenCalledTimes(1);
  s.infer = vi.fn(async () => { s.rangeExpansionApplied = true; throw new IntegerRangeProofError('overflow'); });
  await expect(s.run({})).rejects.toThrow('overflow'); expect(s.infer).toHaveBeenCalledTimes(2);
});
it('keeps retry work serialized and disposal waits for the complete operation', async () => {
  const s = session(); let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  s.infer = vi.fn(async () => {
    if (s.infer.mock.calls.length === 1) { s.rangeExpansionApplied = true; throw new IntegerRangeProofError('overflow'); }
    return pending;
  });
  const running = s.run({}); await vi.waitFor(() => expect(s.infer).toHaveBeenCalledTimes(2));
  await expect(s.run({})).rejects.toThrow('active inference');
  let disposed = false; const disposal = s.dispose().then(() => { disposed = true; });
  await Promise.resolve(); expect(disposed).toBe(false);
  finish({ out: 'done' }); expect(await running).toEqual({ out: 'done' }); await disposal;
  expect(disposed).toBe(true); expect(s.running).toBe(null);
});
