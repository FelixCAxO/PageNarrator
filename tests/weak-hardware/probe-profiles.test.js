import { describe, expect, it } from 'vitest';
import { validateProfileEvidence } from '../../scripts/weak-hardware/evidence-contract.mjs';
import { supportsKokoroCpuPool } from '../../src/tts/kokoro/cpu-pool.js';
import {
  CPU_CONSTRAINED_TTS_PROBE_PROFILE_SET,
  GPU_FAULT_TTS_PROBE_PROFILE_SET,
  MEMORY_CONSTRAINED_TTS_PROBE_PROFILE_SET,
  NATIVE_TTS_PROBE_PROFILE_SET,
  PHYSICAL_ADAPTER_TTS_PROBE_PROFILE_SET,
  WEAK_HARDWARE_TTS_PROBE_PROFILE_SET,
  getAllTtsProbeProfiles,
  getTtsProbeProfiles,
} from '../live/live-tts-hardware-profiles.js';

describe('weak-hardware probe profiles', () => {
  it('gives every profile a valid evidence descriptor with stated limitations', () => {
    const problems = getAllTtsProbeProfiles().flatMap((profile) => validateProfileEvidence(profile));

    expect(problems).toEqual([]);
  });

  it('keeps the existing simulated matrices labelled as capability simulation only', () => {
    const simulated = getTtsProbeProfiles('requirements').concat(getTtsProbeProfiles('lower-spec'));

    for (const profile of simulated) {
      expect(profile.evidence.categories).toContain('capability-simulation');
      expect(profile.evidence.enforced).toEqual({});
    }
    expect(getTtsProbeProfiles('8gb_4cpu_intel_iris_xe')[0].evidence.limitations.join(' '))
      .toMatch(/page-level fake; it cannot execute inference/);
  });

  it('defines native WebGPU and explicit CPU baselines on the unrestricted host', () => {
    expect(getTtsProbeProfiles(NATIVE_TTS_PROBE_PROFILE_SET).map((profile) => [profile.name, profile.evidence.categories, profile.expected.execution])).toEqual([
      ['native_webgpu', ['native-host'], ['webgpu']],
      ['native_wasm', ['native-host'], ['wasm']],
    ]);
    expect(getTtsProbeProfiles('native_wasm')[0].playbackSettings.ttsBackendPreference).toBe('wasm');
  });

  it('keeps reported CPU limits separate from the original one- or four-worker inference configuration', () => {
    const lanes = getTtsProbeProfiles(CPU_CONSTRAINED_TTS_PROBE_PROFILE_SET);

    expect(lanes.map((profile) => profile.name)).toEqual([
      'cpu_4ecore_wasm_t4',
      'cpu_4ecore_wasm_t2',
      'cpu_4ecore_wasm_t1',
      'cpu_2ecore_wasm_t2',
      'cpu_1ecore_wasm_t1',
      'cpu_4pcore_wasm_t4',
      'cpu_rate25_wasm',
      'cpu_4ecore_webgpu',
    ]);
    for (const lane of lanes) expect(lane.evidence.categories).toContain('resource-constrained-host');
    expect(getTtsProbeProfiles('cpu_4ecore_wasm_t2')[0]).toMatchObject({
      navigator: { hardwareConcurrency: 2 },
      expectedWasmThreads: 1,
      evidence: { enforced: { cpuAffinity: { count: 4, coreClass: 'efficiency' } } },
    });
    for (const reported of [1, 2, 4]) {
      const [lane] = getTtsProbeProfiles(`cpu_4ecore_wasm_t${reported}`);
      const parallel = supportsKokoroCpuPool({ crossOriginIsolated: true, SharedArrayBuffer, Atomics,
        navigator: { hardwareConcurrency: reported } });
      expect(lane.navigator.hardwareConcurrency).toBe(reported);
      expect(lane.expectedWasmThreads).toBe(parallel ? 4 : 1);
      expect(lane.label).toContain(`${reported} reported logical processor`);
      expect(lane.label).toContain(`${lane.expectedWasmThreads} inference worker`);
    }
    expect(supportsKokoroCpuPool({ crossOriginIsolated: false, SharedArrayBuffer, Atomics,
      navigator: { hardwareConcurrency: 4 } })).toBe(false);
    expect(getTtsProbeProfiles('cpu_rate25_wasm')[0].evidence.categories).toEqual(['resource-constrained-host']);
  });

  it('searches memory boundaries with reproducible outcome categories', () => {
    const lanes = getTtsProbeProfiles(MEMORY_CONSTRAINED_TTS_PROBE_PROFILE_SET);

    expect(lanes.map((profile) => [profile.name, profile.evidence.enforced.browserCommit.bytes / 1024 ** 3])).toEqual([
      ['mem_4gib_webgpu', 4],
      ['mem_2gib_webgpu', 2],
      ['mem_1gib_webgpu', 1],
      ['mem_2gib_wasm', 2],
      ['mem_1gib_wasm', 1],
    ]);
    for (const lane of lanes) {
      expect(lane.expected.requireConsistentOutcome).toBe(true);
      expect(lane.expected.outcomes).toContain('renderer-crashed');
    }
  });

  it('labels GPU faults and latency injection as fault injection with explicit expectations', () => {
    const lanes = getTtsProbeProfiles(GPU_FAULT_TTS_PROBE_PROFILE_SET);

    for (const lane of lanes) {
      expect(lane.evidence.categories).toEqual(['fault-injection']);
      expect(lane.expected.outcomes.length).toBeGreaterThan(0);
    }
    expect(getTtsProbeProfiles('gpu_fault_device_rejects')[0].expected).toMatchObject({
      execution: ['wasm'],
      outcomes: ['permitted-fallback'],
      maxRequestDeviceCalls: 2,
    });
    expect(getTtsProbeProfiles('gpu_latency_250ms')[0].evidence.limitations.join(' ')).toMatch(/synthetic latency injection/);
  });

  it('binds GPU measurements to physical Intel or NVIDIA adapters without claiming a target machine', () => {
    const lanes = getTtsProbeProfiles(PHYSICAL_ADAPTER_TTS_PROBE_PROFILE_SET);

    expect(lanes.map(lane => [lane.name, lane.evidence.selected.gpuAdapter.expectedVendor]))
      .toEqual([['igpu_webgpu', 'intel'], ['dgpu_webgpu', 'nvidia']]);
    for (const lane of lanes) {
      expect(lane.evidence.categories).toEqual(['native-host']);
      expect(lane.expected.execution).toEqual(['webgpu']);
      expect(lane.evidence.reported.webgpu).toBe('host');
      expect(lane.evidence.limitations.join(' ')).toMatch(/not a complete low-end computer/);
    }
  });

  it('accepts comma-separated selections and rejects unknown names', () => {
    expect(getTtsProbeProfiles('native_webgpu, cpu_rate25_wasm').map((profile) => profile.name)).toEqual(['native_webgpu', 'cpu_rate25_wasm']);
    expect(() => getTtsProbeProfiles('native_webgpu,nope')).toThrow('Unknown TTS hardware probe profile: nope');
    expect(getTtsProbeProfiles(WEAK_HARDWARE_TTS_PROBE_PROFILE_SET).length).toBeGreaterThan(15);
  });
});
