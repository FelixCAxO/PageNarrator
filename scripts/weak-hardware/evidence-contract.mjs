// Shared contract for weak-hardware probe profiles and results.
// A profile states what it changes and how; a run records what was observed.
// Nothing here can promote a run to physical-target evidence by itself.

export const RESULT_SCHEMA_VERSION = 2;
// Explicit read lifecycle and hash-verified warm caches; reload latency stays measured.
export const MEASUREMENT_CONTRACT_VERSION = 3;

export const EVIDENCE_CATEGORIES = Object.freeze({
  NATIVE_HOST: 'native-host',
  CAPABILITY_SIMULATION: 'capability-simulation',
  RESOURCE_CONSTRAINED_HOST: 'resource-constrained-host',
  VIRTUAL_MACHINE: 'virtual-machine',
  FAULT_INJECTION: 'fault-injection',
  PHYSICAL_TARGET: 'physical-target',
});

const KNOWN_CATEGORIES = new Set(Object.values(EVIDENCE_CATEGORIES));
const CORE_CLASSES = Object.freeze(['efficiency', 'performance', 'any']);
// Accounting granularity allowance before a peak counts as exceeding the ceiling.
const COMMIT_LIMIT_TOLERANCE = 0.01;
// Calibration allowance: scheduler and accounting jitter plus browser overhead.
const CALIBRATION_TOLERANCE = 0.15;
const CALIBRATION_OVERHEAD_PROCESSORS = 0.25;
// Win32 error from OpenProcess when the process no longer exists.
const ERROR_INVALID_PARAMETER = 87;

export const RUN_STATUS = Object.freeze({
  PASSED: 'passed',
  FAILED: 'failed',
  TIMEOUT: 'timeout',
  INVALID_ENVIRONMENT: 'invalid-environment',
  CRASHED: 'crashed',
  BLOCKED: 'blocked',
});

export const SCHEDULING_MODES = Object.freeze({
  ISOLATED: 'isolated',
  CONTENTION: 'contention',
});

// Predeclared contamination thresholds (fraction of host capacity used by other
// processes). Changing them changes what a measurement can establish.
export const CONTAMINATION_THRESHOLDS = Object.freeze({
  foreignCpuFraction: 0.25,
  foreignGpuUtilizationPercent: 25,
});

export const WEBGPU_EXPOSURE = Object.freeze({
  HOST: 'host',
  HIDDEN: 'hidden',
  NO_ADAPTER: 'no-adapter',
  SIMULATED_ADAPTER: 'simulated-adapter',
});

const GPU_MODE_EXPOSURE = Object.freeze({
  host: WEBGPU_EXPOSURE.HOST,
  none: WEBGPU_EXPOSURE.HIDDEN,
  'no-adapter': WEBGPU_EXPOSURE.NO_ADAPTER,
  'simulated-adapter': WEBGPU_EXPOSURE.SIMULATED_ADAPTER,
});

/**
 * Builds the evidence descriptor attached to every probe profile.
 * @param {{
 *   navigator?: Record<string, unknown>,
 *   disableWebGpu?: boolean,
 *   gpu?: Record<string, any>|null,
 *   enforced?: Record<string, any>,
 *   gpuAdapter?: { expectedVendor: string, description?: string }|null,
 *   injected?: Array<Record<string, any>>,
 *   native?: boolean,
 *   limitations?: string[],
 * }} options
 */
export function createProfileEvidence({
  navigator = {},
  disableWebGpu = false,
  gpu = null,
  enforced = {},
  gpuAdapter = null,
  injected = [],
  native = false,
  limitations = [],
} = {}) {
  const webgpu = disableWebGpu ? WEBGPU_EXPOSURE.HIDDEN : (GPU_MODE_EXPOSURE[gpu?.mode] || WEBGPU_EXPOSURE.HOST);
  const reported = {
    deviceMemoryGb: finiteOrNull(navigator.deviceMemory),
    hardwareConcurrency: finiteOrNull(navigator.hardwareConcurrency),
    webgpu,
    adapter: webgpu === WEBGPU_EXPOSURE.SIMULATED_ADAPTER
      ? { vendor: gpu?.vendor || null, architecture: gpu?.architecture || null, device: gpu?.device || null }
      : null,
    bufferLimits: gpu?.limits ? { ...gpu.limits } : null,
    vramLabelMb: finiteOrNull(gpu?.vramProxyMb),
  };
  const normalizedEnforced = normalizeEnforced(enforced);
  const selected = gpuAdapter ? { gpuAdapter: normalizeGpuAdapterSelection(gpuAdapter) } : {};
  const normalizedInjected = (Array.isArray(injected) ? injected : []).map((entry) => ({ ...entry }));
  const spoofed = reported.deviceMemoryGb !== null
    || reported.hardwareConcurrency !== null
    || webgpu !== WEBGPU_EXPOSURE.HOST;
  const categories = [];
  if (native) categories.push(EVIDENCE_CATEGORIES.NATIVE_HOST);
  if (spoofed) categories.push(EVIDENCE_CATEGORIES.CAPABILITY_SIMULATION);
  if (Object.keys(normalizedEnforced).length) categories.push(EVIDENCE_CATEGORIES.RESOURCE_CONSTRAINED_HOST);
  if (normalizedInjected.length) categories.push(EVIDENCE_CATEGORIES.FAULT_INJECTION);
  if (!categories.length) categories.push(EVIDENCE_CATEGORIES.NATIVE_HOST);

  return deepFreeze({
    categories,
    reported,
    enforced: normalizedEnforced,
    selected,
    injected: normalizedInjected,
    limitations: [...new Set([
      ...describeDefaultLimitations({ reported, enforced: normalizedEnforced, selected, injected: normalizedInjected }),
      ...limitations,
    ])],
  });
}

function normalizeEnforced(enforced = {}) {
  const result = {};
  if (enforced.cpuAffinity) {
    const count = Number(enforced.cpuAffinity.count);
    const coreClass = enforced.cpuAffinity.coreClass || 'any';
    if (!Number.isInteger(count) || count < 1 || count > 64) throw new Error('cpuAffinity.count must be an integer from 1 to 64.');
    if (!CORE_CLASSES.includes(coreClass)) throw new Error(`cpuAffinity.coreClass must be one of ${CORE_CLASSES.join(', ')}.`);
    result.cpuAffinity = { count, coreClass, mechanism: 'windows-job-affinity' };
  }
  if (enforced.cpuRate) {
    const percent = Number(enforced.cpuRate.percentOfSystem);
    if (!Number.isFinite(percent) || percent <= 0 || percent > 100) throw new Error('cpuRate.percentOfSystem must be within (0, 100].');
    result.cpuRate = {
      percentOfSystem: percent,
      hundredthsPercent: Math.round(percent * 100),
      mechanism: 'windows-job-cpu-rate-hard-cap',
    };
  }
  if (enforced.browserCommit) {
    const bytes = Number(enforced.browserCommit.bytes);
    if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error('browserCommit.bytes must be a positive integer.');
    result.browserCommit = { bytes, mechanism: 'windows-job-memory-limit' };
  }
  return result;
}

function normalizeGpuAdapterSelection(selection) {
  // Adapter LUIDs change across reboots, so lanes select by vendor and the
  // launcher resolves the LUID from DXGI at run time.
  const expectedVendor = String(selection?.expectedVendor || '').toLowerCase();
  if (!expectedVendor) throw new Error('gpuAdapter.expectedVendor is required.');
  return {
    expectedVendor,
    description: selection.description || null,
    mechanism: 'chrome-use-adapter-luid',
  };
}

function describeDefaultLimitations({ reported, enforced, selected, injected }) {
  const limitations = [];
  if (reported.deviceMemoryGb !== null || reported.hardwareConcurrency !== null) {
    limitations.push('navigator.deviceMemory/hardwareConcurrency are reported values in the toolbar-player page only; they do not limit host RAM or CPU cores.');
  }
  if (reported.webgpu === WEBGPU_EXPOSURE.SIMULATED_ADAPTER) {
    limitations.push('The simulated WebGPU adapter is a page-level fake; it cannot execute inference and says nothing about that GPU model\'s performance.');
  }
  if (reported.webgpu === WEBGPU_EXPOSURE.HOST && !selected.gpuAdapter) {
    limitations.push('WebGPU runs on the host browser\'s default adapter.');
  }
  if (reported.vramLabelMb !== null) {
    limitations.push(`The ${reported.vramLabelMb} MB VRAM figure is a label; VRAM is not reserved or limited.`);
  }
  if (reported.bufferLimits) {
    limitations.push('WebGPU buffer limits are per-allocation API limits, not a total-VRAM budget.');
  }
  if (enforced.cpuAffinity) {
    limitations.push('Processor affinity restricts which host cores run the browser; restricted modern cores are not an older CPU.');
    limitations.push('Restricted cores still share host caches, memory bandwidth, boost behavior and the scheduler with other processes.');
  }
  if (enforced.cpuRate) {
    limitations.push('The CPU-rate cap is a share of the whole host (all logical processors), not of one core.');
  }
  if (enforced.browserCommit) {
    limitations.push('The memory ceiling limits committed memory of the test-browser process tree; it is not total system RAM and does not create OS memory pressure.');
  }
  if (selected.gpuAdapter) {
    limitations.push('The selected physical adapter shares the host CPU, RAM, driver stack and power budget; it is not a complete low-end computer.');
  }
  for (const injection of injected) {
    limitations.push(`${injection.kind}: ${injection.label || 'synthetic fault injection'}; not measured hardware behavior.`);
  }
  return limitations;
}

/**
 * Static checks for a profile definition. Returns a list of problems.
 * @param {any} profile
 */
export function validateProfileEvidence(profile) {
  const problems = [];
  const name = profile?.name || 'unnamed';
  const evidence = profile?.evidence;
  if (!evidence || typeof evidence !== 'object') return [`${name}: missing evidence descriptor`];
  const categories = Array.isArray(evidence.categories) ? evidence.categories : [];
  if (!categories.length) problems.push(`${name}: no evidence categories`);
  for (const category of categories) {
    if (!KNOWN_CATEGORIES.has(category)) problems.push(`${name}: unknown evidence category ${category}`);
  }
  if (categories.includes(EVIDENCE_CATEGORIES.PHYSICAL_TARGET)) {
    problems.push(`${name}: physical-target evidence comes from an attested run, never from a profile definition`);
  }
  const reported = evidence.reported || {};
  const spoofed = reported.deviceMemoryGb !== null || reported.hardwareConcurrency !== null || reported.webgpu !== WEBGPU_EXPOSURE.HOST;
  if (spoofed && !categories.includes(EVIDENCE_CATEGORIES.CAPABILITY_SIMULATION)) {
    problems.push(`${name}: reported capabilities differ from the host but the profile is not labelled capability-simulation`);
  }
  if (categories.includes(EVIDENCE_CATEGORIES.CAPABILITY_SIMULATION) && profile?.simulated !== true) {
    problems.push(`${name}: capability-simulation profiles must keep simulated: true`);
  }
  const enforced = evidence.enforced || {};
  for (const [kind, constraint] of Object.entries(enforced)) {
    if (!constraint?.mechanism) problems.push(`${name}: enforced ${kind} has no enforcement mechanism`);
  }
  if (Object.keys(enforced).length && !categories.includes(EVIDENCE_CATEGORIES.RESOURCE_CONSTRAINED_HOST)) {
    problems.push(`${name}: enforced constraints require the resource-constrained-host category`);
  }
  if ((evidence.injected || []).length && !categories.includes(EVIDENCE_CATEGORIES.FAULT_INJECTION)) {
    problems.push(`${name}: injected faults require the fault-injection category`);
  }
  if (reported.vramLabelMb !== null && reported.vramLabelMb !== undefined
    && !(evidence.limitations || []).some((limitation) => /VRAM is not reserved/.test(limitation))) {
    problems.push(`${name}: a VRAM label must state that VRAM is not enforced`);
  }
  if (categories.some((category) => category !== EVIDENCE_CATEGORIES.NATIVE_HOST) && !(evidence.limitations || []).length) {
    problems.push(`${name}: non-native profiles must state their limitations`);
  }
  return problems;
}

/**
 * Compares what a profile requested with what the run observed. Any unapplied
 * constraint makes the run invalid-environment rather than a lower-spec result.
 * A value the run never observed (it failed first) leaves the environment
 * "unverified": that is not evidence of a wrong environment, nor of a right one.
 * @param {{ profile: any, observed?: any }} input
 */
export function assessRunEnvironment({ profile, observed = {} } = {}) {
  const evidence = profile?.evidence || {};
  const reported = evidence.reported || {};
  const enforced = evidence.enforced || {};
  const page = observed.page || {};
  const checks = [];
  const check = (name, ok, expected, actual, reason = null, { unobserved = false } = {}) => {
    checks.push({
      name,
      ok: Boolean(ok),
      expected,
      observed: actual ?? null,
      ...(ok ? {} : { reason: unobserved ? 'not observed before the attempt ended' : reason, unobserved }),
    });
  };
  const missing = (value) => value === null || value === undefined;

  if (reported.deviceMemoryGb !== null && reported.deviceMemoryGb !== undefined) {
    check('reported.deviceMemory', page.deviceMemory === reported.deviceMemoryGb, reported.deviceMemoryGb, page.deviceMemory,
      'navigator.deviceMemory override did not reach the toolbar-player page', { unobserved: missing(page.deviceMemory) });
  }
  if (reported.hardwareConcurrency !== null && reported.hardwareConcurrency !== undefined) {
    check('reported.hardwareConcurrency', page.hardwareConcurrency === reported.hardwareConcurrency, reported.hardwareConcurrency,
      page.hardwareConcurrency, 'navigator.hardwareConcurrency override did not reach the toolbar-player page',
      { unobserved: missing(page.hardwareConcurrency) });
  }
  const exposure = reported.webgpu || WEBGPU_EXPOSURE.HOST;
  if (exposure === WEBGPU_EXPOSURE.HIDDEN) {
    check('webgpu.hidden', page.navigatorGpu === false, false, page.navigatorGpu, 'navigator.gpu is still exposed',
      { unobserved: missing(page.navigatorGpu) });
  } else if (exposure === WEBGPU_EXPOSURE.NO_ADAPTER) {
    check('webgpu.no-adapter', page.navigatorGpu === true && !page.adapter, 'navigator.gpu without adapter', page.adapter,
      'requestAdapter() still returned an adapter', { unobserved: missing(page.navigatorGpu) });
  } else if (exposure === WEBGPU_EXPOSURE.SIMULATED_ADAPTER) {
    const expectedVendor = String(reported.adapter?.vendor || '').toLowerCase();
    const actualVendor = String(page.adapter?.vendor || '').toLowerCase();
    check('webgpu.simulated-adapter', Boolean(expectedVendor) && actualVendor === expectedVendor, expectedVendor, actualVendor,
      'the simulated adapter was not visible in the toolbar-player page', { unobserved: missing(page.navigatorGpu) });
  }

  if (Object.keys(enforced).length) {
    const enforcement = observed.enforcement || {};
    const processes = Array.isArray(enforcement.processes) ? enforcement.processes : [];
    check('enforcement.adapter', enforcement.supported === true, 'windows-job', enforcement.adapter || null,
      enforcement.error || 'no constraint adapter was attached');
    // A process that exited between the supervisor's listing and its inspection
    // (ERROR_INVALID_PARAMETER) is gone, not outside the job. One that could not
    // be opened for another reason cannot be judged either way.
    const exited = processes.filter((process) => Number(process.openError) === ERROR_INVALID_PARAMETER);
    const uninspectable = processes.filter((process) => !missing(process.openError) && !exited.includes(process));
    const inspected = processes.filter((process) => missing(process.openError));
    const outsideProcesses = inspected.filter((process) => process.inJob !== true);
    const outside = outsideProcesses.map((process) => process.pid);
    // A supported job with no live processes (e.g. queried after a crash) cannot show coverage either way.
    const nothingToInspect = inspected.length === 0 && enforcement.supported === true;
    check('enforcement.process-coverage', inspected.length > 0 && outside.length === 0 && uninspectable.length === 0, 'all browser processes in the job',
      {
        processes: processes.length,
        outside,
        outsideDetails: outsideProcesses.map(({ pid, name, parentPid, commandLineMatched, listedInJob }) => ({ pid, name, parentPid, commandLineMatched, listedInJob })),
        exited: exited.map((process) => process.pid),
        uninspectable: uninspectable.map(({ pid, name, openError }) => ({ pid, name, openError })),
      },
      inspected.length ? 'browser processes ran outside the constraint job' : 'no browser processes were observed',
      { unobserved: nothingToInspect || (outside.length === 0 && uninspectable.length > 0) });
    const limits = enforcement.limits || {};
    if (enforced.cpuAffinity) {
      const resolved = enforcement.resolvedAffinity || null;
      const expectedMask = parseBigInt(resolved?.mask);
      const jobMask = parseBigInt(limits.affinityMask);
      const wrongProcesses = inspected.filter((process) => parseBigInt(process.affinityMask) !== expectedMask).map((process) => process.pid);
      const classOk = enforced.cpuAffinity.coreClass === 'any' || resolved?.coreClassSatisfied === true;
      check('enforced.cpuAffinity',
        expectedMask !== null && jobMask === expectedMask && inspected.length > 0 && wrongProcesses.length === 0
          && resolved?.logicalProcessors?.length === enforced.cpuAffinity.count && classOk,
        { count: enforced.cpuAffinity.count, coreClass: enforced.cpuAffinity.coreClass },
        { resolved, jobMask: limits.affinityMask ?? null, wrongProcesses },
        expectedMask === null ? 'processor affinity was not resolved from the host topology'
          : 'processor affinity was not applied to every browser process with the requested core class',
        { unobserved: nothingToInspect && expectedMask !== null && jobMask === expectedMask });
    }
    // Effect check: a calibration load must not use more processors than allowed.
    const calibration = observed.calibration;
    const busy = calibration?.busyLogicalProcessors;
    const allowed = enforced.cpuAffinity
      ? enforced.cpuAffinity.count
      : (enforced.cpuRate && calibration?.hostLogicalProcessors ? (enforced.cpuRate.percentOfSystem / 100) * calibration.hostLogicalProcessors : null);
    if (allowed !== null) {
      check('enforced.cpu.effect', isFiniteValue(busy) && busy <= (allowed * (1 + CALIBRATION_TOLERANCE)) + CALIBRATION_OVERHEAD_PROCESSORS,
        { maxBusyLogicalProcessors: allowed }, busy ?? null,
        `a ${calibration?.workers ?? '?'}-worker calibration kept ${Number(busy).toFixed(2)} logical processors busy, above the allowed ${allowed}`,
        { unobserved: !isFiniteValue(busy) });
    }
    if (enforced.cpuRate) {
      const flags = Number(limits.cpuRateControlFlags);
      check('enforced.cpuRate', Number(limits.cpuRateHundredthsPercent) === enforced.cpuRate.hundredthsPercent && (flags & 0x5) === 0x5,
        enforced.cpuRate.hundredthsPercent, { rate: limits.cpuRateHundredthsPercent ?? null, flags: limits.cpuRateControlFlags ?? null },
        'the hard CPU-rate cap was not active on the job');
    }
    if (enforced.browserCommit) {
      check('enforced.browserCommit', String(limits.jobMemoryLimitBytes) === String(enforced.browserCommit.bytes),
        enforced.browserCommit.bytes, limits.jobMemoryLimitBytes ?? null, 'the job memory limit was not active');
      // Windows reports the job's peak commit; a peak above the configured
      // ceiling means the limit did not hold for every allocation.
      const peak = Number(limits.peakJobMemoryUsedBytes);
      if (Number.isFinite(peak) && peak > 0) {
        check('enforced.browserCommit.held', peak <= enforced.browserCommit.bytes * (1 + COMMIT_LIMIT_TOLERANCE),
          enforced.browserCommit.bytes, peak,
          `observed peak commit ${Math.round(peak / 1048576)} MiB exceeded the ${Math.round(enforced.browserCommit.bytes / 1048576)} MiB ceiling`);
      }
    }
  }
  const selectedAdapter = evidence.selected?.gpuAdapter;
  if (selectedAdapter) {
    const actualVendor = String(observed.gpuAdapter?.vendor || page.adapter?.vendor || '').toLowerCase();
    check('selected.gpuAdapter', actualVendor === selectedAdapter.expectedVendor, selectedAdapter.expectedVendor, actualVendor || null,
      'WebGPU did not select the requested physical adapter', { unobserved: missing(page.navigatorGpu) && !observed.gpuAdapter });
  }
  for (const injection of evidence.injected || []) {
    if (observed.injections?.[injection.kind]?.notApplicable) {
      // e.g. the online warm-up read of an offline lane.
      check(`injected.${injection.kind}`, true, 'not applicable to this run', 'not applicable');
      continue;
    }
    const triggered = Number(observed.injections?.[injection.kind]?.triggered || 0);
    check(`injected.${injection.kind}`, triggered > 0, 'triggered', triggered,
      'the injected condition was never triggered, so the run did not exercise it',
      { unobserved: !observed.injections || (observed.injectionsObserved === false && !observed.injections[injection.kind]) });
  }

  const failed = checks.filter((entry) => !entry.ok);
  const contradicted = failed.filter((entry) => !entry.unobserved);
  return {
    status: contradicted.length ? RUN_STATUS.INVALID_ENVIRONMENT : (failed.length ? 'unverified' : 'valid'),
    categories: [...(evidence.categories || [])],
    checks,
    violations: failed.map((entry) => `${entry.name}: ${entry.reason}`),
  };
}

/**
 * Decides whether timing from a run may be used by measurement-dependent gates.
 * @param {{ schedulingMode?: string, lock?: any, hostLoad?: any, usesGpu?: boolean }} input
 */
export function assessMeasurementValidity({ schedulingMode, lock, hostLoad, usesGpu = false } = {}) {
  const reasons = [];
  if (schedulingMode !== SCHEDULING_MODES.ISOLATED) reasons.push(`scheduling mode is ${schedulingMode || 'unknown'}, not isolated`);
  if (lock?.held !== true) reasons.push('the host-wide measurement lock was not held');
  const cpu = hostLoad?.foreignCpuFraction;
  if (!isFiniteValue(cpu)) {
    reasons.push('foreign CPU load was not measured');
  } else if (Number(cpu) >= CONTAMINATION_THRESHOLDS.foreignCpuFraction) {
    reasons.push(`foreign CPU load ${(Number(cpu) * 100).toFixed(1)}% of host capacity is at or above ${CONTAMINATION_THRESHOLDS.foreignCpuFraction * 100}%`);
  }
  const gpu = hostLoad?.foreignGpuUtilizationPercent;
  if (usesGpu) {
    if (!isFiniteValue(gpu) || typeof gpu === 'string' && gpu.trim() === '') {
      reasons.push('foreign GPU load was not measured');
    } else if (Number(gpu) >= CONTAMINATION_THRESHOLDS.foreignGpuUtilizationPercent) {
      reasons.push(`foreign GPU utilization ${Number(gpu)}% is at or above ${CONTAMINATION_THRESHOLDS.foreignGpuUtilizationPercent}%`);
    }
  }
  return { contractVersion: MEASUREMENT_CONTRACT_VERSION, contaminated: reasons.length > 0, reasons, thresholds: CONTAMINATION_THRESHOLDS };
}

/**
 * Resolves what actually executed, separately from the planner's intent.
 * @param {any} tts probe result recorded by the toolbar player
 */
export function resolveExecutionBackend(tts = {}) {
  const requested = tts?.selectedBackendPlan?.device || null;
  const fallbacks = Array.isArray(tts?.fallbacks) ? tts.fallbacks : [];
  if (fallbacks.some((fallback) => fallback?.type === 'browser-voice')) {
    return { requested, observed: 'browser-speech', source: 'browser-voice-fallback', fellBack: true };
  }
  const modelFallback = fallbacks.filter((fallback) => fallback?.type === 'model').at(-1);
  const observed = modelFallback?.fallbackPlan?.device || requested;
  const producedAudio = isFiniteValue(tts?.firstSynthesisMs) && isFiniteValue(tts?.audioDurationSeconds)
    && Number(tts.audioDurationSeconds) > 0;
  return {
    requested,
    observed: producedAudio ? observed : null,
    source: modelFallback ? 'model-fallback-plan' : 'initial-plan',
    fellBack: Boolean(modelFallback),
    producedAudio,
  };
}

/**
 * Picks concrete logical processors for a cpuAffinity request from the host
 * topology (efficiency class per logical processor; higher = faster cores).
 * @param {{ count: number, coreClass: string }} request
 * @param {Array<{ logicalProcessor: number, efficiencyClass: number }>} processors
 */
export function resolveCpuAffinity(request, processors = []) {
  const classes = [...new Set(processors.map((processor) => processor.efficiencyClass))].sort((a, b) => a - b);
  if (!classes.length) return { available: false, reason: 'host topology unavailable' };
  const homogeneous = classes.length === 1;
  let targetClass = null;
  if (request.coreClass === 'efficiency') targetClass = classes[0];
  if (request.coreClass === 'performance') targetClass = classes.at(-1);
  const candidates = processors
    .filter((processor) => targetClass === null || processor.efficiencyClass === targetClass)
    .map((processor) => processor.logicalProcessor)
    .sort((a, b) => a - b);
  if (candidates.length < request.count) {
    return { available: false, reason: `host has ${candidates.length} ${request.coreClass} logical processors; ${request.count} requested` };
  }
  const logicalProcessors = candidates.slice(0, request.count);
  return {
    available: true,
    logicalProcessors,
    mask: affinityMaskFor(logicalProcessors),
    efficiencyClasses: logicalProcessors.map((index) => processors.find((processor) => processor.logicalProcessor === index)?.efficiencyClass ?? null),
    coreClass: request.coreClass,
    coreClassSatisfied: true,
    homogeneousHost: homogeneous,
  };
}

export function affinityMaskFor(processors = []) {
  let mask = 0n;
  for (const processor of processors) mask |= 1n << BigInt(processor);
  return `0x${mask.toString(16)}`;
}

// Number(null) is 0; a missing measurement must never read as a real zero.
function isFiniteValue(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
}

function parseBigInt(value) {
  if (value === null || value === undefined || value === '') return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object') return value;
  for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
}
