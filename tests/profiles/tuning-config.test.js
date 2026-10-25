import { describe, expect, it } from 'vitest';
import { TUNING_CONFIG } from '../../src/lib/tuning-config.js';

describe('central tuning config', () => {
  it('keeps profile, playback, and memory thresholds in one importable object', () => {
    expect(TUNING_CONFIG).toMatchObject({
      ttsProfiles: {
        lowPowerMemoryGb: 2,
        balancedMemoryGb: 8,
        slowModelLoadMs: 20000,
        slowSectionTransitionMs: 2000,
        configs: {
          quality: {
            maxChunkLength: 480,
            targetMinLength: 260,
            preloadAhead: 4,
          },
          balanced: {
            maxChunkLength: 320,
            targetMinLength: 180,
            preloadAhead: 2,
          },
          lowPower: {
            maxChunkLength: 240,
            targetMinLength: 120,
            preloadAhead: 2,
          },
        },
      },
      speechChunking: {
        defaultMaxLength: 480,
        defaultTargetMinLength: 260,
      },
      playback: {
        defaultAudioWatchdogDelayMs: 65000,
        fastPlaybackWatchdogBufferMs: 10000,
        normalPlaybackWatchdogBufferMs: 15000,
        streamSynthesisTimeoutMs: 2500,
      },
      memoryBudgets: {
        lowPowerCorpusRssBytes: 2 * 1024 * 1024 * 1024,
      },
    });
  });
});
