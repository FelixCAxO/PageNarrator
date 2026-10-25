import { describe, expect, it } from 'vitest';
import { TUNING_CONFIG } from '../../src/lib/tuning-config.js';
import { compactCompletedPdfChunks } from '../../src/lib/reader-engine-read-lifecycle.js';
import {
  createReadingQueueWindow,
  createTranscriptWindow,
  getChunkWordCounts,
} from '../../src/lib/reader-engine-view.js';

function createLongPdfChunks(count = 1000) {
  return Array.from({ length: count }, (_, index) => ({
    type: 'pdf-page',
    speech: `Page ${index + 1} ${'long textbook paragraph '.repeat(80)}`,
    text: `Page ${index + 1} ${'long textbook paragraph '.repeat(80)}`,
    pageNumber: index + 1,
    anchorId: `pdf-page-${index + 1}`,
  }));
}

describe('long-session memory profile', () => {
  it('keeps repeated long PDF queue renders inside the retained heap budget', async () => {
    expect(typeof globalThis.gc, 'profiles lane must run with --expose-gc (vitest.profiles.config.js)').toBe('function');

    globalThis.gc();
    const baseline = process.memoryUsage().heapUsed;

    for (let run = 0; run < 10; run += 1) {
      const chunks = compactCompletedPdfChunks(createLongPdfChunks(), {
        source: 'pdf',
        currentIndex: 999,
        keepFullChunkHistoryLimit: 100,
      });
      const wordCounts = getChunkWordCounts(chunks);
      createTranscriptWindow(chunks.map((chunk) => chunk.preview || chunk.speech).join('\n\n'), { limit: 30 });
      createReadingQueueWindow(chunks, 999, { windowSize: 10 });
      createReadingQueueWindow(chunks, 999, { query: 'page 990' });

      expect(wordCounts).toHaveLength(chunks.length);
      expect(chunks.filter((chunk) => chunk.compact)).toHaveLength(998);
    }

    globalThis.gc();
    const retainedHeapBytes = Math.max(0, process.memoryUsage().heapUsed - baseline);

    expect(retainedHeapBytes).toBeLessThan(TUNING_CONFIG.memoryBudgets.longSessionRetainedHeapBytes);
  });
});
