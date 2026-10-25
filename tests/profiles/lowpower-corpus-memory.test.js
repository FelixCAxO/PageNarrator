import { describe, expect, it } from 'vitest';
import { TUNING_CONFIG } from '../../src/lib/tuning-config.js';
import { getTtsPerformanceProfileConfig } from '../../src/lib/tts-performance-profile.js';
import {
  profileMemorySteps,
  readRuntimeMemoryUsage,
} from '../../scripts/memory-usage-profile.mjs';
import {
  createMemoryProfileArticleHtml,
  createReaderPipelineMemoryProfileSteps,
} from '../../scripts/profile-memory-usage.mjs';

describe('lowPower corpus memory budget', () => {
  it('keeps a 600-paragraph lowPower reader pipeline under the release RSS budget contract', async () => {
    const profile = getTtsPerformanceProfileConfig('lowPower');
    const state = {};

    try {
      const reports = await profileMemorySteps(createReaderPipelineMemoryProfileSteps({
        html: createMemoryProfileArticleHtml({ paragraphCount: 600 }),
        maxChunkLength: profile.maxChunkLength,
        targetMinLength: profile.targetMinLength,
      }, state), {
        readMemoryUsage: () => readRuntimeMemoryUsage({ performance: {}, process }),
        forceGarbageCollection: globalThis.gc,
      });
      const finalRssBytes = reports.at(-1)?.rssAfterBytes;

      expect(state.speechChunks.length).toBeGreaterThan(100);
      expect(finalRssBytes).toBeLessThan(TUNING_CONFIG.memoryBudgets.lowPowerCorpusRssBytes);
    } finally {
      state.dom?.window?.close();
    }
  });
});
