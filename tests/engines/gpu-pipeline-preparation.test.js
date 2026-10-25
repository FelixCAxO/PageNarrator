import { expect, it, vi } from 'vitest';
import { WebGpuCompute } from '../../src/engines/webgpu-compute.js';

it('shares pipeline preparation across sessions and compiles independent typed pipelines concurrently', async () => {
  const device = { features: new Set(['shader-f16']), addEventListener() {}, lost: new Promise(() => {}) };
  const engine = new WebGpuCompute(device, false);
  let active = 0, peak = 0;
  engine.pipeline = vi.fn(async (_code, label) => {
    const typed = /PageNarrator (float32|float16|int32|bool) /.test(label);
    if (typed) { active++; peak = Math.max(peak, active); }
    await new Promise(resolve => setTimeout(resolve, 0));
    if (typed) active--;
    return label;
  });
  const first = engine.prepareCnn();
  expect(engine.prepareCnn()).toBe(first);
  await first;
  const count = engine.pipeline.mock.calls.length;
  await engine.prepareCnn();
  expect(engine.pipeline).toHaveBeenCalledTimes(count);
  expect(peak).toBeGreaterThan(1);
  expect(engine.typed['fill:float16']).toBe('PageNarrator float16 fill');
  expect(engine.typed['cast:float16:float32']).toBe('PageNarrator float16 to float32');
  expect(engine.half.checkedGatherTensor).toBeTruthy();
});

it('propagates shared pipeline compilation failures instead of publishing readiness', async () => {
  const engine = new WebGpuCompute({ features: new Set(), addEventListener() {}, lost: new Promise(() => {}) }, false);
  engine.pipeline = vi.fn(async () => { throw new Error('Compilation failed'); });
  const first = engine.prepareCnn();
  await expect(first).rejects.toThrow('Compilation failed');
  expect(engine.prepareCnn()).toBe(first);
  await expect(engine.prepareCnn()).rejects.toThrow('Compilation failed');
});
