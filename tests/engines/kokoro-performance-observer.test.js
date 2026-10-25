import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { WebGpuCompute } from '../../src/engines/webgpu-compute.js';
import { WasmKokoroCompute } from '../../src/engines/kokoro-cpu-compute.js';
import { observeKokoroEngine, kokoroPerformanceSnapshot } from '../../scripts/lib/kokoro-performance-worker.mjs';

it('observes the actual GPU buffer API, preserving size/usage/label, existing buffers and thrown limits', async () => {
  vi.stubGlobal('GPUBufferUsage', { STORAGE: 128 });
  const createBuffer = vi.fn(options => ({ ...options, destroy() {} }));
  const device = { createBuffer, limits: { maxBufferSize: 1024, maxStorageBufferBindingSize: 512 },
    addEventListener() {}, removeEventListener() {}, queue: { onSubmittedWorkDone: async () => {} }, lost: new Promise(() => {}) };
  const engine = new WebGpuCompute(device, false);
  engine.buffer(4, 128, 'existing'); observeKokoroEngine(engine);
  expect(kokoroPerformanceSnapshot().engines.at(-1)).toMatchObject({ peakLiveBufferBytes: 4, deviceLost: null, completionError: null });
  const result = engine.buffer(9, 128, 'observed');
  expect(createBuffer).toHaveBeenLastCalledWith({ size: 12, usage: 128, label: 'observed' });
  expect(result).toBe(createBuffer.mock.results.at(-1).value);
  expect(kokoroPerformanceSnapshot().engines.at(-1)).toMatchObject({ peakLiveBufferBytes: 16, peakArenaBytes: null, allocations: 1 });
  expect(() => engine.buffer(513, 128, 'invalid')).toThrow('limit');
  await engine.dispose();
  expect(kokoroPerformanceSnapshot().engines.at(-1)).toMatchObject({ closed: true, remainingBuffers: 0, remainingTensors: 0 });
  engine.completionError = new Error('Late queue failure');
  expect(kokoroPerformanceSnapshot().engines.at(-1).completionError).toMatchObject({ name: 'Error', message: 'Late queue failure' });
  engine.lost = { reason: 'destroyed', message: 'Intentional close' };
  expect(kokoroPerformanceSnapshot().engines.at(-1)).toMatchObject({ deviceLost: engine.lost, unexpectedDeviceLoss: false });
  engine.lost = { reason: 'unknown', message: 'Driver reset' };
  expect(kokoroPerformanceSnapshot().engines.at(-1)).toMatchObject({ deviceLost: engine.lost, unexpectedDeviceLoss: true });
});

it('observes actual WASM aligned allocations and growth without changing arena ownership or cleanup', async () => {
  const engine = await WasmKokoroCompute.create(readFileSync('public/native/kokoro-engine.wasm'));
  const old = engine.allocate(17); observeKokoroEngine(engine);
  const block = engine.allocate(131073);
  expect(block.size).toBe(131088);
  const metrics = kokoroPerformanceSnapshot().engines.at(-1);
  expect(metrics.peakLiveBufferBytes).toBe(old.size + block.size);
  expect(metrics.peakArenaBytes).toBe(engine.memory.buffer.byteLength);
  engine.freeBuffer(old); engine.freeBuffer(block); await engine.dispose();
  expect(kokoroPerformanceSnapshot().engines.at(-1)).toMatchObject({ nativeMemoryReleased: true, remainingBuffers: 0 });
});
