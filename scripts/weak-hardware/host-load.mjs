import { execFile, spawnSync } from 'node:child_process';
import os from 'node:os';
import { CONTAMINATION_THRESHOLDS } from './evidence-contract.mjs';

/** Sums idle and total CPU ticks across logical processors. */
export function readCpuTicks(cpus = os.cpus()) {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    const times = cpu.times;
    idle += times.idle;
    total += times.user + times.nice + times.sys + times.idle + times.irq;
  }
  return { idle, total, logicalProcessors: cpus.length };
}

/** Fraction of host CPU capacity that was busy between two tick snapshots. */
export function computeBusyFraction(before, after) {
  const total = after.total - before.total;
  const idle = after.idle - before.idle;
  if (!Number.isFinite(total) || total <= 0) return null;
  return Math.min(1, Math.max(0, (total - idle) / total));
}

/**
 * Reads NVIDIA device utilization. Other vendors report unavailable here; the
 * Windows job supervisor's GPU engine counters cover every adapter.
 * @param {{ run?: typeof spawnSync }} [options]
 */
export function sampleNvidiaGpus({ run = spawnSync } = {}) {
  const result = run('nvidia-smi', [
    '--query-gpu=name,utilization.gpu,memory.used,memory.total',
    '--format=csv,noheader,nounits',
  ], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  if (result.error || result.status !== 0) {
    return { available: false, reason: result.error?.message || `nvidia-smi exited ${result.status}`, gpus: [] };
  }
  const gpus = String(result.stdout || '').split(/\r?\n/).filter(Boolean).map((line) => {
    const [name, utilization, memoryUsed, memoryTotal] = line.split(',').map((part) => part.trim());
    return {
      name,
      utilizationPercent: toNumberOrNull(utilization),
      memoryUsedMiB: toNumberOrNull(memoryUsed),
      memoryTotalMiB: toNumberOrNull(memoryTotal),
    };
  });
  return { available: true, gpus };
}

/**
 * Top CPU consumers over a window (Windows only), so contamination can be
 * attributed to named processes instead of an anonymous percentage.
 * @param {{ windowMs?: number, limit?: number, logicalProcessors?: number, run?: typeof execFile }} [options]
 */
export function sampleTopProcesses({ windowMs = 3000, limit = 8, logicalProcessors = os.cpus().length, run = execFile } = {}) {
  if (process.platform !== 'win32') return Promise.resolve({ available: false, reason: 'implemented for Windows only', processes: [] });
  const snapshot = "Get-Process | ForEach-Object { '{0}|{1}|{2}' -f $_.Id, $_.ProcessName, $(if ($_.TotalProcessorTime) { $_.TotalProcessorTime.TotalMilliseconds } else { '' }) }";
  const script = `$a = @(${snapshot}); Start-Sleep -Milliseconds ${Math.max(100, Math.trunc(windowMs))}; $b = @(${snapshot}); 'A'; $a; 'B'; $b`;
  return new Promise((resolve) => {
    run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: windowMs + 30_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        resolve({ available: false, reason: error.message, processes: [] });
        return;
      }
      resolve({ available: true, processes: parseTopProcesses(String(stdout), { windowMs, limit, logicalProcessors }) });
    });
  });
}

export function parseTopProcesses(output, { windowMs, limit = 8, logicalProcessors = 1 }) {
  const lines = output.split(/\r?\n/);
  const before = new Map();
  const after = new Map();
  let target = null;
  for (const line of lines) {
    if (line === 'A') target = before;
    else if (line === 'B') target = after;
    else if (target && line.includes('|')) {
      const [pid, name, cpuMs] = line.split('|');
      if (cpuMs !== '') target.set(pid, { name, cpuMs: Number(cpuMs.replace(',', '.')) });
    }
  }
  return [...after.entries()]
    .filter(([pid]) => before.has(pid))
    .map(([pid, entry]) => ({
      pid: Number(pid),
      name: entry.name,
      cpuFractionOfHost: Math.max(0, entry.cpuMs - before.get(pid).cpuMs) / (windowMs * logicalProcessors),
    }))
    .filter((entry) => entry.cpuFractionOfHost > 0)
    .sort((left, right) => right.cpuFractionOfHost - left.cpuFractionOfHost)
    .slice(0, limit);
}

/**
 * Samples host load over a window. "Own" CPU is this Node process plus any
 * supervised browser CPU reported by ownCpuSeconds(); the rest is foreign.
 * @param {{
 *   windowMs?: number,
 *   ownCpuSeconds?: () => Promise<number|null>,
 *   readTicks?: () => { idle: number, total: number, logicalProcessors: number },
 *   sampleGpus?: () => any,
 *   sleep?: (ms: number) => Promise<unknown>,
 *   now?: () => number,
 * }} [options]
 */
export async function sampleHostLoad({
  windowMs = 3000,
  ownCpuSeconds = async () => 0,
  readTicks = () => readCpuTicks(),
  sampleGpus = () => sampleNvidiaGpus(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
  topProcesses = null,
} = {}) {
  const startedAt = now();
  const ticksBefore = readTicks();
  const processBefore = process.cpuUsage();
  const ownBefore = await ownCpuSeconds();
  const top = topProcesses ? topProcesses({ windowMs }) : null;
  await sleep(windowMs);
  const topResult = top ? await top : null;
  const ticksAfter = readTicks();
  const processAfter = process.cpuUsage(processBefore);
  const ownAfter = await ownCpuSeconds();
  const elapsedSeconds = Math.max(0.001, (now() - startedAt) / 1000);
  const logicalProcessors = ticksAfter.logicalProcessors || null;
  const totalBusyFraction = computeBusyFraction(ticksBefore, ticksAfter);
  const nodeCpuSeconds = (processAfter.user + processAfter.system) / 1e6;
  const supervisedCpuSeconds = Number.isFinite(ownBefore) && Number.isFinite(ownAfter) ? Math.max(0, ownAfter - ownBefore) : null;
  const ownFraction = logicalProcessors
    ? (nodeCpuSeconds + (supervisedCpuSeconds || 0)) / (elapsedSeconds * logicalProcessors)
    : null;
  const foreignCpuFraction = totalBusyFraction === null || ownFraction === null
    ? null
    : Math.max(0, totalBusyFraction - ownFraction);
  const gpu = sampleGpus();
  const utilizations = (gpu.gpus || []).map((entry) => entry.utilizationPercent).filter(Number.isFinite);
  return {
    sampledAt: new Date(startedAt).toISOString(),
    windowMs,
    logicalProcessors,
    totalCpuBusyFraction: totalBusyFraction,
    ownCpuFraction: ownFraction,
    foreignCpuFraction,
    supervisedCpuSeconds,
    // Measured before the supervised browser starts, all device utilization is foreign.
    foreignGpuUtilizationPercent: utilizations.length ? Math.max(...utilizations) : null,
    gpus: gpu.gpus || [],
    gpuSource: gpu.available ? 'nvidia-smi' : null,
    gpuUnavailableReason: gpu.available ? null : gpu.reason,
    topProcesses: topResult?.processes || null,
    method: 'os.cpus() busy ticks minus this process and supervised browser CPU',
  };
}

/**
 * Waits (bounded) for foreign load to drop below the contamination thresholds.
 * Returns the last sample either way; callers record it and decide validity.
 * @param {{ maxWaitMs?: number, retryMs?: number, usesGpu?: boolean, sample?: () => Promise<any>, sleep?: (ms: number) => Promise<unknown>, now?: () => number, onBusy?: (sample: any) => void }} [options]
 */
export async function waitForQuietHost({
  maxWaitMs = 0,
  retryMs = 15_000,
  usesGpu = false,
  sample = () => sampleHostLoad(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
  onBusy = () => {},
} = {}) {
  const startedAt = now();
  const samples = [];
  for (;;) {
    const current = await sample();
    samples.push(current);
    const busy = isHostBusy(current, { usesGpu });
    if (!busy || now() - startedAt >= maxWaitMs) {
      return { quiet: !busy, waitedMs: now() - startedAt, attempts: samples.length, last: current };
    }
    onBusy(current);
    await sleep(retryMs);
  }
}

export function isHostBusy(sample, { usesGpu = false } = {}) {
  const raw = sample?.foreignCpuFraction;
  // An unmeasured host is not a quiet host (Number(null) would read as 0).
  if (raw === null || raw === undefined || raw === '') return true;
  const cpu = Number(raw);
  if (!Number.isFinite(cpu) || cpu >= CONTAMINATION_THRESHOLDS.foreignCpuFraction) return true;
  if (!usesGpu) return false;
  const gpu = sample?.foreignGpuUtilizationPercent;
  if (gpu === null || gpu === undefined || typeof gpu === 'string' && gpu.trim() === '') return true;
  return !Number.isFinite(Number(gpu)) || Number(gpu) >= CONTAMINATION_THRESHOLDS.foreignGpuUtilizationPercent;
}

function toNumberOrNull(value) {
  const number = Number(value);
  return value === '' || value === undefined || !Number.isFinite(number) ? null : number;
}
