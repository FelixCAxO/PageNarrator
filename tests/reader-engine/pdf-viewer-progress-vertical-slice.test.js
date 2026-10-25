import { describe, expect, it, vi } from 'vitest';
import { createPdfViewerStreamingArticle } from '../../src/lib/pdf-viewer-chunk-stream.js';
import { createPdfViewerMessageHandler } from '../../src/lib/pdf-viewer-message-handler.js';
import { getPanelView } from '../../src/lib/reader-engine-view.js';

describe('PDF viewer progress vertical slice', () => {
  it('routes resume-page metadata from the viewer into the reader UI', async () => {
    const getStreamMetadata = vi.fn(async ({ startPage }) => ({
      ok: true,
      title: 'Mock PDF',
      url: 'https://example.test/mock.pdf',
      pageCount: 8,
      totalReadableWordCount: startPage === 3 ? 120 : 0,
      instanceToken: 'mock-viewer',
    }));
    const viewerHandler = createPdfViewerMessageHandler({ getStreamMetadata });
    const sendMessage = (_tabId, message) => new Promise((resolve) => {
      expect(viewerHandler(message, { id: chrome.runtime.id, url: chrome.runtime.getURL('src/reader-engine.html'), frameId: 0 }, resolve)).toBe(true);
    });

    const article = await createPdfViewerStreamingArticle({
      tab: { id: 12, title: 'Mock PDF' },
      startPage: 3,
      sendMessage,
    });
    const view = getPanelView({
      state: 'reading',
      source: article.source,
      currentChunk: 0,
      totalChunks: 0,
      wordCounts: [],
      totalReadableWordCount: article.totalReadableWordCount,
    });

    expect(getStreamMetadata).toHaveBeenCalledWith({ type: 'getPdfStreamMetadata', startPage: 3 });
    expect(article.startPosition).toMatchObject({ pageNumber: 3 });
    expect(view.remainingLabel).toBe('120 words left');
  });

  it('updates % complete and remaining words as chunks stream in dynamically for large PDFs', async () => {
    // Scenario matching 84 sections and 14,091 words
    const totalWords = 14091;
    const totalSections = 84;
    const wordsPerSection = Math.floor(totalWords / totalSections); // ~167 words per section
    const activeChunkWordCounts = [];

    const readingState = {
      state: 'reading',
      source: 'pdf',
      currentChunk: 0,
      totalChunks: 2,
      wordCounts: activeChunkWordCounts,
      totalReadableWordCount: totalWords,
    };

    // Initially 2 chunks loaded
    activeChunkWordCounts.push(wordsPerSection, wordsPerSection);
    const initialView = getPanelView(readingState);
    expect(initialView.progressPercent).toBe(0);
    expect(initialView.progressLabel).toBe('0% complete');
    expect(initialView.remainingLabel).toBe('14091 words left');

    // Simulate streaming and playback progression
    for (let section = 1; section < totalSections; section += 1) {
      activeChunkWordCounts.push(wordsPerSection);
      readingState.currentChunk = section;
      readingState.totalChunks = activeChunkWordCounts.length;

      const currentView = getPanelView(readingState);
      const expectedCompletedWords = section * wordsPerSection;
      const expectedPercent = Math.round((expectedCompletedWords / totalWords) * 100);
      const expectedRemainingWords = totalWords - expectedCompletedWords;

      expect(currentView.progressPercent).toBe(expectedPercent);
      expect(currentView.progressLabel).toBe(`${expectedPercent}% complete`);
      expect(currentView.remainingLabel).toBe(`${expectedRemainingWords} words left`);
    }

    // At section 42 (halfway through the 84 sections), progress should be ~50%, not stuck at 2%
    readingState.currentChunk = 42;
    const halfwayView = getPanelView(readingState);
    expect(halfwayView.progressPercent).toBe(50);
    expect(halfwayView.progressLabel).toBe('50% complete');
  });
});
