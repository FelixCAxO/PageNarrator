import { afterEach, expect, it, vi } from 'vitest';
import { WebGpuCompute } from '../../src/engines/webgpu-compute.js';
import { HALF_SCALED_MASKED_SOFTMAX_SHADER } from '../../src/engines/webgpu-attention-shaders.js';

afterEach(() => vi.unstubAllGlobals());
function setup() {
  vi.stubGlobal('GPUBufferUsage', { STORAGE: 128, COPY_SRC: 4, COPY_DST: 8 });
  const engine = new WebGpuCompute({ addEventListener() {}, lost: new Promise(() => {}), features: new Set(['shader-f16']),
    limits: { maxBufferSize: 1e8, maxStorageBufferBindingSize: 1e8, maxComputeWorkgroupsPerDimension: 65535 },
    createCommandEncoder: () => ({}), createBuffer: ({ size }) => ({ size }) }, false);
  engine.half = { scaledMaskedSoftmax: 'fused', softmax: 'softmax' };
  const batch = engine.batch(); batch.dispatchTensors = vi.fn();
  return { engine, batch };
}
it('encodes one dispatch with a repeated mask and preserves input storage', () => {
  const { batch } = setup(), input = batch.output([1, 16, 259, 259], 'float16');
  const scale = batch.output([], 'float16'), mask = batch.output([1, 1, 259, 259], 'float16');
  const output = batch.scaledMaskedSoftmax(input, scale, mask);
  expect(output.buffer).not.toBe(input.buffer);
  expect(output.shape).toEqual(input.shape);
  expect(batch.dispatchTensors).toHaveBeenCalledExactlyOnceWith('fused', [input, scale, mask, output], Uint32Array.of(4144, 259, 4144, 67081), 4144, 1);
});
it.each([
  ['float16', [2, 16, 3, 17], [], [2, 1, 3, 17]],
  ['float16', [1, 16, 3, 17], [1], [1, 1, 3, 17]],
  ['float16', [1, 16, 3, 17], [], [1, 16, 3, 17]],
  ['float16', [1, 16, 3, 17], [], [1, 1, 1, 17]],
  ['float16', [1, 16, 3, 17], [], [1, 1, 3, 1]],
  ['float16', [3, 17], [], [3, 17]],
  ['float32', [1, 16, 3, 17], [], [1, 1, 3, 17]],
])('uses ordinary operations for %s %j, scale %j and mask %j', (type, shape, scaleShape, maskShape) => {
  const { batch } = setup(), input = batch.output(shape, type), scale = batch.output(scaleShape, type), mask = batch.output(maskShape, type);
  const output = batch.scaledMaskedSoftmax(input, scale, mask);
  expect(output.shape).toEqual(shape);
  expect(batch.dispatchTensors).toHaveBeenCalledTimes(3);
  expect(batch.dispatchTensors.mock.calls.some(call => call[0] === 'fused')).toBe(false);
  expect(batch.outputs.size).toBe(4);
});
it('rejects invalid broadcasting and an empty final axis without submitting work', () => {
  const { batch } = setup(), input = batch.output([1, 16, 3, 17], 'float16'), scale = batch.output([], 'float16');
  expect(() => batch.scaledMaskedSoftmax(input, scale, batch.output([2, 19], 'float16'))).toThrow(/broadcast/);
  const empty = batch.output([1, 16, 3, 0], 'float16');
  expect(() => batch.scaledMaskedSoftmax(empty, scale, batch.output([1, 1, 3, 0], 'float16'))).toThrow(/nonempty/);
  expect(() => batch.scaledMaskedSoftmax(empty, scale, batch.output([1, 1, 1, 1], 'float16'))).toThrow(/nonempty/);
  expect(batch.submitted).toBe(false);
});
it('keeps explicit half rounding and replaces all three softmax input reads', () => {
  expect(HALF_SCALED_MASKED_SOFTMAX_SHADER.match(/load_value\(row \* cfg\[1u\] \+ i\)/g)).toHaveLength(3);
  expect(HALF_SCALED_MASKED_SOFTMAX_SHADER).toContain('let scaled = f16(f32(src[index]) * f32(scale[0u]));');
  expect(HALF_SCALED_MASKED_SOFTMAX_SHADER).toContain('return f32(f16(f32(scaled) + f32(mask[index % cfg[3u]])));');
});

it.each([[1,16,3,17],[1,8,1,2],[1,1,259,259]])('uses one fused dispatch for a scalar 4-D mask, input %j', (...shape) => {
  const { batch } = setup(), input=batch.output(shape,'float16'),scale=batch.output([],'float16'),mask=batch.output([1,1,1,1],'float16');
  const output=batch.scaledMaskedSoftmax(input,scale,mask),rows=input.length/shape[3];
  expect(output.shape).toEqual(shape);
  expect(batch.dispatchTensors).toHaveBeenCalledExactlyOnceWith('fused',[input,scale,mask,output],Uint32Array.of(rows,shape[3],rows,1),rows,1);
});
