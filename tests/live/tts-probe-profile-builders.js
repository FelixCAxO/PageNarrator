import { createProfileEvidence } from '../../scripts/weak-hardware/evidence-contract.mjs';

export const GIB = 1024 * 1024 * 1024;

// Model acquisition faults on first use and on a warm cache. Each fault is
// applied by CDP to the toolbar-player page and verified (tts-probe-run-faults.js).
export const MIB = 1024 * 1024;

/**
 * @param {{
 *   name: string,
 *   label: string,
 *   lane: string,
 *   navigator?: Record<string, number>,
 *   disableWebGpu?: boolean,
 *   playbackSettings?: Record<string, string>,
 *   enforced?: Record<string, any>,
 *   gpuAdapter?: { expectedVendor: string, description?: string }|null,
 *   faults?: Array<Record<string, any>>,
 *   expected: {
 *     execution: Array<string|null>,
 *     outcomes: readonly string[],
 *     backendReason?: string,
 *     maxRequestDeviceCalls?: number,
 *     requireConsistentOutcome?: boolean,
 *     continuity?: { maxInterSectionGapMs: number, noUnexpectedSilence: boolean },
 *   },
 *   expectedWasmThreads?: number|null,
 *   runs?: number,
 *   minProbeSections?: number,
 *   runConditions?: Array<{ network?: string, restartBrowser?: boolean, playbackSettings?: Record<string, string>, expectedOutcome?: string }>|null,
 *   lifecycle?: { action: string }|null,
 *   nativeBackgrounding?: boolean,
 *   freshBrowserPerRun?: boolean,
 *   documentTypes?: string[]|null,
 *   contention?: { cpu?: { threads: number, dutyCycle: number }, gpu?: { dutyCycle: number, periodMs?: number } }|null,
 *   soak?: Record<string, number>|null,
 * }} options
 */
export function createLaneProfile({
  name,
  label,
  lane,
  navigator = {},
  disableWebGpu = false,
  playbackSettings = {},
  enforced = {},
  gpuAdapter = null,
  faults = [],
  expected,
  expectedWasmThreads = null,
  runs = 3,
  minProbeSections = 2,
  runConditions = null,
  lifecycle = null,
  nativeBackgrounding = false,
  freshBrowserPerRun = false,
  documentTypes = null,
  contention = null,
  soak = null,
}) {
  const navigatorOverrides = Object.freeze({ ...navigator });
  const conditions = Array.isArray(runConditions) ? runConditions.map((condition) => ({ network: 'online', ...condition })) : null;
  const runCount = conditions ? conditions.length : runs;
  const evidence = createProfileEvidence({
    navigator: navigatorOverrides,
    disableWebGpu,
    enforced,
    gpuAdapter,
    injected: faults.map((fault) => ({ ...fault, mechanism: 'page-script-override' })),
  });
  return deepFreeze({
    name,
    label,
    lane,
    simulated: evidence.categories.includes('capability-simulation'),
    navigator: navigatorOverrides,
    disableWebGpu,
    playbackSettings: {
      ttsPerformanceProfile: 'auto',
      ...playbackSettings,
    },
    evidence,
    gpu: normalizeGpuDescriptor(null, { disableWebGpu }),
    faults: faults.map((fault) => ({ ...fault })),
    expected: {
      execution: [...expected.execution],
      outcomes: [...expected.outcomes],
      backendReason: expected.backendReason || null,
      maxRequestDeviceCalls: expected.maxRequestDeviceCalls ?? null,
      requireConsistentOutcome: Boolean(expected.requireConsistentOutcome),
      continuity: expected.continuity ? { ...expected.continuity } : null,
    },
    expectedWasmThreads,
    requirement: normalizeRequirementDescriptor(null, {
      deviceMemory: navigatorOverrides.deviceMemory,
      hardwareConcurrency: navigatorOverrides.hardwareConcurrency,
      gpu: null,
    }),
    minProbeSections,
    expectBrowserFallback: false,
    forceKokoroFailure: false,
    coldStart: false,
    runs: runCount,
    biasRuns: runCount,
    runConditions: conditions,
    lifecycle: lifecycle ? { ...lifecycle } : null,
    nativeBackgrounding: Boolean(nativeBackgrounding),
    freshBrowserPerRun: Boolean(freshBrowserPerRun),
    documentTypes: documentTypes ? [...documentTypes] : null,
    contention: contention
      ? { ...(contention.cpu ? { cpu: { ...contention.cpu } } : {}), ...(contention.gpu ? { gpu: { ...contention.gpu } } : {}) }
      : null,
    soak: soak ? { ...soak } : null,
  });
}

export function createSimulatedProfile({
  name,
  label,
  deviceMemory,
  hardwareConcurrency,
  disableWebGpu,
  minProbeSections,
  expectBrowserFallback = false,
  forceKokoroFailure = false,
  coldStart = false,
  runs = 3,
  biasRuns = null,
  gpu = null,
  gpuAdapter = null,
  requirement = null,
}) {
  const normalizedRuns = normalizePositiveInteger(runs) || 1;
  const normalizedGpu = normalizeGpuDescriptor(gpu, { disableWebGpu });
  const normalizedRequirement = normalizeRequirementDescriptor(requirement, {
    deviceMemory,
    hardwareConcurrency,
    gpu: normalizedGpu,
  });
  return Object.freeze({
    name,
    label,
    simulated: true,
    navigator: Object.freeze({
      deviceMemory,
      hardwareConcurrency,
    }),
    disableWebGpu,
    playbackSettings: Object.freeze({
      ttsPerformanceProfile: 'auto',
    }),
    evidence: createProfileEvidence({
      navigator: { deviceMemory, hardwareConcurrency },
      disableWebGpu,
      gpu: normalizedGpu,
      gpuAdapter,
      injected: forceKokoroFailure
        ? [{ kind: 'kokoro-synthesis-failure', mechanism: 'extension-test-hook', label: 'test hook forces every Kokoro synthesis to fail' }]
        : [],
    }),
    gpu: normalizedGpu,
    requirement: normalizedRequirement,
    minProbeSections: Number.isFinite(Number(minProbeSections)) ? Math.max(1, Math.trunc(Number(minProbeSections))) : null,
    expectBrowserFallback: Boolean(expectBrowserFallback),
    forceKokoroFailure: Boolean(forceKokoroFailure),
    coldStart: Boolean(coldStart),
    runs: normalizedRuns,
    biasRuns: normalizePositiveInteger(biasRuns) || (hardwareConcurrency <= 2 ? Math.max(3, normalizedRuns) : normalizedRuns),
  });
}

export function createRequirementCandidate({
  name,
  label,
  system,
  gpu,
  expected,
  navigator = {},
  ...profileOptions
}) {
  const ramGb = Number(navigator.deviceMemory ?? system?.ramGb);
  const cpuThreads = Number(navigator.hardwareConcurrency ?? system?.cpuThreads);
  return createSimulatedProfile({
    name,
    label,
    deviceMemory: ramGb,
    hardwareConcurrency: cpuThreads,
    disableWebGpu: gpu?.mode === 'none',
    gpu,
    requirement: {
      candidate: true,
      system: {
        ramGb,
        cpuThreads,
        cpuModel: system?.cpuModel || 'simulated',
      },
      gpu,
      expected,
    },
    ...profileOptions,
  });
}

export function createIntegratedGpuDescriptor(adapterInfo) {
  return {
    mode: 'simulated-adapter',
    ...adapterInfo,
    vramProxyMb: 1024,
    limits: {
      maxStorageBufferBindingSize: 1024 * 1024 * 1024,
      maxBufferSize: 1024 * 1024 * 1024,
    },
    calibration: { tier: 'fast', elapsedMs: 8, gpuClass: 'integrated-probable' },
    expectedBackendReason: 'webgpu-available',
  };
}

export function normalizeRequirementDescriptor(requirement, { deviceMemory, hardwareConcurrency, gpu } = {}) {
  const source = requirement && typeof requirement === 'object' ? requirement : {};
  const system = source.system && typeof source.system === 'object' ? source.system : {};
  const normalized = {
    candidate: source.candidate === true,
    system: Object.freeze({
      ramGb: normalizeFiniteNumber(system.ramGb ?? deviceMemory),
      cpuThreads: normalizeFiniteNumber(system.cpuThreads ?? hardwareConcurrency),
      cpuModel: system.cpuModel || 'simulated',
    }),
    gpu,
    expected: Object.freeze(source.expected && typeof source.expected === 'object' ? { ...source.expected } : {}),
  };
  return Object.freeze(normalized);
}

export function normalizeGpuDescriptor(gpu, { disableWebGpu } = {}) {
  if (gpu && typeof gpu === 'object') return deepFreeze({ ...gpu });
  return Object.freeze({
    mode: disableWebGpu ? 'none' : 'host',
    expectedBackendReason: disableWebGpu ? 'no-webgpu' : null,
  });
}

export function normalizeFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function deepFreeze(value) {
  if (!value || typeof value !== 'object') return value;
  for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
}

export function normalizePositiveInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0;
}
