// Controlled CPU load for contention lanes: N worker threads, each busy for
// dutyCycle of every period. Run as its own process so the probe can start,
// measure and stop it; its consumed CPU time is reported on exit.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

export const LOAD_GENERATOR_PATH = fileURLToPath(import.meta.url);

/**
 * @param {{ threads: number, dutyCycle: number, periodMs?: number }} spec
 */
export function normalizeLoadSpec({ threads, dutyCycle, periodMs = 100 } = /** @type {any} */ ({})) {
  const count = Number(threads);
  const duty = Number(dutyCycle);
  if (!Number.isInteger(count) || count < 1 || count > 256) throw new Error('threads must be an integer from 1 to 256.');
  if (!Number.isFinite(duty) || duty <= 0 || duty > 1) throw new Error('dutyCycle must be within (0, 1].');
  return { threads: count, dutyCycle: duty, periodMs: Math.max(10, Math.trunc(Number(periodMs) || 100)) };
}

/**
 * Starts the generator in a child process. stop() resolves with its report.
 * @param {{ threads: number, dutyCycle: number, periodMs?: number }} spec
 */
export async function startLoadGenerator(spec, { spawnFn = spawn } = {}) {
  const normalized = normalizeLoadSpec(spec);
  const child = spawnFn(process.execPath, [LOAD_GENERATOR_PATH, JSON.stringify(normalized)], { stdio: ['pipe', 'pipe', 'inherit'] });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  await new Promise((resolve, reject) => {
    const onData = () => {
      if (output.includes('started')) {
        child.stdout.off('data', onData);
        resolve();
      }
    };
    child.stdout.on('data', onData);
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`Load generator exited early (${code}).`)));
  });
  const startedAt = Date.now();
  return {
    pid: child.pid,
    spec: normalized,
    async stop() {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.stdin.end('stop\n');
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
      if (child.exitCode === null) child.kill();
      const line = output.split(/\r?\n/).find((entry) => entry.startsWith('{'));
      const report = line ? JSON.parse(line) : null;
      return {
        ...normalized,
        wallMs: Date.now() - startedAt,
        cpuSeconds: report?.cpuSeconds ?? null,
        achievedBusyThreads: report?.cpuSeconds && report?.wallSeconds ? report.cpuSeconds / report.wallSeconds : null,
      };
    },
  };
}

function busyWorker({ dutyCycle, periodMs }) {
  let stopped = false;
  parentPort.on('message', () => {
    stopped = true;
  });
  const tick = () => {
    if (stopped) {
      parentPort.close();
      return;
    }
    const busyUntil = Date.now() + (dutyCycle * periodMs);
    let sink = 0;
    while (Date.now() < busyUntil) sink += Math.sqrt(sink + 1);
    setTimeout(tick, Math.max(0, (1 - dutyCycle) * periodMs));
    return sink;
  };
  tick();
}

async function main() {
  const spec = normalizeLoadSpec(JSON.parse(process.argv[2] || '{}'));
  const workers = Array.from({ length: spec.threads }, () => new Worker(LOAD_GENERATOR_PATH, { workerData: spec }));
  const started = Date.now();
  const cpuBefore = process.cpuUsage();
  process.stdout.write('started\n');
  await new Promise((resolve) => {
    process.stdin.on('data', resolve);
    process.stdin.on('end', resolve);
  });
  for (const worker of workers) worker.postMessage('stop');
  await Promise.all(workers.map((worker) => new Promise((resolve) => worker.once('exit', resolve))));
  const cpu = process.cpuUsage(cpuBefore);
  process.stdout.write(`${JSON.stringify({ cpuSeconds: (cpu.user + cpu.system) / 1e6, wallSeconds: (Date.now() - started) / 1000 })}\n`);
}

if (!isMainThread) {
  busyWorker(workerData);
} else if (process.argv[1] && path.resolve(process.argv[1]) === LOAD_GENERATOR_PATH) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
