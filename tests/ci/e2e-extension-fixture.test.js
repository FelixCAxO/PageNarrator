import path from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  buildHardwareProfileStorage,
  getHardwareProfileStorageResetKeys,
  openExtensionPage,
  resolveExtensionDir,
} from '../e2e/extension-fixture.js';
import { LOWER_SPEC_TTS_PROBE_PROFILES } from '../live/live-tts-hardware-profiles.js';

describe('e2e extension fixture helpers', () => {
  it.each([true, false])('opens a reader page when the saved source tab exists=%s', async (exists) => {
    vi.stubGlobal('chrome', {
      storage: { local: { get: async () => ({ readableTabTarget: { tabId: 42 } }) } },
      tabs: {
        get: exists ? vi.fn().mockResolvedValue({ id: 42 }) : vi.fn().mockRejectedValue(new Error('No tab with id: 42.')),
        update: vi.fn().mockResolvedValue({ id: 42 }),
      },
    });
    try {
      const page = { goto: vi.fn().mockResolvedValue() };
      const worker = { url: () => 'chrome-extension://test/worker.js', evaluate: (callback, argument) => callback(argument) };
      await expect(openExtensionPage({ serviceWorkers: () => [worker], newPage: async () => page }, 'readerEngine', '?engine=1')).resolves.toBe(page);
      expect(page.goto).toHaveBeenCalledWith('chrome-extension://test/src/reader-engine.html?engine=1');
      expect(chrome.tabs.update).toHaveBeenCalledTimes(exists ? 1 : 0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('resolves Playwright project extension directories when no explicit override is provided', () => {
    const testInfo = { project: { use: { extensionDir: 'dist' } } };

    expect(resolveExtensionDir({ testInfo, env: {} })).toBe(path.resolve('dist'));
  });

  it('lets an explicit extension directory override project and environment defaults', () => {
    const testInfo = { project: { use: { extensionDir: 'dist' } } };

    expect(resolveExtensionDir({
      extensionDir: 'dist/custom',
      testInfo,
      env: { PN_E2E_EXTENSION_DIR: 'dist/env' },
    })).toBe(path.resolve('dist/custom'));
  });

  it('builds deterministic hardware profile storage from a live probe profile', () => {
    const profile = LOWER_SPEC_TTS_PROBE_PROFILES.find((candidate) => candidate.name === '8gb_4cpu_no_webgpu');

    expect(buildHardwareProfileStorage(profile, {
      enableProbe: true,
      silentTts: true,
    })).toEqual({
      playbackSettings: { ttsPerformanceProfile: 'auto' },
      pagenarratorTtsHardwareProbe: {
        enabled: true,
        profileName: '8gb_4cpu_no_webgpu',
        profileLabel: '8 GB RAM, 4 CPU threads, no exposed WebGPU',
      },
      pnTestHooksEnabled: true,
      pnTestSilentTts: true,
      pnTestRecordFlow: true,
    });
    expect(getHardwareProfileStorageResetKeys()).toEqual(expect.arrayContaining([
      'ttsHardwareProbeSummary',
      'pagenarratorGpuCalibration.v1',
      'pnTestHardwareProfile',
    ]));
    expect(profile).toMatchObject({
      navigator: {
        deviceMemory: 8,
        hardwareConcurrency: 4,
      },
      disableWebGpu: true,
      playbackSettings: {
        ttsPerformanceProfile: 'auto',
      },
    });
  });

  it('supports fake WebGPU adapters for weak-GPU browser profile tests', () => {
    const fixture = readFileSync(new URL('../e2e/extension-fixture.js', import.meta.url), 'utf8');

    expect(fixture).toContain("gpuProfile.mode === 'simulated-adapter'");
    expect(fixture).toContain('requestAdapter: async () =>');
    expect(fixture).toContain('maxStorageBufferBindingSize');
    expect(fixture).toContain('maxBufferSize');
  });

  it('keeps shared e2e startup paths on state waits instead of hard sleeps', () => {
    const fixture = readFileSync(new URL('../e2e/extension-fixture.js', import.meta.url), 'utf8');
    const buildLoad = readFileSync(new URL('../e2e/build-load-no-errors.e2e.js', import.meta.url), 'utf8');
    const pdfFlow = readFileSync(new URL('../e2e/pdf-read.e2e.js', import.meta.url), 'utf8');

    expect(fixture).not.toContain('waitForTimeout');
    expect(buildLoad).not.toContain("from 'node:timers/promises'");
    expect(buildLoad).not.toContain('delay(');
    expect(pdfFlow).not.toContain('waitForTimeout');
  });
});
