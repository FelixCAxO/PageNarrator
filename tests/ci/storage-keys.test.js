import { describe, expect, it } from 'vitest';
import {
  STORAGE_KEYS,
  getResumePositionStorageKey,
} from '../../src/lib/storage-keys.js';

describe('storage key registry', () => {
  it('centralizes extension storage keys used across settings and probes', () => {
    expect(STORAGE_KEYS).toMatchObject({
      PLAYBACK_SETTINGS: 'playbackSettings',
      FLOATING_READER_PENDING_ACTION: 'floatingReaderPendingAction',
      READABLE_TAB_TARGET: 'readableTabTarget',
      GPU_CALIBRATION_CACHE: 'pagenarratorGpuCalibration.v1',
      TTS_HARDWARE_PROBE_SUMMARY: 'ttsHardwareProbeSummary',
      LOG_LEVEL: 'logLevel',
    });
    expect(Object.isFrozen(STORAGE_KEYS)).toBe(true);
  });

  it('creates stable resume-position keys without leaking a private readerEngine helper', () => {
    expect(getResumePositionStorageKey('https://example.test/article')).toBe('pos:https://example.test/article');
    expect(getResumePositionStorageKey('')).toBe('pos:');
    expect(getResumePositionStorageKey(null)).toBe('pos:');
  });
});
