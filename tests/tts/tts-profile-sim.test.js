import { describe, expect, it } from 'vitest';
import { createTtsPerformanceGovernor } from '../../src/lib/tts-performance-profile.js';
import {
  DEEP_FLOW_TTS_PROBE_PROFILE_SET,
  getTtsProbeProfiles,
} from '../live/live-tts-hardware-profiles.js';

function createNavigatorForProfile(profile) {
  return {
    ...profile.navigator,
    ...(profile.disableWebGpu ? {} : { gpu: {} }),
  };
}

describe('deep-flow TTS profile simulation matrix', () => {
  it.each([
    ['16gb_8cpu_webgpu', 'quality'],
    ['16gb_8cpu_no_webgpu', 'balanced'],
    ['8gb_4cpu_webgpu', 'balanced'],
    ['8gb_4cpu_no_webgpu', 'balanced'],
    ['16gb_2cpu_no_webgpu_low_core', 'lowPower'],
    ['8gb_2cpu_no_webgpu_low_core', 'lowPower'],
    ['4gb_4cpu_webgpu_memory_saver', 'balanced'],
    ['4gb_2cpu_no_webgpu_memory_saver', 'lowPower'],
    ['2gb_2cpu_no_webgpu_memory_saver', 'lowPower'],
    ['1gb_1cpu_no_webgpu_memory_saver', 'lowPower'],
    ['0_5gb_1cpu_no_webgpu_extreme', 'lowPower'],
  ])('resolves %s to %s without a live Chrome probe', (profileName, expectedProfile) => {
    const profile = getTtsProbeProfiles(DEEP_FLOW_TTS_PROBE_PROFILE_SET)
      .find((candidate) => candidate.name === profileName);
    const governor = createTtsPerformanceGovernor({
      setting: profile.playbackSettings.ttsPerformanceProfile,
      navigator: createNavigatorForProfile(profile),
    });

    expect(governor.currentProfile()).toBe(expectedProfile);
    expect(governor.currentConfig().profile).toBe(expectedProfile);
  });
});
