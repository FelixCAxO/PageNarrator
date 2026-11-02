import { expect, it, vi } from 'vitest';
import { WebGpuOnnxSession } from '../../src/engines/webgpu-onnx-session.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const validation = Promise.withResolvers(), reading = Promise.withResolvers();
  const engine = { read: vi.fn(() => reading.promise) }, batch = { validate: vi.fn(() => validation.promise) };
  const graph = { initializers: [], inputs: [{ name: 'x', dataType: 1, dims: [1] }], outputs: [{ name: 'y', dataType: 1, dims: [1] }],
    nodes: [{ opType: 'Identity', inputs: ['x'], outputs: ['y'], attributes: new Map() }] };
  const session = new WebGpuOnnxSession({ graph, functions: [] }, engine, false, 0);
  const tensor = { dataType: 'float32', shape: [1] }, outputs = new Map([['y', tensor]]);
  return { session, engine, batch, tensor, outputs, validation, reading };
}

it('queues output readback before validation resolves and exposes nothing until both finish', async () => {
  const f = fixture(), result = f.session.readValidatedOutputs(f.batch, f.outputs);
  expect(f.batch.validate).toHaveBeenCalledOnce(); expect(f.engine.read).toHaveBeenCalledWith(f.tensor, { validate: false });
  let settled = false; void result.then(() => { settled = true; });
  f.reading.resolve(Float32Array.of(7)); await tick(); expect(settled).toBe(false);
  f.validation.resolve(); expect([...(await result).y.data]).toEqual([7]);
});

it('drains an in-flight output read before rejecting invalid GPU indices', async () => {
  const f = fixture(), result = f.session.readValidatedOutputs(f.batch, f.outputs), error = new RangeError('Bad GPU index');
  let settled = false; void result.then(() => { settled = true; }, () => { settled = true; });
  f.validation.reject(error); await tick(); expect(settled).toBe(false);
  f.reading.resolve(Float32Array.of(0)); await expect(result).rejects.toBe(error);
});

it('waits for validation after a read error and preserves validation-error precedence', async () => {
  const f = fixture(), result = f.session.readValidatedOutputs(f.batch, f.outputs), error = new RangeError('Bad GPU index');
  let settled = false; void result.then(() => { settled = true; }, () => { settled = true; });
  f.reading.reject(new Error('Read failed')); await tick(); expect(settled).toBe(false);
  f.validation.reject(error); await expect(result).rejects.toBe(error);
});

it('propagates an output read failure after successful validation', async () => {
  const f = fixture(), result = f.session.readValidatedOutputs(f.batch, f.outputs), error = new Error('Read failed');
  const rejected = expect(result).rejects.toBe(error);
  f.reading.reject(error); f.validation.resolve(); await rejected;
});

it('keeps direct output reads validated and rejects mismatched output types', async () => {
  const f = fixture(), result = f.session.readOutputs(f.outputs);
  expect(f.engine.read).toHaveBeenCalledWith(f.tensor, { validate: true });
  f.reading.resolve(Float32Array.of(7)); expect([...(await result).y.data]).toEqual([7]);
  await expect(f.session.readValidatedOutputs({ validate: async () => {} }, new Map([['y', { cpu: true, dataType: 7, data: [7], shape: [1] }]]))).rejects.toThrow('declared');
});
