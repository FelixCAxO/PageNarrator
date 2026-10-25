import { describe, expect, it } from 'vitest';
import {
  TTS_PERFORMANCE_PROFILE_DEFAULT,
  createTtsPerformanceGovernor,
  formatTtsPerformanceProfileOptionLabel,
  formatTtsPerformanceProfileTooltip,
  getTtsPerformanceProfileConfig,
  normalizeTtsPerformanceProfile,
  resolveBalancedProfileForBackend,
} from '../../src/lib/tts-performance-profile.js';

describe('TTS performance profiles', () => {
  it('normalizes unsupported profile settings to auto', () => {
    expect(TTS_PERFORMANCE_PROFILE_DEFAULT).toBe('auto');
    expect(normalizeTtsPerformanceProfile('quality')).toBe('quality');
    expect(normalizeTtsPerformanceProfile('balanced')).toBe('balanced');
    expect(normalizeTtsPerformanceProfile('lowPower')).toBe('lowPower');
    expect(normalizeTtsPerformanceProfile('fast')).toBe('auto');
  });

  it('keeps quality chunks large while lowering CPU profile pressure', () => {
    expect(getTtsPerformanceProfileConfig('quality')).toMatchObject({
      maxChunkLength: 480,
      targetMinLength: 260,
      preloadAhead: 4,
      progressiveSegments: false,
    });
    expect(getTtsPerformanceProfileConfig('balanced')).toMatchObject({
      maxChunkLength: 320,
      targetMinLength: 180,
      preloadAhead: 2,
      speechPreloadTimeoutMs: 60_000,
      progressiveSegments: false,
    });
    expect(getTtsPerformanceProfileConfig('lowPower')).toMatchObject({
      maxChunkLength: 240,
      targetMinLength: 120,
      preloadAhead: 2,
      speechPreloadTimeoutMs: 60_000,
      progressiveSegments: true,
    });
  });

  it('keeps balanced WASM fallback on complete preloaded chunks', () => {
    expect(resolveBalancedProfileForBackend({
      backend: 'wasm',
      cpuCount: 4,
    })).toMatchObject({
      profile: 'balanced',
      maxChunkLength: 240,
      targetMinLength: 120,
      preloadAhead: 3,
      progressiveSegments: false,
    });
    expect(resolveBalancedProfileForBackend({
      backend: 'wasm',
      cpuCount: 8,
    }).preloadAhead).toBe(3);
    expect(resolveBalancedProfileForBackend({
      backend: 'webgpu',
      cpuCount: 4,
    }).preloadAhead).toBe(2);
  });

  it('uses balanced mode automatically on 8 GB CPU-only machines while keeping the selected Kokoro path', () => {
    const governor = createTtsPerformanceGovernor({
      setting: 'auto',
      navigator: { deviceMemory: 8, hardwareConcurrency: 4 },
    });

    expect(governor.currentProfile()).toBe('balanced');
    expect(governor.currentConfig()).toMatchObject({
      maxChunkLength: 240,
      preloadAhead: 3,
      progressiveSegments: false,
    });
  });

  it('uses balanced mode automatically on 4 GB four-core machines', () => {
    const governor = createTtsPerformanceGovernor({
      setting: 'auto',
      navigator: { deviceMemory: 4, hardwareConcurrency: 4 },
    });

    expect(governor.currentProfile()).toBe('balanced');
    expect(governor.currentConfig()).toMatchObject({
      maxChunkLength: 240,
      progressiveSegments: false,
    });
  });

  it('uses lowPower automatically on two-core devices regardless of memory or WebGPU visibility', () => {
    for (const navigator of [
      { deviceMemory: 16, hardwareConcurrency: 2 },
      { gpu: {}, deviceMemory: 16, hardwareConcurrency: 2 },
    ]) {
      const governor = createTtsPerformanceGovernor({
        setting: 'auto',
        navigator,
      });

      expect(governor.currentProfile()).toBe('lowPower');
      expect(governor.currentConfig()).toMatchObject({
        maxChunkLength: 240,
        preloadAhead: 2,
        progressiveSegments: true,
      });
    }
  });

  it('uses quality mode automatically when WebGPU is available on a normal-memory device', () => {
    const governor = createTtsPerformanceGovernor({
      setting: 'auto',
      navigator: { gpu: {}, deviceMemory: 16 },
    });

    expect(governor.currentProfile()).toBe('quality');
  });

  it('uses balanced mode automatically for 8 GB WebGPU machines before backend calibration', () => {
    const governor = createTtsPerformanceGovernor({
      setting: 'auto',
      navigator: { gpu: {}, deviceMemory: 8 },
    });

    expect(governor.currentProfile()).toBe('balanced');
    expect(governor.currentConfig()).toMatchObject({
      preloadAhead: 2,
      progressiveSegments: false,
    });
  });

  it('promotes capped-memory auto reads to quality after fast WebGPU calibration', () => {
    const governor = createTtsPerformanceGovernor({
      setting: 'auto',
      navigator: { gpu: {}, deviceMemory: 8, hardwareConcurrency: 24 },
    });

    expect(governor.currentProfile()).toBe('balanced');

    const decision = governor.recordBackendPlan({
      device: 'webgpu',
      reason: 'fast-webgpu',
      cpuBudgetTarget: false,
    });

    expect(decision).toMatchObject({
      changed: true,
      previousProfile: 'balanced',
      nextProfile: 'quality',
      reason: 'fast-webgpu',
    });
    expect(governor.currentProfile()).toBe('quality');
    expect(governor.currentConfig()).toMatchObject({
      maxChunkLength: 480,
      preloadAhead: 4,
      progressiveSegments: false,
    });
  });

  it('keeps capable auto WASM reads on balanced complete chunks', () => {
    const governor = createTtsPerformanceGovernor({
      setting: 'auto',
      navigator: { deviceMemory: 8, hardwareConcurrency: 4 },
    });

    expect(governor.currentProfile()).toBe('balanced');

    const decision = governor.recordBackendPlan({
      device: 'wasm',
      reason: 'no-webgpu',
      cpuBudgetTarget: true,
    });

    expect(decision).toMatchObject({
      changed: false,
      previousProfile: 'balanced',
      nextProfile: 'balanced',
      reason: 'no-webgpu',
    });
    expect(governor.currentProfile()).toBe('balanced');
    expect(governor.currentConfig()).toMatchObject({
      maxChunkLength: 240,
      preloadAhead: 3,
      progressiveSegments: false,
    });
  });

  it('uses CPU-shaped complete chunks when capable auto WebGPU falls back to WASM', () => {
    const governor = createTtsPerformanceGovernor({
      setting: 'auto',
      navigator: { gpu: {}, deviceMemory: 16, hardwareConcurrency: 12 },
    });

    expect(governor.currentProfile()).toBe('quality');

    const decision = governor.recordBackendPlan({
      device: 'wasm',
      reason: 'adapter-unavailable',
      cpuBudgetTarget: true,
    });

    expect(decision).toMatchObject({
      changed: true,
      previousProfile: 'quality',
      nextProfile: 'balanced',
      reason: 'adapter-unavailable',
    });
    expect(governor.currentProfile()).toBe('balanced');
    expect(governor.currentConfig()).toMatchObject({
      maxChunkLength: 240,
      preloadAhead: 3,
      progressiveSegments: false,
    });
  });

  it('keeps explicit quality mode stable even after slow CPU measurements', () => {
    const governor = createTtsPerformanceGovernor({
      setting: 'quality',
      navigator: { deviceMemory: 8 },
    });

    const decision = governor.recordFirstSynthesis({
      synthesisMs: 4200,
      audioDurationSeconds: 2,
    });

    expect(decision).toMatchObject({
      changed: false,
      previousProfile: 'quality',
      nextProfile: 'quality',
      realTimeFactor: 2.1,
    });
    expect(governor.currentProfile()).toBe('quality');
    expect(governor.currentConfig()).toMatchObject({ maxChunkLength: 240, progressiveSegments: false });
  });

  it('adapts quality chunk size when the runtime falls back from GPU to CPU', () => {
    const governor = createTtsPerformanceGovernor({ setting: 'quality', navigator: { gpu: {}, deviceMemory: 16 } });
    governor.recordBackendPlan({ device: 'webgpu', cpuBudgetTarget: false });
    expect(governor.currentConfig().maxChunkLength).toBe(480);
    governor.recordBackendPlan({ device: 'wasm', cpuBudgetTarget: true });
    expect(governor.currentProfile()).toBe('quality');
    expect(governor.currentConfig()).toMatchObject({ maxChunkLength: 240, targetMinLength: 120, preloadAhead: 3, progressiveSegments: false });
  });

  it('keeps auto CPU mode on balanced complete chunks after slow first synthesis', () => {
    const governor = createTtsPerformanceGovernor({
      setting: 'auto',
      navigator: { deviceMemory: 4, hardwareConcurrency: 4 },
    });

    const decision = governor.recordFirstSynthesis({
      synthesisMs: 1900,
      audioDurationSeconds: 2,
    });

    expect(decision).toMatchObject({
      changed: false,
      previousProfile: 'balanced',
      nextProfile: 'balanced',
      realTimeFactor: 0.95,
    });
    expect(governor.currentConfig()).toMatchObject({
      maxChunkLength: 240,
      preloadAhead: 3,
      progressiveSegments: false,
    });
  });

  it('keeps handoff preloads for all TTS performance profiles', () => {
    expect(getTtsPerformanceProfileConfig('quality').preloadAhead).toBeGreaterThanOrEqual(4);
    expect(getTtsPerformanceProfileConfig('balanced').preloadAhead).toBeGreaterThanOrEqual(2);
    expect(getTtsPerformanceProfileConfig('lowPower').preloadAhead).toBeGreaterThanOrEqual(2);
  });

  it('labels auto with the resolved runtime tier and explains the user-visible tradeoffs', () => {
    expect(formatTtsPerformanceProfileOptionLabel('auto', 'balanced')).toBe('Auto - Balanced');
    expect(formatTtsPerformanceProfileOptionLabel('auto', 'lowPower')).toBe('Auto - Battery saver');
    expect(formatTtsPerformanceProfileOptionLabel('quality', 'lowPower')).toBe('High quality');

    expect(formatTtsPerformanceProfileTooltip('lowPower')).toContain('240-character chunks');
    expect(formatTtsPerformanceProfileTooltip('lowPower')).toContain('2 sections preloaded');
    expect(formatTtsPerformanceProfileTooltip('lowPower')).toContain('progressive playback');
    expect(formatTtsPerformanceProfileTooltip('lowPower')).toContain('automatic browser voice switching off');
    expect(formatTtsPerformanceProfileTooltip('balanced')).toContain('automatic browser voice switching off');
    expect(formatTtsPerformanceProfileTooltip('quality')).toContain('automatic browser voice switching off');
  });

  it('keeps auto CPU mode on balanced complete chunks when model load is slow before first audio', () => {
    const governor = createTtsPerformanceGovernor({
      setting: 'auto',
      navigator: { deviceMemory: 4, hardwareConcurrency: 4 },
    });

    const decision = governor.recordModelLoad({ loadMs: 25000 });

    expect(decision).toMatchObject({
      changed: false,
      previousProfile: 'balanced',
      nextProfile: 'balanced',
      reason: 'model-load-ok',
    });
  });

  it('treats weak WebGPU backend plans as CPU adaptation targets without instant downgrade', () => {
    const governor = createTtsPerformanceGovernor({
      setting: 'auto',
      navigator: { gpu: {}, deviceMemory: 8 },
    });

    const backendDecision = governor.recordBackendPlan({
      device: 'wasm',
      reason: 'weak-webgpu',
      cpuBudgetTarget: true,
    });

    expect(backendDecision).toMatchObject({
      changed: false,
      previousProfile: 'balanced',
      nextProfile: 'balanced',
      reason: 'weak-webgpu',
    });

    const decision = governor.recordFirstSynthesis({
      synthesisMs: 1900,
      audioDurationSeconds: 2,
    });

    expect(decision).toMatchObject({
      changed: false,
      previousProfile: 'balanced',
      nextProfile: 'balanced',
      reason: 'first-synthesis-ok',
      realTimeFactor: 0.95,
    });
  });

  it('keeps auto CPU reads on balanced complete chunks after slow section-ready gaps', () => {
    const governor = createTtsPerformanceGovernor({
      setting: 'auto',
      navigator: { deviceMemory: 4, hardwareConcurrency: 4 },
    });

    const first = governor.recordSectionTransition({ nextSectionReadyGapMs: 2400 });
    const second = governor.recordSectionTransition({ nextSectionReadyGapMs: 2600 });

    expect(first).toMatchObject({
      changed: false,
      previousProfile: 'balanced',
      nextProfile: 'balanced',
      slowTransitionCount: 1,
    });
    expect(second).toMatchObject({
      changed: false,
      previousProfile: 'balanced',
      nextProfile: 'balanced',
      reason: 'section-transition-ok',
      slowTransitionCount: 2,
    });
    expect(governor.currentProfile()).toBe('balanced');
    expect(governor.currentConfig()).toMatchObject({
      maxChunkLength: 240,
      preloadAhead: 3,
      progressiveSegments: false,
    });
  });

  it('sub-downgrades explicit balanced reads by shrinking preload without swapping tiers', () => {
    const governor = createTtsPerformanceGovernor({
      setting: 'balanced',
      navigator: { deviceMemory: 8, hardwareConcurrency: 4 },
    });

    expect(governor.currentProfile()).toBe('balanced');
    expect(governor.currentConfig().preloadAhead).toBe(3);

    governor.recordSectionTransition({ nextSectionReadyGapMs: 2400 });
    const decision = governor.recordSectionTransition({ nextSectionReadyGapMs: 2600 });

    expect(decision).toMatchObject({
      changed: true,
      previousProfile: 'balanced',
      nextProfile: 'balanced',
      reason: 'slow-section-transition',
      subDowngrade: 'balanced-preload-ahead-zero',
    });
    expect(governor.currentProfile()).toBe('balanced');
    expect(governor.currentConfig()).toMatchObject({
      profile: 'balanced',
      preloadAhead: 0,
    });
  });

  it('does not demote for configured section pauses or explicit quality reads', () => {
    const balanced = createTtsPerformanceGovernor({
      setting: 'auto',
      navigator: { deviceMemory: 4, hardwareConcurrency: 4 },
    });

    expect(balanced.recordSectionTransition({
      nextSectionReadyGapMs: 2600,
      pauseAppliedMs: 2600,
    })).toMatchObject({
      changed: false,
      nextProfile: 'balanced',
      slowTransitionCount: 0,
    });

    const quality = createTtsPerformanceGovernor({
      setting: 'quality',
      navigator: { deviceMemory: 16, hardwareConcurrency: 4 },
    });

    expect(quality.recordSectionTransition({ nextSectionReadyGapMs: 3000 })).toMatchObject({
      changed: false,
      previousProfile: 'quality',
      nextProfile: 'quality',
    });
  });
});
