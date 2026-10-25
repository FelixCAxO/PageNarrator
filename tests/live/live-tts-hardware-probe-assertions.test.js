import { describe, expect, it } from 'vitest';
import { summarizeAudioTap } from './tts-probe-observations.js';
import {
  expectValidProbeOutput,
  isProbeResultReady,
} from './live-tts-hardware-probe-assertions.js';

function probeOutput(overrides = {}) {
  return {
    profile: {
      name: 'host-browser-hardware',
      simulated: false,
      expectBrowserFallback: false,
      ...(overrides.profile || {}),
    },
    chrome: {
      deviceMemory: 8,
      hardwareConcurrency: 8,
    },
    tts: {
      selectedBackendPlan: {
        device: 'wasm',
        dtype: 'q8',
        reason: 'test',
      },
      modelLoadMs: 12,
      firstSynthesisMs: 120,
      audioDurationSeconds: 1.2,
      realTimeFactor: 0.1,
      sections: [],
      flow: {
        sectionCount: 1,
        loadTransitionCount: 0,
        maxNextSectionReadyGapMs: null,
        maxInterSectionGapMs: null,
        pauseCount: 0,
      },
      fallbackOccurred: false,
      fallbacks: [],
      uxProfileBadge: '',
      preTtsLatency: {
        panelReadyMs: null,
        extractionMs: null,
        firstAudibleMs: null,
      },
      ...(overrides.tts || {}),
    },
  };
}

describe('live TTS hardware probe assertions', () => {
  it('rejects browser fallback for host profiles that are supposed to use Kokoro', () => {
    expect(() => expectValidProbeOutput(probeOutput({
      tts: {
        fallbackOccurred: true,
        firstSynthesisMs: null,
        audioDurationSeconds: null,
        fallbacks: [{ type: 'browser-voice', message: 'Generated speech was too slow.' }],
      },
    }))).toThrow();
  });

  it('allows browser fallback when the selected profile explicitly expects it', () => {
    expect(() => expectValidProbeOutput(probeOutput({
      profile: {
        name: '1gb_1cpu_low_memory',
        simulated: true,
        expectBrowserFallback: true,
      },
      tts: {
        fallbackOccurred: true,
        firstSynthesisMs: null,
        audioDurationSeconds: null,
        fallbacks: [{ type: 'browser-voice', message: 'Generated speech was too slow.' }],
        uxProfileBadge: 'Battery saver',
      },
    }))).not.toThrow();
  });

  it('allows model fallback when Kokoro still synthesizes generated audio', () => {
    expect(() => expectValidProbeOutput(probeOutput({
      tts: {
        fallbackOccurred: true,
        fallbacks: [{
          type: 'model',
          message: 'WebGPU setup failed.',
          fallbackPlan: { device: 'wasm', dtype: 'q8', reason: 'webgpu-load-fallback' },
        }],
      },
    }))).not.toThrow();
  });
});

describe('live TTS hardware probe readiness', () => {
  it('does not stop waiting for a model fallback before Kokoro synthesis', () => {
    expect(isProbeResultReady({
      selectedBackendPlan: { device: 'wasm' },
      firstSynthesisMs: null,
      fallbackOccurred: true,
      fallbacks: [{ type: 'model' }],
      flow: { sectionCount: 0 },
    })).toBe(false);
  });

  it('stops waiting when browser fallback occurs', () => {
    expect(isProbeResultReady({
      selectedBackendPlan: { device: 'wasm' },
      firstSynthesisMs: null,
      fallbackOccurred: true,
      fallbacks: [{ type: 'browser-voice' }],
      flow: { sectionCount: 0 },
    })).toBe(true);
  });

});

describe('first-read media-tap readiness', () => {
  const generated = {
    selectedBackendPlan: { device: 'wasm' },
    firstSynthesisMs: 120,
    sections: [{ audioStartAtMs: 100, audioEndAtMs: null }],
    flow: { sectionCount: 1, audioPlaybackObserved: true },
  };
  const silent = { firstNonSilentEpochMs: null, segments: [], errors: [] };
  const options = (audio = silent, overrides = {}) => ({
    profile: { faults: [] },
    audio: summarizeAudioTap(audio, { clickEpochMs: 20_000 }),
    ...overrides,
  });

  it('keeps polling after playback starts until the tap observes a signal', () => {
    const before = options();
    expect(before.audio.clickToFirstNonSilentMs).toBeNull();
    expect(isProbeResultReady(generated, before)).toBe(false);
    const after = options({ ...silent, firstNonSilentEpochMs: 20_030 });
    expect(after.audio.clickToFirstNonSilentMs).toBe(30);
    expect(isProbeResultReady(generated, after)).toBe(true);
  });

  it('rejects stale signals but accepts a real zero latency without a closed segment', () => {
    const stale = options({ ...silent, firstNonSilentEpochMs: 19_800,
      segments: [{ startEpochMs: 19_800, endEpochMs: 20_100 }] });
    expect(isProbeResultReady(generated, stale)).toBe(false);
    const current = options({ ...silent, firstNonSilentEpochMs: 20_000 });
    expect(current.audio.clickToFirstNonSilentMs).toBe(0);
    expect(isProbeResultReady(generated, current)).toBe(true);
  });

  it('still requires the original synthesis and section-transition observations', () => {
    const measured = options({ ...silent, firstNonSilentEpochMs: 20_030 });
    expect(isProbeResultReady({ ...generated, firstSynthesisMs: null }, measured)).toBe(false);
    const twoSections = { ...generated, sections: [
      { sectionIndex: 0, audioStartAtMs: 100, audioEndAtMs: 1000 },
      { sectionIndex: 1, audioStartAtMs: 1010, audioEndAtMs: null },
    ],
      flow: { sectionCount: 2, loadTransitionCount: 1, measuredTransitionCount: 0, audioPlaybackObserved: true } };
    expect(isProbeResultReady(twoSections, { ...measured, requiredSections: 2 })).toBe(false);
    expect(isProbeResultReady({ ...twoSections, flow: { ...twoSections.flow, measuredTransitionCount: 1 } },
      { ...measured, requiredSections: 2 })).toBe(false);
    twoSections.sections[1].audioEndAtMs = 2000;
    expect(isProbeResultReady({ ...twoSections, flow: { ...twoSections.flow, measuredTransitionCount: 1 } },
      { ...measured, requiredSections: 2 })).toBe(true);
  });

  it('finishes silent ended or idle reads while preserving an unmeasured latency', () => {
    const unmeasured = options();
    expect(isProbeResultReady({ ...generated,
      sections: [{ audioStartAtMs: 100, audioEndAtMs: 500 }] }, unmeasured)).toBe(true);
    expect(isProbeResultReady(generated, { ...unmeasured, readIdle: true })).toBe(true);
    expect(unmeasured.audio.clickToFirstNonSilentMs).toBeNull();
  });

  it('preserves missing-tap and tap-error outcomes without inventing a signal', () => {
    for (const raw of [null, { ...silent, errors: ['connect: capture unavailable'] }]) {
      const unavailable = options(raw);
      expect(isProbeResultReady(generated, unavailable)).toBe(true);
      expect(unavailable.audio.clickToFirstNonSilentMs ?? null).toBeNull();
    }
  });

  it('retains the legacy readiness of lifecycle, soak and fault paths', () => {
    for (const overrides of [
      { profile: { lifecycle: { action: 'stop' } } },
      { profile: { soak: { targetMs: 1_000 } } },
      { profile: { faults: [{ kind: 'webgpu-device-destroyed' }] } },
      { condition: { fault: 'model-download-interrupted' } },
      { condition: { evictCacheBefore: true } },
      { condition: { network: 'offline' } },
    ]) expect(isProbeResultReady(generated, options(silent, overrides))).toBe(true);
    expect(isProbeResultReady(generated)).toBe(true);
  });

  it('retains browser fallback even when generated audio has not started', () => {
    expect(isProbeResultReady({ ...generated, firstSynthesisMs: null,
      fallbacks: [{ type: 'browser-voice' }], flow: { sectionCount: 0 } }, options())).toBe(true);
  });
});
