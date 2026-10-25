import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TTS_PROBE_PROFILE,
  DEEP_FLOW_TTS_PROBE_PROFILE_SET,
  LOWER_SPEC_TTS_PROBE_PROFILE_SET,
  REQUIREMENTS_TTS_PROBE_PROFILE_SET,
  getExpectedTtsProbeProfileLabel,
  getTtsProbeColdStartBudget,
  getTtsProbeProfiles,
} from './live-tts-hardware-profiles.js';

describe('live TTS hardware probe profiles', () => {
  it('uses the real host browser hardware by default', () => {
    expect(getTtsProbeProfiles()).toEqual([DEFAULT_TTS_PROBE_PROFILE]);
  });

  it('defines supported lower-spec simulated browser profiles with realistic Chrome memory buckets', () => {
    const profiles = getTtsProbeProfiles(LOWER_SPEC_TTS_PROBE_PROFILE_SET);

    expect(profiles).toHaveLength(2);
    expect(profiles.map((profile) => profile.name)).toEqual([
      '8gb_4cpu_no_webgpu',
      '4gb_4cpu_low_memory',
    ]);
    expect(profiles.map((profile) => profile.navigator.deviceMemory)).toEqual([8, 4]);
    expect(profiles.map((profile) => profile.navigator.hardwareConcurrency)).toEqual([4, 4]);
    expect(profiles.every((profile) => profile.simulated)).toBe(true);
  });

  it('can select one named lower-spec simulated profile', () => {
    expect(getTtsProbeProfiles('4gb_4cpu_low_memory')).toEqual([
      expect.objectContaining({
        name: '4gb_4cpu_low_memory',
        simulated: true,
        navigator: {
          deviceMemory: 4,
          hardwareConcurrency: 4,
        },
        evidence: expect.objectContaining({
          selected: { gpuAdapter: expect.objectContaining({ expectedVendor: 'nvidia', mechanism: 'chrome-use-adapter-luid' }) },
        }),
      }),
    ]);
  });

  it('defines a deeper flow matrix with host, WebGPU-visible, and WebGPU-hidden points', () => {
    const profiles = getTtsProbeProfiles(DEEP_FLOW_TTS_PROBE_PROFILE_SET);

    expect(profiles.map((profile) => profile.name)).toEqual([
      'host-browser-hardware',
      '16gb_8cpu_webgpu',
      '16gb_8cpu_no_webgpu',
      '8gb_4cpu_webgpu',
      '8gb_4cpu_no_webgpu',
      '16gb_2cpu_no_webgpu_low_core',
      '8gb_2cpu_no_webgpu_low_core',
      '4gb_4cpu_webgpu_memory_saver',
      '4gb_2cpu_no_webgpu_memory_saver',
      '2gb_2cpu_no_webgpu_memory_saver',
      '1gb_1cpu_no_webgpu_memory_saver',
      '0_5gb_1cpu_no_webgpu_extreme',
    ]);
    expect(profiles.filter((profile) => profile.disableWebGpu)).toHaveLength(8);
    expect(profiles.filter((profile) => !profile.disableWebGpu)).toHaveLength(4);
    expect(profiles[0]).toBe(DEFAULT_TTS_PROBE_PROFILE);
  });

  it('defines requirement-candidate rows for low-end, weak-GPU, and recommended hardware discovery', () => {
    const profiles = getTtsProbeProfiles(REQUIREMENTS_TTS_PROBE_PROFILE_SET);

    expect(profiles.map((profile) => profile.name)).toEqual([
      '2gb_2cpu_no_webgpu_floor',
      '4gb_2cpu_no_webgpu_floor',
      '4gb_4cpu_no_webgpu',
      '4gb_4cpu_4gb_vram_gpu',
      '8gb_4cpu_low_vram_adapter',
      '8gb_4cpu_intel_iris_xe',
      '8gb_4cpu_amd_radeon_780m',
      '8gb_4cpu_no_adapter',
      '8gb_4cpu_integrated_gpu',
      '16gb_8cpu_fast_discrete',
    ]);
    expect(profiles.find((profile) => profile.name === '4gb_4cpu_4gb_vram_gpu')).toMatchObject({
      requirement: {
        candidate: true,
        system: { ramGb: 4, cpuThreads: 4 },
        gpu: {
          mode: 'host',
          vramProxyMb: 4096,
        },
        expected: {
          backend: 'webgpu',
          profileLabel: 'High quality',
          minimumCandidate: true,
        },
      },
    });
    expect(profiles.find((profile) => profile.name === '8gb_4cpu_low_vram_adapter')).toMatchObject({
      requirement: {
        candidate: true,
        system: { ramGb: 8, cpuThreads: 4 },
        gpu: {
          mode: 'simulated-adapter',
          vendor: 'Intel',
          device: 'Intel Iris Xe Graphics',
          vramProxyMb: 256,
          expectedBackendReason: 'webgpu-available',
        },
        expected: {
          backend: 'webgpu',
          profileLabel: 'High quality',
          minimumCandidate: true,
        },
      },
    });
    expect(profiles.find((profile) => profile.name === '16gb_8cpu_fast_discrete')).toMatchObject({
      requirement: {
        candidate: true,
        system: { ramGb: 16, cpuThreads: 8 },
        gpu: {
          mode: 'simulated-adapter',
          vendor: 'NVIDIA',
          expectedBackendReason: 'webgpu-available',
        },
        expected: {
          backend: 'webgpu',
          profileLabel: 'High quality',
          recommendedCandidate: true,
        },
      },
    });
    expect(profiles.find((profile) => profile.name === '8gb_4cpu_low_vram_adapter').navigator.deviceMemory)
      .toBeGreaterThan(4);
  });

  it('can expand profile rows into repeated variance runs', () => {
    const [profile] = getTtsProbeProfiles('8gb_2cpu_no_webgpu_low_core');

    expect(profile.runs).toBe(3);
    expect(profile.biasRuns).toBeGreaterThanOrEqual(3);
  });

  it('declares the user-visible resolved tier for each lower-spec probe profile', () => {
    const labels = Object.fromEntries(
      getTtsProbeProfiles(LOWER_SPEC_TTS_PROBE_PROFILE_SET)
        .map((profile) => [profile.name, getExpectedTtsProbeProfileLabel(profile)]),
    );

    expect(labels).toEqual({
      '8gb_4cpu_no_webgpu': 'Balanced',
      '4gb_4cpu_low_memory': 'Balanced',
    });
  });

  it('treats every lower-spec row as a generated-audio quality contract', () => {
    const profiles = getTtsProbeProfiles(LOWER_SPEC_TTS_PROBE_PROFILE_SET);

    expect(profiles.map((profile) => [profile.name, profile.minProbeSections, profile.expectBrowserFallback])).toEqual([
      ['8gb_4cpu_no_webgpu', 2, false],
      ['4gb_4cpu_low_memory', 2, false],
    ]);
    expect(profiles.some((profile) => profile.forceKokoroFailure)).toBe(false);
  });

  it('treats 8 GB no-WebGPU Auto as a WASM generated-audio setup contract', () => {
    const [profile] = getTtsProbeProfiles('8gb_4cpu_no_webgpu');

    expect(profile.playbackSettings.ttsPerformanceProfile).toBe('auto');
    expect(profile.disableWebGpu).toBe(true);
    expect(getExpectedTtsProbeProfileLabel(profile)).toBe('Balanced');
    expect(profile.expectBrowserFallback).toBe(false);
  });

  it('adds a cold-start profile with panel, extraction, and first-audible budgets', () => {
    const [profile] = getTtsProbeProfiles('cold_start_2gb_2cpu_low_memory');

    expect(profile.coldStart).toBe(true);
    expect(getTtsProbeColdStartBudget(profile)).toEqual({
      panelReadyMs: 1500,
      extractionMs: 2000,
      firstAudibleMs: 60000,
    });
  });

  it('summarizes repeated probe metrics as p50, p95, and max values', async () => {
    const { summarizeTtsProbeRuns } = await import('./live-tts-hardware-profiles.js');
    const summary = summarizeTtsProbeRuns([
      { tts: { firstSynthesisMs: 3000, flow: { maxNextSectionReadyGapMs: 1000 } } },
      { tts: { firstSynthesisMs: 1000, fallbackOccurred: true, flow: { maxNextSectionReadyGapMs: 3000 } } },
      { tts: { firstSynthesisMs: 2000, flow: { maxNextSectionReadyGapMs: 2000 } } },
    ]);

    expect(summary).toEqual({
      runs: 3,
      fallbackRuns: 1,
      metrics: {
        firstSynthesisMs: { p50: 2000, p95: 3000, max: 3000 },
        maxNextSectionReadyGapMs: { p50: 2000, p95: 3000, max: 3000 },
        maxInterSectionGapMs: { p50: null, p95: null, max: null },
      },
    });
  });

  it('keeps missing probe metrics as missing instead of converting nulls to zero', async () => {
    const { summarizeProbeBudgetFailures, summarizeTtsProbeRuns } = await import('./live-tts-hardware-profiles.js');
    const expectedFallbackProfile = { ...getTtsProbeProfiles('8gb_4cpu_no_webgpu')[0], expectBrowserFallback: true };
    const kokoroProfile = { ...getTtsProbeProfiles('4gb_4cpu_low_memory')[0], expectBrowserFallback: false };
    const summary = summarizeTtsProbeRuns([
      { tts: { firstSynthesisMs: null, fallbackOccurred: true, flow: { maxNextSectionReadyGapMs: null, maxInterSectionGapMs: null } } },
      { tts: { firstSynthesisMs: null, fallbackOccurred: true, flow: { maxNextSectionReadyGapMs: null, maxInterSectionGapMs: null } } },
    ]);

    expect(summary.metrics.firstSynthesisMs).toEqual({ p50: null, p95: null, max: null });
    expect(summarizeProbeBudgetFailures(expectedFallbackProfile, summary)).toEqual([]);
    expect(summarizeProbeBudgetFailures(kokoroProfile, summary)).toEqual([
      expect.objectContaining({
        profileName: '4gb_4cpu_low_memory',
        metric: 'firstSynthesisMs.p95',
        reason: 'missing',
      }),
    ]);
  });

  it('records the runtime fallback reason for the no-WebGPU candidate', () => {
    const [profile] = getTtsProbeProfiles('8gb_4cpu_no_webgpu');

    expect(profile.gpu.expectedBackendReason).toBe('no-webgpu');
  });

  it('rejects unknown profile names instead of silently running the wrong hardware profile', () => {
    expect(() => getTtsProbeProfiles('does-not-exist')).toThrow(/Unknown TTS hardware probe profile/);
  });
});
