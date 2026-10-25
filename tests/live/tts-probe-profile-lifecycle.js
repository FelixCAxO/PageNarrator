import { createLaneProfile } from './tts-probe-profile-builders.js';
import { OUTCOMES } from './tts-probe-profile-resources.js';

// Audible continuity at the fastest supported speed (3x). Streaming must keep
// up with audio consumption at that speed, not just with a 1x benchmark. The
// gap bound is the existing minimum budget (750 ms); it is not relaxed here.
export const CONTINUITY = Object.freeze({ maxInterSectionGapMs: 750, noUnexpectedSilence: true });

export const PLAYBACK_TTS_PROBE_PROFILES = Object.freeze([
  createLaneProfile({
    name: 'playback_webgpu_3x',
    label: 'Native host, Auto processing (WebGPU), 3x playback',
    lane: 'playback',
    playbackSettings: { speed: 3 },
    expected: { execution: ['webgpu'], outcomes: [OUTCOMES.LOCAL_MODEL], continuity: CONTINUITY },
  }),
  createLaneProfile({
    name: 'playback_wasm_3x',
    label: 'Native host, CPU / WebAssembly, 3x playback',
    lane: 'playback',
    playbackSettings: { ttsBackendPreference: 'wasm', speed: 3 },
    expected: { execution: ['wasm'], outcomes: [OUTCOMES.LOCAL_MODEL], continuity: CONTINUITY },
  }),
  createLaneProfile({
    name: 'playback_4ecore_wasm_1x',
    label: '4 host efficiency cores (affinity), CPU / WebAssembly, 1x playback',
    lane: 'playback',
    navigator: { hardwareConcurrency: 4 },
    playbackSettings: { ttsBackendPreference: 'wasm', speed: 1 },
    enforced: { cpuAffinity: { count: 4, coreClass: 'efficiency' } },
    expectedWasmThreads: 4,
    expected: { execution: ['wasm'], outcomes: [OUTCOMES.LOCAL_MODEL], continuity: CONTINUITY },
  }),
  createLaneProfile({
    name: 'playback_4ecore_wasm_3x',
    label: '4 host efficiency cores (affinity), CPU / WebAssembly, 3x playback',
    lane: 'playback',
    navigator: { hardwareConcurrency: 4 },
    playbackSettings: { ttsBackendPreference: 'wasm', speed: 3 },
    enforced: { cpuAffinity: { count: 4, coreClass: 'efficiency' } },
    expectedWasmThreads: 4,
    expected: { execution: ['wasm'], outcomes: [OUTCOMES.LOCAL_MODEL], continuity: CONTINUITY },
  }),
]);

// Controls and lifecycle. Bounds are predeclared and measured on the page's
// media output (time until audio actually stops or resumes), not on UI state.
export const LIFECYCLE_BOUNDS = Object.freeze({
  maxStopToSilenceMs: 500,
  staleSpeechWindowMs: 3000,
  maxPauseToSilenceMs: 500,
  pauseHoldMs: 2000,
  maxResumeToSoundMs: 1500,
  // Background timers may be throttled while minimized, so this lane asserts
  // continued progress and reports gaps only as low-precision observations.
  minimizedObservationMs: 20_000,
});

export const LIFECYCLE_TTS_PROBE_PROFILES = Object.freeze([
  ...[
    ['stop', 'Stop while speaking'],
    ['pause-resume', 'Pause and resume while speaking'],
  ].flatMap(([action, description]) => [
    createLaneProfile({
      name: `lifecycle_${action.replace('-', '_')}_webgpu`,
      label: `${description}, native host, Auto processing`,
      lane: 'lifecycle',
      lifecycle: { action },
      expected: { execution: ['webgpu'], outcomes: [OUTCOMES.LOCAL_MODEL] },
    }),
    createLaneProfile({
      name: `lifecycle_${action.replace('-', '_')}_4ecore_wasm`,
      label: `${description}, 4 host efficiency cores (affinity), CPU / WebAssembly`,
      lane: 'lifecycle',
      navigator: { hardwareConcurrency: 4 },
      playbackSettings: { ttsBackendPreference: 'wasm' },
      enforced: { cpuAffinity: { count: 4, coreClass: 'efficiency' } },
      lifecycle: { action },
      expected: { execution: ['wasm'], outcomes: [OUTCOMES.LOCAL_MODEL] },
    }),
  ]),
  createLaneProfile({
    name: 'background_minimized_webgpu',
    label: 'Native window backgrounding: browser minimized while speaking (no occlusion override)',
    lane: 'lifecycle',
    nativeBackgrounding: true,
    lifecycle: { action: 'minimize' },
    expected: { execution: ['webgpu'], outcomes: [OUTCOMES.LOCAL_MODEL] },
  }),
]);

// Controlled contention: a declared competing CPU workload runs during the read.
// These attempts are always labelled contention, so they never enter isolated
// aggregates; the lane asks whether playback stays usable while the host is busy.
export const CONTENTION_TTS_PROBE_PROFILES = Object.freeze([
  createLaneProfile({
    name: 'contention_cpu12_webgpu',
    label: 'Auto processing while 12 load-generator threads run at 100% duty',
    lane: 'contention',
    contention: { cpu: { threads: 12, dutyCycle: 1 } },
    expected: { execution: ['webgpu'], outcomes: [OUTCOMES.LOCAL_MODEL], continuity: CONTINUITY },
  }),
  createLaneProfile({
    name: 'contention_cpu12_wasm',
    label: 'CPU / WebAssembly while 12 load-generator threads run at 100% duty',
    lane: 'contention',
    playbackSettings: { ttsBackendPreference: 'wasm' },
    contention: { cpu: { threads: 12, dutyCycle: 1 } },
    expected: { execution: ['wasm'], outcomes: [OUTCOMES.LOCAL_MODEL], continuity: CONTINUITY },
  }),
  createLaneProfile({
    name: 'contention_gpu50_webgpu',
    label: 'Auto processing while a separate browser runs WebGPU compute at 50% duty',
    lane: 'contention',
    contention: { gpu: { dutyCycle: 0.5 } },
    expected: { execution: ['webgpu'], outcomes: [OUTCOMES.LOCAL_MODEL], continuity: CONTINUITY },
  }),
]);

// Long sessions. The benchmark protocol's target is 60 minutes of continuous
// reading; a shorter configured run is reported as partial, never as complete.
export const SOAK_BOUNDS = Object.freeze({
  targetMs: 60 * 60 * 1000,
  sampleEveryMs: 30_000,
  warmupSamples: 2,
  maxStallMs: 30_000,
  maxPrivateGrowthMiB: 128,
  maxJsHeapGrowthMiB: 32,
});

export const SOAK_TTS_PROBE_PROFILES = Object.freeze([
  createLaneProfile({
    name: 'soak_continuous_webgpu',
    label: 'Continuous reading of a long article, Auto processing',
    lane: 'soak',
    documentTypes: ['soak-article'],
    soak: SOAK_BOUNDS,
    runs: 1,
    expected: { execution: ['webgpu'], outcomes: [OUTCOMES.LOCAL_MODEL], continuity: CONTINUITY },
  }),
  createLaneProfile({
    name: 'soak_continuous_4ecore_wasm',
    label: 'Continuous reading of a long article, 4 host efficiency cores (affinity), CPU / WebAssembly',
    lane: 'soak',
    documentTypes: ['soak-article'],
    navigator: { hardwareConcurrency: 4 },
    playbackSettings: { ttsBackendPreference: 'wasm' },
    enforced: { cpuAffinity: { count: 4, coreClass: 'efficiency' } },
    soak: SOAK_BOUNDS,
    runs: 1,
    expected: { execution: ['wasm'], outcomes: [OUTCOMES.LOCAL_MODEL], continuity: CONTINUITY },
  }),
]);
