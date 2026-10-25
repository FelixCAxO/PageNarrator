import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { computeJobCpuUsage } from '../../scripts/weak-hardware/windows-job.mjs';

const CALIBRATION_HTML = '<!doctype html><title>CPU calibration</title><p>calibration</p>';

// One busy worker per host logical processor for durationMs; the job's CPU
// accounting over that window shows how many processors the browser could use.
const CALIBRATION_EXPRESSION = (workers, durationMs) => `(async () => {
  const source = 'onmessage = (event) => { const end = performance.now() + event.data; let n = 0; while (performance.now() < end) n += 1; postMessage(n); };';
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  const pool = Array.from({ length: ${workers} }, () => new Worker(url));
  const counts = await Promise.all(pool.map((worker) => new Promise((resolve) => {
    worker.onmessage = (event) => resolve(event.data);
    worker.postMessage(${durationMs});
  })));
  pool.forEach((worker) => worker.terminate());
  URL.revokeObjectURL(url);
  return counts.reduce((total, count) => total + count, 0);
})()`;

/**
 * Runs the calibration in a throwaway page of the supervised browser.
 * @param {{ cdp: any, browser: any, workers: number, durationMs?: number }} options
 */
export async function runCpuCalibration({ cdp, browser, workers, durationMs = 2_500 }) {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(CALIBRATION_HTML);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  let targetId = null;
  try {
    ({ targetId } = await cdp.send('Target.createTarget', { url: `http://127.0.0.1:${address.port}/calibrate.html` }));
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Runtime.enable', {}, sessionId);
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const ready = await cdp.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }, sessionId);
      if (ready.result.value === 'complete') break;
      await delay(100);
    }
    const before = await browser.queryEnforcement();
    const started = Date.now();
    const result = await cdp.send('Runtime.evaluate', {
      expression: CALIBRATION_EXPRESSION(workers, durationMs),
      awaitPromise: true,
      returnByValue: true,
    }, sessionId, { timeoutMs: durationMs + 60_000 });
    const wallMs = Date.now() - started;
    const after = await browser.queryEnforcement();
    const cpu = computeJobCpuUsage(before?.accounting, after?.accounting);
    const iterations = Number(result.result?.value);
    return {
      method: `${workers} busy workers for ${durationMs} ms in a test-browser page`,
      workers,
      durationMs,
      wallMs,
      iterations: Number.isFinite(iterations) ? iterations : null,
      iterationsPerSecond: Number.isFinite(iterations) && wallMs > 0 ? iterations / (wallMs / 1000) : null,
      busyLogicalProcessors: cpu.busyLogicalProcessors,
      jobCpuSeconds: cpu.cpuSeconds,
    };
  } catch (error) {
    return { method: 'busy-worker calibration', error: error.message, busyLogicalProcessors: null };
  } finally {
    if (targetId) await cdp.send('Target.closeTarget', { targetId }).catch(() => null);
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}
