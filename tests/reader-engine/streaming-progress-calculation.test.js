import { describe, expect, it } from 'vitest';
import {
  getChunkWordCounts,
  getPanelView,
} from '../../src/lib/reader-engine-view.js';

describe('Progress and % completed calculation for articles and PDFs', () => {
  describe('Articles', () => {
    it('calculates progress accurately across varying chunk sizes for web articles', () => {
      const chunks = [
        { speech: 'First short section.' },
        { speech: 'Second section with considerably more words to read out loud.' },
        { speech: 'Third medium length section.' },
        { speech: 'Final brief conclusion.' },
      ];
      const wordCounts = getChunkWordCounts(chunks);
      const totalWords = 20;

      expect(wordCounts).toEqual([3, 10, 4, 3]);

      // At start (reading chunk 0)
      const view0 = getPanelView({
        state: 'reading',
        currentChunk: 0,
        totalChunks: 4,
        wordCounts,
        totalReadableWordCount: totalWords,
        source: 'article',
      });
      expect(view0.progressPercent).toBe(0);
      expect(view0.progressLabel).toBe('0% complete');
      expect(view0.remainingLabel).toBe('20 words left');

      // After chunk 0 completes (reading chunk 1)
      const view1 = getPanelView({
        state: 'reading',
        currentChunk: 1,
        totalChunks: 4,
        wordCounts,
        totalReadableWordCount: totalWords,
        source: 'article',
      });
      expect(view1.progressPercent).toBe(15);
      expect(view1.progressLabel).toBe('15% complete');
      expect(view1.remainingLabel).toBe('17 words left');

      // After chunk 1 completes (reading chunk 2)
      const view2 = getPanelView({
        state: 'reading',
        currentChunk: 2,
        totalChunks: 4,
        wordCounts,
        totalReadableWordCount: totalWords,
        source: 'article',
      });
      expect(view2.progressPercent).toBe(65);
      expect(view2.progressLabel).toBe('65% complete');
      expect(view2.remainingLabel).toBe('7 words left');

      // After chunk 2 completes (reading chunk 3)
      const view3 = getPanelView({
        state: 'reading',
        currentChunk: 3,
        totalChunks: 4,
        wordCounts,
        totalReadableWordCount: totalWords,
        source: 'article',
      });
      expect(view3.progressPercent).toBe(85);
      expect(view3.progressLabel).toBe('85% complete');
      expect(view3.remainingLabel).toBe('3 words left');

      // Finished state
      const viewFinished = getPanelView({
        state: 'finished',
        currentChunk: 3,
        totalChunks: 4,
        wordCounts,
        totalReadableWordCount: totalWords,
        source: 'article',
      });
      expect(viewFinished.progressPercent).toBe(100);
      expect(viewFinished.progressLabel).toBe('100% complete');
    });

    it('handles selected-text reading with weighted word progress', () => {
      const chunks = [
        { speech: 'Selected opening phrase.' },
        { speech: 'Selected detailed paragraph with additional commentary and explanation.' },
      ];
      const wordCounts = getChunkWordCounts(chunks);
      expect(wordCounts).toEqual([3, 8]);

      const pausedView = getPanelView({
        state: 'paused',
        source: 'selection',
        currentChunk: 1,
        totalChunks: 2,
        wordCounts,
        totalReadableWordCount: 11,
      });

      expect(pausedView.progressPercent).toBe(27); // 3 / 11 = 27.27% -> 27%
      expect(pausedView.progressLabel).toBe('27% complete');
      expect(pausedView.remainingLabel).toBe('8 words left');
      expect(pausedView.subtitle).toBe('Selected text paused');
    });

    it('falls back gracefully when totalReadableWordCount is 0 or omitted', () => {
      const wordCounts = [50, 50, 50, 50];
      const view = getPanelView({
        state: 'reading',
        currentChunk: 2,
        totalChunks: 4,
        wordCounts,
        totalReadableWordCount: 0,
      });

      expect(view.progressPercent).toBe(50);
      expect(view.progressLabel).toBe('50% complete');
      expect(view.remainingLabel).toBe('100 words left');
    });
  });

  describe('PDFs & Streaming Documents', () => {
    it('accurately tracks progress across 84 streaming chunks on a 14,091-word PDF without getting stuck', () => {
      const totalWords = 14091;
      const chunksCount = 84;
      const baseChunkWords = Math.floor(totalWords / chunksCount);
      const remainder = totalWords - baseChunkWords * chunksCount;
      const wordCounts = [];

      for (let i = 0; i < chunksCount; i += 1) {
        wordCounts.push(baseChunkWords + (i < remainder ? 1 : 0));
      }
      expect(wordCounts.reduce((a, b) => a + b, 0)).toBe(totalWords);

      const streamingWordCounts = [wordCounts[0], wordCounts[1]];
      const reading = {
        state: 'reading',
        source: 'pdf',
        currentChunk: 0,
        totalChunks: 2,
        wordCounts: streamingWordCounts,
        totalReadableWordCount: totalWords,
      };

      expect(getPanelView(reading).progressPercent).toBe(0);
      expect(getPanelView(reading).progressLabel).toBe('0% complete');
      expect(getPanelView(reading).remainingLabel).toBe('14091 words left');

      let previousPercent = 0;
      let previousRemaining = totalWords;

      for (let chunkIdx = 1; chunkIdx < chunksCount; chunkIdx += 1) {
        if (chunkIdx + 1 < chunksCount) {
          streamingWordCounts.push(wordCounts[chunkIdx + 1]);
        }
        reading.currentChunk = chunkIdx;
        reading.totalChunks = streamingWordCounts.length;

        const view = getPanelView(reading);
        expect(view.progressPercent).toBeGreaterThanOrEqual(previousPercent);
        expect(Number.parseInt(view.remainingLabel, 10)).toBeLessThanOrEqual(previousRemaining);

        previousPercent = view.progressPercent;
        previousRemaining = Number.parseInt(view.remainingLabel, 10);
      }

      reading.currentChunk = 21;
      expect(getPanelView(reading).progressPercent).toBe(25);

      reading.currentChunk = 42;
      expect(getPanelView(reading).progressPercent).toBe(50);

      reading.currentChunk = 63;
      expect(getPanelView(reading).progressPercent).toBe(75);

      reading.currentChunk = 83;
      expect(getPanelView(reading).progressPercent).toBe(99);
      expect(Number.parseInt(getPanelView(reading).remainingLabel, 10)).toBeLessThan(200);

      reading.state = 'finished';
      expect(getPanelView(reading).progressPercent).toBe(100);
      expect(getPanelView(reading).progressLabel).toBe('100% complete');
    });

    it('reuses cached prefix sums for static word count arrays while updating when arrays grow', () => {
      const wordCounts = [10, 20, 30];

      const reading = {
        state: 'reading',
        currentChunk: 1,
        totalChunks: 3,
        wordCounts,
        totalReadableWordCount: 60,
      };

      const view1 = getPanelView(reading);
      expect(view1.progressPercent).toBe(17);

      const view2 = getPanelView(reading);
      expect(view2.progressPercent).toBe(17);

      wordCounts.push(40, 50);
      reading.totalChunks = 5;
      reading.currentChunk = 3;
      reading.totalReadableWordCount = 150;

      const view3 = getPanelView(reading);
      expect(view3.progressPercent).toBe(40);
      expect(view3.remainingLabel).toBe('90 words left');
    });
  });
});
