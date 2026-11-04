import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';

export const JOB_SUPERVISOR_SOURCE = path.resolve(import.meta.dirname, 'windows-job-supervisor.cs');
const SUPERVISOR_READY_TIMEOUT_MS = 60_000;
const COMMAND_TIMEOUT_MS = 60_000;

export function isJobSupervisorSupported(platform = process.platform) {
  return platform === 'win32';
}

/**
 * Converts a profile's enforced constraints into supervisor job limits.
 * @param {Record<string, any>} [enforced]
 * @param {{ resolvedAffinity?: { mask?: string }|null }} [resolution]
 */
export function buildJobLimits(enforced = {}, { resolvedAffinity = null } = {}) {
  const limits = {};
  if (enforced.cpuAffinity) {
    if (!resolvedAffinity?.mask) throw new Error('cpuAffinity must be resolved against the host topology before launch.');
    limits.affinityMask = String(resolvedAffinity.mask);
  }
  if (enforced.cpuRate?.hundredthsPercent) limits.cpuRateHundredthsPercent = String(enforced.cpuRate.hundredthsPercent);
  if (enforced.browserCommit?.bytes) limits.jobMemoryBytes = String(enforced.browserCommit.bytes);
  return limits;
}

export function createSupervisorCommand({ sourcePath = JOB_SUPERVISOR_SOURCE } = {}) {
  const escaped = sourcePath.replaceAll("'", "''");
  return {
    command: 'powershell.exe',
    args: [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `$ErrorActionPreference='Stop'; Add-Type -Path '${escaped}' -ReferencedAssemblies System.Management,System.Web.Extensions; [PageNarrator.WeakHardware.JobSupervisor]::Run()`,
    ],
  };
}

/**
 * Starts the job supervisor. Closing it (or this Node process exiting) closes
 * the job handle and terminates every process in the supervised browser tree.
 * @param {{ spawnFn?: typeof spawn, sourcePath?: string, commandTimeoutMs?: number }} [options]
 */
export async function startJobSupervisor({
  spawnFn = spawn,
  sourcePath = JOB_SUPERVISOR_SOURCE,
  commandTimeoutMs = COMMAND_TIMEOUT_MS,
} = {}) {
  if (!isJobSupervisorSupported()) throw new Error('The job supervisor requires Windows.');
  const { command, args } = createSupervisorCommand({ sourcePath });
  const child = spawnFn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const stderr = [];
  child.stderr?.on('data', (chunk) => {
    stderr.push(String(chunk));
    if (stderr.length > 50) stderr.shift();
  });
  const lines = readline.createInterface({ input: child.stdout });
  const waiters = [];
  let exited = false;
  let nextId = 1;
  lines.on('line', (line) => {
    const waiter = waiters.shift();
    if (!waiter) return;
    clearTimeout(waiter.timer);
    try {
      waiter.resolve(JSON.parse(line));
    } catch (error) {
      waiter.reject(new Error(`Supervisor sent invalid JSON: ${line.slice(0, 200)} (${error.message})`));
    }
  });
  const exitPromise = new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      exited = true;
      for (const waiter of waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error(`Job supervisor exited (${code ?? signal}): ${stderr.join('').trim().slice(-800)}`));
      }
      resolve({ code, signal });
    });
  });
  child.once('error', (error) => {
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  });
  const killOnExit = () => {
    if (!exited) child.kill();
  };
  process.once('exit', killOnExit);

  function nextResponse(timeoutMs, label) {
    return new Promise((resolve, reject) => {
      if (exited) {
        reject(new Error(`Job supervisor is not running (${label}).`));
        return;
      }
      const timer = setTimeout(() => {
        const index = waiters.findIndex((waiter) => waiter.timer === timer);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error(`Job supervisor did not answer ${label} within ${timeoutMs} ms.`));
      }, timeoutMs);
      waiters.push({ resolve, reject, timer });
    });
  }

  async function send(payload, timeoutMs = commandTimeoutMs) {
    const id = nextId;
    nextId += 1;
    const response = nextResponse(timeoutMs, payload.cmd);
    child.stdin.write(`${JSON.stringify({ ...payload, id })}\n`);
    const result = await response;
    if (result?.ok !== true) throw new Error(`Job supervisor ${payload.cmd} failed: ${result?.error || 'unknown error'}`);
    return result;
  }

  const ready = await nextResponse(SUPERVISOR_READY_TIMEOUT_MS, 'startup');
  if (ready?.kind !== 'ready') throw new Error('Job supervisor did not report ready.');

  return {
    pid: child.pid,
    /** @param {{ exe: string, args: string[], cwd?: string, limits?: Record<string, string> }} options */
    launch: ({ exe, args: browserArgs, cwd, limits = {} }) => send({ cmd: 'launch', exe, args: browserArgs, cwd, limits }),
    /** @param {{ matchCommandLine?: string }} [options] */
    query: ({ matchCommandLine } = {}) => send({ cmd: 'query', matchCommandLine }),
    adapters: () => send({ cmd: 'adapters' }),
    topology: () => send({ cmd: 'topology' }),
    gpuSample: () => send({ cmd: 'gpu-sample' }),
    async terminate() {
      if (exited) return { ok: true, kind: 'already-exited' };
      const result = await send({ cmd: 'terminate' }).catch((error) => ({ ok: false, error: error.message }));
      await Promise.race([exitPromise, new Promise((resolve) => setTimeout(resolve, 5_000))]);
      if (!exited) child.kill();
      process.off('exit', killOnExit);
      return result;
    },
    exited: () => exited,
    stderr: () => stderr.join(''),
  };
}

/**
 * Summarizes one supervisor query into the enforcement observation used by
 * assessRunEnvironment(): every browser process, job membership and limits.
 * @param {any} query
 */
export function summarizeJobEnforcement(query) {
  if (!query?.ok) {
    return { supported: false, adapter: null, processes: [], limits: null, error: query?.error || 'no supervisor query' };
  }
  const processes = (query.browserProcesses || []).map((process) => ({
    pid: process.pid,
    name: process.name || null,
    parentPid: process.parentPid ?? null,
    commandLineMatched: process.commandLineMatched === true,
    inJob: process.inJob === true,
    listedInJob: process.listedInJob === true,
    affinityMask: process.affinityMask ?? null,
    privateBytes: toNumberOrNull(process.privateBytes),
    workingSetBytes: toNumberOrNull(process.workingSetBytes),
    peakWorkingSetBytes: toNumberOrNull(process.peakWorkingSetBytes),
    openError: process.openError ?? null,
  }));
  return {
    supported: true,
    adapter: 'windows-job',
    rootPid: query.rootPid,
    processes,
    limits: query.limits || null,
    accounting: query.accounting || null,
    totals: {
      processCount: processes.length,
      privateBytes: sumOrNull(processes.map((process) => process.privateBytes)),
      workingSetBytes: sumOrNull(processes.map((process) => process.workingSetBytes)),
      peakJobCommitBytes: toNumberOrNull(query.limits?.peakJobMemoryUsedBytes),
    },
  };
}

/**
 * CPU seconds consumed by the job between two accounting snapshots, divided by
 * wall seconds: the number of logical processors the browser kept busy.
 * @param {any} before
 * @param {any} after
 */
export function computeJobCpuUsage(before, after) {
  const cpu100ns = (snapshot) => {
    const user = counter100ns(snapshot?.totalUserTime100ns);
    const kernel = counter100ns(snapshot?.totalKernelTime100ns);
    return user === null || kernel === null ? null : user + kernel;
  };
  const start = Date.parse(before?.queriedAtUtc);
  const end = Date.parse(after?.queriedAtUtc);
  const beforeCpu = cpu100ns(before);
  const afterCpu = cpu100ns(after);
  const cpuDelta = beforeCpu !== null && afterCpu !== null ? afterCpu - beforeCpu : null;
  const cpuSeconds = cpuDelta !== null && cpuDelta >= 0n && cpuDelta <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(cpuDelta) / 1e7 : NaN;
  const wallSeconds = (end - start) / 1000;
  if (!Number.isFinite(cpuSeconds) || !Number.isFinite(wallSeconds) || wallSeconds <= 0) {
    return { cpuSeconds: null, wallSeconds: null, busyLogicalProcessors: null };
  }
  return { cpuSeconds, wallSeconds, busyLogicalProcessors: cpuSeconds / wallSeconds };
}

/**
 * Per-adapter GPU engine utilization between two gpu-sample snapshots.
 * @param {any} before
 * @param {any} after
 */
export function computeGpuEngineUsage(before, after) {
  const rawSnapshots = { before, after };
  const unavailableAdapters = new Map();
  const adapterFailures = () => [...unavailableAdapters].map(([luid, reason]) => ({ luid, reason }));
  const unavailable = (reason) => ({ available: false, reason, adapters: [], unavailableAdapters: adapterFailures(), rawSnapshots });
  const start = counter100ns(before?.timestamp100ns);
  const end = counter100ns(after?.timestamp100ns);
  if (start === null || end === null || end <= start || end - start > BigInt(Number.MAX_SAFE_INTEGER)) {
    return unavailable(after?.enginesError || before?.enginesError || 'GPU engine sample interval unavailable');
  }
  if (before?.engineInstancesComplete !== true || after?.engineInstancesComplete !== true
    || !Array.isArray(before.engineInstances) || !Array.isArray(after.engineInstances)) {
    return unavailable(after?.enginesError || before?.enginesError || 'Complete per-instance GPU engine coverage unavailable');
  }
  const parsedBefore = gpuInstances(before.engineInstances);
  const parsedAfter = gpuInstances(after.engineInstances);
  if (!parsedBefore || !parsedAfter) return unavailable('GPU engine instance adapter identity unavailable');
  const previous = parsedBefore.instances;
  const current = parsedAfter.instances;
  for (const parsed of [parsedBefore, parsedAfter]) {
    for (const [luid, reason] of parsed.unavailableAdapters) unavailableAdapters.set(luid, reason);
  }
  for (const [name, prior] of previous) {
    if (!current.has(name)) unavailableAdapters.set(prior.luid, 'GPU engine instance disappeared during the measurement');
  }
  const wall100ns = Number(end - start);
  const deltas = new Map();
  for (const [name, engine] of current) {
    const prior = previous.get(name);
    if (prior && (engine.pid !== prior.pid || engine.luid !== prior.luid || engine.engineId !== prior.engineId
      || engine.engineType !== prior.engineType || engine.isJob !== prior.isJob)) {
      unavailableAdapters.set(prior.luid, 'GPU engine instance identity or job membership changed');
      unavailableAdapters.set(engine.luid, 'GPU engine instance identity or job membership changed');
    }
    if (unavailableAdapters.has(engine.luid)) continue;
    // A complete before-category enumeration proves a new instance was absent.
    // Its cumulative counter can then start at zero; partial snapshots cannot.
    const delta = engine.counter - (prior?.counter ?? 0n);
    if (delta < 0n || delta > BigInt(Number.MAX_SAFE_INTEGER)) {
      unavailableAdapters.set(engine.luid, 'GPU engine counter reset or invalid delta');
      continue;
    }
    const key = `${engine.luid}|${engine.engineId}`;
    if (!deltas.has(key)) deltas.set(key, { luid: engine.luid, engineId: engine.engineId, engineType: engine.engineType, job: 0, foreign: 0 });
    deltas.get(key)[engine.isJob ? 'job' : 'foreign'] += Number(delta) / wall100ns;
  }
  const byLuid = new Map();
  for (const engine of deltas.values()) {
    if (unavailableAdapters.has(engine.luid)) continue;
    if (!byLuid.has(engine.luid)) byLuid.set(engine.luid, { luid: engine.luid, engines: [] });
    byLuid.get(engine.luid).engines.push({ engineId: engine.engineId, engineType: engine.engineType, jobUtilization: engine.job, foreignUtilization: engine.foreign });
  }
  const memory = new Map((after.memory || []).map((entry) => [entry.luid, entry]));
  const adapters = [...byLuid.values()].map((adapter) => {
    const busiest = (key) => Math.max(0, ...adapter.engines.map((engine) => engine[key]));
    const mem = memory.get(adapter.luid);
    return {
      luid: adapter.luid,
      jobMaxEngineUtilization: busiest('jobUtilization'),
      foreignMaxEngineUtilization: busiest('foreignUtilization'),
      jobDedicatedBytes: toNumberOrNull(mem?.jobDedicatedBytes),
      jobSharedBytes: toNumberOrNull(mem?.jobSharedBytes),
      engines: adapter.engines.filter((engine) => engine.jobUtilization > 0 || engine.foreignUtilization > 0),
    };
  });
  if (!adapters.length && unavailableAdapters.size) return unavailable('No adapter has complete valid GPU engine counters');
  return { available: true, wallSeconds: wall100ns / 1e7, adapters, unavailableAdapters: adapterFailures(), rawSnapshots };
}

function counter100ns(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  if (typeof value !== 'string' || !/^\d{1,19}$/.test(value)) return null;
  const counter = BigInt(value);
  return counter <= 9223372036854775807n ? counter : null;
}

// GPU engine running time is a signed raw value; NVIDIA reports some foreign
// instances (e.g. dwm) from a negative base. Only deltas are used, and a
// negative delta still marks the adapter unavailable.
function engineCounter100ns(value) {
  if (typeof value === 'string' && /^-\d{1,19}$/.test(value)) {
    const counter = BigInt(value);
    return counter >= -9223372036854775808n ? counter : null;
  }
  return counter100ns(value);
}

function gpuInstances(rows) {
  const instances = new Map();
  const unavailableAdapters = new Map();
  for (const row of rows) {
    if (!row || typeof row.luid !== 'string' || !row.luid) return null;
    const counter = engineCounter100ns(row?.runningTime100ns);
    if (!row || typeof row.instanceName !== 'string' || !row.instanceName || instances.has(row.instanceName)
      || !Number.isSafeInteger(row.pid) || row.pid < 0 || typeof row.isJob !== 'boolean'
      || typeof row.engineType !== 'string'
      || typeof row.engineId !== 'string' || !/^phys_\d+_eng_\d+$/.test(row.engineId)
      || counter === null) {
      unavailableAdapters.set(row.luid, 'Invalid or duplicate GPU engine instance counter or identity');
      const duplicate = instances.get(row.instanceName);
      if (duplicate) unavailableAdapters.set(duplicate.luid, 'Duplicate GPU engine instance identity');
    }
    if (typeof row.instanceName !== 'string' || !row.instanceName) continue;
    instances.set(row.instanceName, { ...row, counter });
  }
  return { instances, unavailableAdapters };
}

/** Formats a DXGI adapter LUID the way Chrome's --use-adapter-luid expects (decimal "high,low"). */
export function formatChromeAdapterLuid(adapter) {
  return `${Number(adapter.luidHigh)},${Number(adapter.luidLow)}`;
}

/** Formats a DXGI adapter LUID the way GPU performance counters name it. */
export function formatCounterAdapterLuid(adapter) {
  const hex = (value) => `0x${(Number(value) >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
  return `${hex(adapter.luidHigh)}_${hex(adapter.luidLow)}`;
}

const PCI_VENDORS = Object.freeze({ 0x10de: 'nvidia', 0x8086: 'intel', 0x1002: 'amd', 0x1022: 'amd', 0x1414: 'microsoft', 0x5143: 'qualcomm' });

export function vendorNameForId(vendorId) {
  return PCI_VENDORS[Number(vendorId)] || null;
}

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sumOrNull(values) {
  const finite = values.filter((value) => Number.isFinite(value));
  return finite.length ? finite.reduce((total, value) => total + value, 0) : null;
}
