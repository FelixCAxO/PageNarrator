import { createLaneProfile, GIB } from './tts-probe-profile-builders.js';

// Weak-hardware lanes. Each lane states what it changes (evidence), how the
// change is applied (launch/faults) and which outcomes count as correct.
export const OUTCOMES = Object.freeze({
  LOCAL_MODEL: 'local-model',
  PERMITTED_FALLBACK: 'permitted-fallback',
  EXPLICIT_ERROR: 'explicit-error',
  RENDERER_CRASHED: 'renderer-crashed',
  RENDERER_UNRESPONSIVE: 'renderer-unresponsive',
  BROWSER_CRASHED: 'browser-crashed',
});

// Memory ceilings search for a boundary: any outcome is acceptable evidence as
// long as repeated runs land in the same category (a reproducible result).
export const BOUNDARY_OUTCOMES = Object.freeze([
  OUTCOMES.LOCAL_MODEL,
  OUTCOMES.PERMITTED_FALLBACK,
  OUTCOMES.EXPLICIT_ERROR,
  OUTCOMES.RENDERER_CRASHED,
  OUTCOMES.RENDERER_UNRESPONSIVE,
  OUTCOMES.BROWSER_CRASHED,
]);

export const NATIVE_TTS_PROBE_PROFILES = Object.freeze([
  createLaneProfile({
    name: 'native_webgpu',
    label: 'Native host, Auto processing (WebGPU expected)',
    lane: 'native',
    expected: { execution: ['webgpu'], outcomes: [OUTCOMES.LOCAL_MODEL] },
  }),
  createLaneProfile({
    name: 'native_wasm',
    label: 'Native host, CPU / WebAssembly selected',
    lane: 'native',
    playbackSettings: { ttsBackendPreference: 'wasm' },
    expected: { execution: ['wasm'], outcomes: [OUTCOMES.LOCAL_MODEL] },
  }),
]);

// Affinity lanes request a core class; the launcher resolves concrete logical
// processors from the host topology and records them with each run.
export const CPU_CONSTRAINED_TTS_PROBE_PROFILES = Object.freeze([
  ...[4, 2, 1].map((threads) => createCpuLane({ cores: 4, coreClass: 'efficiency', threads })),
  createCpuLane({ cores: 2, coreClass: 'efficiency', threads: 2 }),
  createCpuLane({ cores: 1, coreClass: 'efficiency', threads: 1 }),
  createCpuLane({ cores: 4, coreClass: 'performance', threads: 4 }),
  createLaneProfile({
    name: 'cpu_rate25_wasm',
    label: 'Browser capped at 25% of total host CPU time, CPU / WebAssembly',
    lane: 'cpu',
    playbackSettings: { ttsBackendPreference: 'wasm' },
    enforced: { cpuRate: { percentOfSystem: 25 } },
    expected: { execution: ['wasm'], outcomes: [OUTCOMES.LOCAL_MODEL] },
  }),
  createLaneProfile({
    name: 'cpu_4ecore_webgpu',
    label: '4 host efficiency cores (affinity), Auto processing (WebGPU expected)',
    lane: 'cpu',
    navigator: { hardwareConcurrency: 4 },
    enforced: { cpuAffinity: { count: 4, coreClass: 'efficiency' } },
    expected: { execution: ['webgpu'], outcomes: [OUTCOMES.LOCAL_MODEL] },
  }),
]);

export function createCpuLane({ cores, coreClass, threads }) {
  const shortClass = coreClass === 'efficiency' ? 'e' : 'p';
  const inferenceWorkers = threads >= 4 ? 4 : 1;
  return createLaneProfile({
    name: `cpu_${cores}${shortClass}core_wasm_t${threads}`,
    label: `${cores} host ${coreClass} core${cores === 1 ? '' : 's'} (affinity), CPU / WebAssembly, ${threads} reported logical processor${threads === 1 ? '' : 's'}, ${inferenceWorkers} inference worker${inferenceWorkers === 1 ? '' : 's'}`,
    lane: 'cpu',
    // The isolated shared-memory pool uses four workers; lower reported concurrency selects one.
    navigator: { hardwareConcurrency: threads },
    playbackSettings: { ttsBackendPreference: 'wasm' },
    enforced: { cpuAffinity: { count: cores, coreClass } },
    expectedWasmThreads: inferenceWorkers,
    expected: { execution: ['wasm'], outcomes: [OUTCOMES.LOCAL_MODEL] },
  });
}

export const MEMORY_CONSTRAINED_TTS_PROBE_PROFILES = Object.freeze([
  ...[4, 2, 1].map((gib) => createLaneProfile({
    name: `mem_${gib}gib_webgpu`,
    label: `Test-browser commit ceiling ${gib} GiB, Auto processing (WebGPU expected)`,
    lane: 'memory',
    enforced: { browserCommit: { bytes: gib * GIB } },
    runs: 2,
    // A failure at the ceiling can wedge the whole browser, so each run starts a
    // fresh browser on the same profile to keep runs independent.
    freshBrowserPerRun: true,
    expected: { execution: ['webgpu', 'wasm', null], outcomes: BOUNDARY_OUTCOMES, requireConsistentOutcome: true },
  })),
  ...[2, 1].map((gib) => createLaneProfile({
    name: `mem_${gib}gib_wasm`,
    label: `Test-browser commit ceiling ${gib} GiB, CPU / WebAssembly`,
    lane: 'memory',
    playbackSettings: { ttsBackendPreference: 'wasm' },
    enforced: { browserCommit: { bytes: gib * GIB } },
    runs: 2,
    freshBrowserPerRun: true,
    expected: { execution: ['wasm', null], outcomes: BOUNDARY_OUTCOMES, requireConsistentOutcome: true },
  })),
]);

export const GPU_FAULT_TTS_PROBE_PROFILES = Object.freeze([
  createLaneProfile({
    name: 'gpu_fault_adapter_rejects',
    label: 'Fault injection: navigator.gpu.requestAdapter() rejects',
    lane: 'gpu-fault',
    faults: [{ kind: 'webgpu-request-adapter-rejects', label: 'requestAdapter() rejects in the toolbar-player page' }],
    expected: { execution: ['wasm'], outcomes: [OUTCOMES.LOCAL_MODEL], backendReason: 'no-adapter' },
  }),
  createLaneProfile({
    name: 'gpu_fault_device_rejects',
    label: 'Fault injection: GPUAdapter.requestDevice() rejects',
    lane: 'gpu-fault',
    faults: [{ kind: 'webgpu-request-device-rejects', label: 'requestDevice() rejects after a real adapter is found' }],
    expected: { execution: ['wasm'], outcomes: [OUTCOMES.PERMITTED_FALLBACK], maxRequestDeviceCalls: 2 },
  }),
  createLaneProfile({
    name: 'gpu_default_limits',
    label: 'Capability restriction: real device limited to WebGPU default limits (256 MiB buffer, 128 MiB storage binding)',
    lane: 'gpu-fault',
    faults: [{
      kind: 'webgpu-default-limits',
      label: 'adapter reports and the real device enforces spec-default buffer limits; an API limit, not a VRAM budget',
    }],
    expected: { execution: ['webgpu', 'wasm'], outcomes: [OUTCOMES.LOCAL_MODEL, OUTCOMES.PERMITTED_FALLBACK] },
  }),
  createLaneProfile({
    name: 'gpu_fault_device_lost_after_first_audio',
    label: 'Fault injection: GPUDevice.destroy() after the first section starts playing',
    lane: 'gpu-fault',
    faults: [{ kind: 'webgpu-device-destroyed', label: 'synthetic device loss through GPUDevice.destroy() after first playback' }],
    expected: {
      execution: ['webgpu', 'wasm', null],
      outcomes: [OUTCOMES.LOCAL_MODEL, OUTCOMES.PERMITTED_FALLBACK, OUTCOMES.EXPLICIT_ERROR],
    },
  }),
  createLaneProfile({
    name: 'gpu_latency_250ms',
    label: 'Synthetic latency injection: +250 ms on every GPU buffer readback',
    lane: 'gpu-fault',
    faults: [{ kind: 'webgpu-readback-latency', delayMs: 250, label: 'synthetic latency injection on GPUBuffer.mapAsync(); not weak-GPU performance' }],
    expected: { execution: ['webgpu'], outcomes: [OUTCOMES.LOCAL_MODEL] },
  }),
]);

export const PHYSICAL_ADAPTER_TTS_PROBE_PROFILES = Object.freeze([
  createLaneProfile({
    name: 'igpu_webgpu',
    label: 'Host integrated GPU selected for WebGPU (physical adapter)',
    lane: 'physical-adapter',
    gpuAdapter: { expectedVendor: 'intel', description: 'Integrated GPU present in the host' },
    expected: { execution: ['webgpu'], outcomes: [OUTCOMES.LOCAL_MODEL] },
  }),
  createLaneProfile({
    name: 'dgpu_webgpu',
    label: 'Host NVIDIA GPU selected for WebGPU (physical adapter)',
    lane: 'physical-adapter',
    gpuAdapter: { expectedVendor: 'nvidia', description: 'NVIDIA GPU present in the host' },
    expected: { execution: ['webgpu'], outcomes: [OUTCOMES.LOCAL_MODEL] },
  }),
]);
