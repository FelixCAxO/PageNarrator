import { NATIVE_TTS_PROBE_PROFILES, CPU_CONSTRAINED_TTS_PROBE_PROFILES, MEMORY_CONSTRAINED_TTS_PROBE_PROFILES, GPU_FAULT_TTS_PROBE_PROFILES, PHYSICAL_ADAPTER_TTS_PROBE_PROFILES } from './tts-probe-profile-resources.js';
import { CACHE_TTS_PROBE_PROFILES, CACHE_FAULT_TTS_PROBE_PROFILES } from './tts-probe-profile-cache.js';
import { PLAYBACK_TTS_PROBE_PROFILES, LIFECYCLE_TTS_PROBE_PROFILES, CONTENTION_TTS_PROBE_PROFILES, SOAK_TTS_PROBE_PROFILES } from './tts-probe-profile-lifecycle.js';
import { LOWER_SPEC_TTS_PROBE_PROFILES, DEEP_FLOW_TTS_PROBE_PROFILES, REQUIREMENTS_TTS_PROBE_PROFILES, DEFAULT_TTS_PROBE_PROFILE, COLD_START_TTS_PROBE_PROFILES } from './tts-probe-profile-simulated.js';

export const LOWER_SPEC_TTS_PROBE_PROFILE_SET = 'lower-spec';

export const DEEP_FLOW_TTS_PROBE_PROFILE_SET = 'deep-flow';

export const REQUIREMENTS_TTS_PROBE_PROFILE_SET = 'requirements';

export const NATIVE_TTS_PROBE_PROFILE_SET = 'native';

export const CPU_CONSTRAINED_TTS_PROBE_PROFILE_SET = 'cpu-constrained';

export const MEMORY_CONSTRAINED_TTS_PROBE_PROFILE_SET = 'memory-constrained';

export const GPU_FAULT_TTS_PROBE_PROFILE_SET = 'gpu-faults';

export const PHYSICAL_ADAPTER_TTS_PROBE_PROFILE_SET = 'physical-adapter';

export const CACHE_TTS_PROBE_PROFILE_SET = 'cache';

export const CACHE_FAULT_TTS_PROBE_PROFILE_SET = 'cache-faults';

export const PLAYBACK_TTS_PROBE_PROFILE_SET = 'playback';

export const LIFECYCLE_TTS_PROBE_PROFILE_SET = 'lifecycle';

export const CONTENTION_TTS_PROBE_PROFILE_SET = 'contention';

export const SOAK_TTS_PROBE_PROFILE_SET = 'soak';

export const WEAK_HARDWARE_TTS_PROBE_PROFILE_SET = 'weak-hardware';

export const WEAK_HARDWARE_TTS_PROBE_PROFILES = Object.freeze([
  ...NATIVE_TTS_PROBE_PROFILES,
  ...CPU_CONSTRAINED_TTS_PROBE_PROFILES,
  ...MEMORY_CONSTRAINED_TTS_PROBE_PROFILES,
  ...GPU_FAULT_TTS_PROBE_PROFILES,
  ...CACHE_TTS_PROBE_PROFILES,
  ...CACHE_FAULT_TTS_PROBE_PROFILES,
  ...PLAYBACK_TTS_PROBE_PROFILES,
  ...LIFECYCLE_TTS_PROBE_PROFILES,
  ...CONTENTION_TTS_PROBE_PROFILES,
  ...SOAK_TTS_PROBE_PROFILES,
  ...PHYSICAL_ADAPTER_TTS_PROBE_PROFILES,
]);

const PROFILE_SETS = Object.freeze({
  [LOWER_SPEC_TTS_PROBE_PROFILE_SET]: LOWER_SPEC_TTS_PROBE_PROFILES,
  [DEEP_FLOW_TTS_PROBE_PROFILE_SET]: DEEP_FLOW_TTS_PROBE_PROFILES,
  [REQUIREMENTS_TTS_PROBE_PROFILE_SET]: REQUIREMENTS_TTS_PROBE_PROFILES,
  [NATIVE_TTS_PROBE_PROFILE_SET]: NATIVE_TTS_PROBE_PROFILES,
  [CPU_CONSTRAINED_TTS_PROBE_PROFILE_SET]: CPU_CONSTRAINED_TTS_PROBE_PROFILES,
  [MEMORY_CONSTRAINED_TTS_PROBE_PROFILE_SET]: MEMORY_CONSTRAINED_TTS_PROBE_PROFILES,
  [GPU_FAULT_TTS_PROBE_PROFILE_SET]: GPU_FAULT_TTS_PROBE_PROFILES,
  [PHYSICAL_ADAPTER_TTS_PROBE_PROFILE_SET]: PHYSICAL_ADAPTER_TTS_PROBE_PROFILES,
  [CACHE_TTS_PROBE_PROFILE_SET]: CACHE_TTS_PROBE_PROFILES,
  [CACHE_FAULT_TTS_PROBE_PROFILE_SET]: CACHE_FAULT_TTS_PROBE_PROFILES,
  [PLAYBACK_TTS_PROBE_PROFILE_SET]: PLAYBACK_TTS_PROBE_PROFILES,
  [LIFECYCLE_TTS_PROBE_PROFILE_SET]: LIFECYCLE_TTS_PROBE_PROFILES,
  [CONTENTION_TTS_PROBE_PROFILE_SET]: CONTENTION_TTS_PROBE_PROFILES,
  [SOAK_TTS_PROBE_PROFILE_SET]: SOAK_TTS_PROBE_PROFILES,
  [WEAK_HARDWARE_TTS_PROBE_PROFILE_SET]: WEAK_HARDWARE_TTS_PROBE_PROFILES,
});

export function getAllTtsProbeProfiles() {
  const byName = new Map();
  for (const profile of [
    DEFAULT_TTS_PROBE_PROFILE,
    ...LOWER_SPEC_TTS_PROBE_PROFILES,
    ...REQUIREMENTS_TTS_PROBE_PROFILES,
    ...DEEP_FLOW_TTS_PROBE_PROFILES,
    ...COLD_START_TTS_PROBE_PROFILES,
    ...WEAK_HARDWARE_TTS_PROBE_PROFILES,
  ]) {
    if (!byName.has(profile.name)) byName.set(profile.name, profile);
  }
  return [...byName.values()];
}

export function getTtsProbeProfiles(selection = '') {
  const value = String(selection || '').trim();
  if (!value || value === 'host' || value === DEFAULT_TTS_PROBE_PROFILE.name) {
    return [DEFAULT_TTS_PROBE_PROFILE];
  }
  if (PROFILE_SETS[value]) return PROFILE_SETS[value];

  // Comma lists may mix profile names and set names; duplicates are dropped.
  const names = value.split(',').map((name) => name.trim()).filter(Boolean);
  const unknown = [];
  const profiles = [];
  for (const name of names) {
    const matches = PROFILE_SETS[name] || [getAllTtsProbeProfiles().find((candidate) => candidate.name === name)].filter(Boolean);
    if (!matches.length) unknown.push(name);
    for (const profile of matches) if (!profiles.includes(profile)) profiles.push(profile);
  }
  if (!unknown.length && profiles.length) return profiles;

  throw new Error(`Unknown TTS hardware probe profile: ${unknown.join(', ') || value}`);
}

export function getExpectedTtsProbeProfileLabel(profile = {}) {
  if (!profile?.simulated) return null;
  const memory = Number(profile?.navigator?.deviceMemory);
  const cores = Number(profile?.navigator?.hardwareConcurrency);
  if (Number.isFinite(cores) && cores <= 2) return 'Battery saver';
  if (Number.isFinite(memory) && memory <= 2) return 'Battery saver';
  if (profile?.disableWebGpu && Number.isFinite(memory) && memory >= 4) return 'Balanced';
  if (Number.isFinite(memory) && memory >= 16) return 'High quality';
  if (Number.isFinite(memory) && memory >= 4) return 'Balanced';
  return 'Battery saver';
}

export { DEFAULT_TTS_PROBE_PROFILE, LOWER_SPEC_TTS_PROBE_PROFILES, COLD_START_TTS_PROBE_PROFILES, REQUIREMENTS_TTS_PROBE_PROFILES, DEEP_FLOW_TTS_PROBE_PROFILES } from './tts-probe-profile-simulated.js';

export { OUTCOMES, NATIVE_TTS_PROBE_PROFILES, CPU_CONSTRAINED_TTS_PROBE_PROFILES, MEMORY_CONSTRAINED_TTS_PROBE_PROFILES, GPU_FAULT_TTS_PROBE_PROFILES, PHYSICAL_ADAPTER_TTS_PROBE_PROFILES } from './tts-probe-profile-resources.js';

export { PLAYBACK_TTS_PROBE_PROFILES, LIFECYCLE_BOUNDS, LIFECYCLE_TTS_PROBE_PROFILES, CONTENTION_TTS_PROBE_PROFILES, SOAK_BOUNDS, SOAK_TTS_PROBE_PROFILES } from './tts-probe-profile-lifecycle.js';

export { CACHE_TTS_PROBE_PROFILES, CACHE_FAULT_TTS_PROBE_PROFILES } from './tts-probe-profile-cache.js';

export { getTtsProbeColdStartBudget, summarizeTtsProbeRuns, getTtsProbeLatencyBudget, summarizeProbeBudgetFailures } from './tts-probe-profile-metrics.js';
