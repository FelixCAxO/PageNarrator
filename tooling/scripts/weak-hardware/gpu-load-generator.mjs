// Controlled GPU load for contention lanes: a separate small Chromium window
// (outside the test browser's job) submits WebGPU compute work for dutyCycle
// of every period. Headless Chromium exposes no WebGPU adapter on this host,
// so the window is headed. The report states the work actually achieved.
import { createServer } from 'node:http';
import { chromium } from '@playwright/test';

/**
 * @param {{ dutyCycle: number, periodMs?: number, adapterLuid?: string|null }} spec
 */
export function normalizeGpuLoadSpec({ dutyCycle, periodMs = 200, adapterLuid = null } = /** @type {any} */ ({})) {
  const duty = Number(dutyCycle);
  if (!Number.isFinite(duty) || duty <= 0 || duty > 1) throw new Error('dutyCycle must be within (0, 1].');
  if (adapterLuid !== null && !/^\d+,\d+$/.test(String(adapterLuid))) throw new Error('adapterLuid must be "<high>,<low>" in decimal.');
  return { dutyCycle: duty, periodMs: Math.max(20, Math.trunc(Number(periodMs) || 200)), adapterLuid };
}

// Runs in the load page. Each busy phase submits compute passes back to back.
const LOAD_SOURCE = `(async (spec) => {
  const state = { stop: false, dispatches: 0, busyMs: 0, startedAt: performance.now(), adapter: null, error: null };
  globalThis.__pnGpuLoad = state;
  try {
    const adapter = await navigator.gpu.requestAdapter();
    state.adapter = adapter ? { vendor: adapter.info.vendor, architecture: adapter.info.architecture } : null;
    const device = await adapter.requestDevice();
    const module = device.createShaderModule({ code: \`@group(0) @binding(0) var<storage, read_write> data: array<f32>;
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  var x = data[id.x];
  for (var i = 0u; i < 4096u; i++) { x = sin(x) * 1.0001 + cos(x); }
  data[id.x] = x;
}\` });
    const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
    const buffer = device.createBuffer({ size: 4 * 1024 * 1024, usage: GPUBufferUsage.STORAGE });
    const bindGroup = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer } }] });
    while (!state.stop) {
      const busyStart = performance.now();
      while (!state.stop && performance.now() - busyStart < spec.dutyCycle * spec.periodMs) {
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(4096);
        pass.end();
        device.queue.submit([encoder.finish()]);
        await device.queue.onSubmittedWorkDone();
        state.dispatches += 1;
      }
      state.busyMs += performance.now() - busyStart;
      const idle = (1 - spec.dutyCycle) * spec.periodMs;
      if (idle > 0) await new Promise((resolve) => setTimeout(resolve, idle));
    }
    device.destroy();
  } catch (error) {
    state.error = String(error?.message || error);
  }
})`;

/**
 * Starts the GPU load. stop() resolves with what was achieved.
 * @param {{ dutyCycle: number, periodMs?: number, adapterLuid?: string|null }} spec
 */
export async function startGpuLoadGenerator(spec, { launch = (options) => chromium.launch(options) } = {}) {
  const normalized = normalizeGpuLoadSpec(spec);
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end('<!doctype html><title>PageNarrator GPU load</title>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const browser = await launch({
    headless: false,
    args: [
      '--window-size=240,160',
      '--window-position=0,0',
      '--disable-backgrounding-occluded-windows',
      ...(normalized.adapterLuid ? [`--use-adapter-luid=${normalized.adapterLuid}`] : []),
    ],
  });
  const startedAt = Date.now();
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    // Start the loop without awaiting it: its promise only settles at stop().
    await page.evaluate(`void ${LOAD_SOURCE}(${JSON.stringify(normalized)})`);
    const ready = await page.waitForFunction(() => globalThis.__pnGpuLoad && (globalThis.__pnGpuLoad.dispatches > 0 || globalThis.__pnGpuLoad.error), null, { timeout: 30_000 })
      .then(() => page.evaluate(() => globalThis.__pnGpuLoad.error));
    if (ready) throw new Error(`GPU load did not start: ${ready}`);
    return {
      spec: normalized,
      async stop() {
        const state = await page.evaluate(() => {
          globalThis.__pnGpuLoad.stop = true;
          return { ...globalThis.__pnGpuLoad };
        }).catch((error) => ({ error: error.message }));
        await browser.close().catch(() => null);
        server.close();
        const wallMs = Date.now() - startedAt;
        return {
          ...normalized,
          wallMs,
          adapter: state.adapter ?? null,
          dispatches: state.dispatches ?? null,
          achievedBusyFraction: Number.isFinite(state.busyMs) && wallMs > 0 ? state.busyMs / wallMs : null,
          error: state.error ?? null,
        };
      },
    };
  } catch (error) {
    await browser.close().catch(() => null);
    server.close();
    throw error;
  }
}
