import { describe, expect, it } from 'vitest';
import { createResumePosition, getSavedResumeChunk } from '../../src/lib/resume-position.js';
import { createReadOrchestrator } from '../../src/lib/core/reader-engine-read-orchestrator.js';
import { getResumePositionStorageKey } from '../../src/lib/storage-keys.js';

describe('PDF streaming reading resume & crash recovery', () => {
  const pdfUrl = 'https://example.test/complex-document-184-pages.pdf';
  const totalPages = 184;

  it('records rich resume metadata with pageNumber, anchorId, and progress percentage for streaming PDFs', () => {
    const chunks = [
      { speech: 'Intro on page 1', pageNumber: 1, anchorId: 'pdf-page-1' },
      { speech: 'Undergo thorough verification of traceability requirements on page 141.', pageNumber: 141, anchorId: 'pdf-page-141', domWordOffset: 0 },
      { speech: 'Subsequent section on page 141.', pageNumber: 141, anchorId: 'pdf-page-141', domWordOffset: 12 },
    ];

    const resume = createResumePosition({
      article: {
        title: 'Traceability and System Requirements Spec',
        url: pdfUrl,
        source: 'pdf',
        pageCount: totalPages,
      },
      chunks,
      chunk: 1,
      total: 300,
      now: () => 1788200000000,
    });

    expect(resume).toEqual({
      chunk: 1,
      totalChunks: 300,
      pageNumber: 141,
      anchorId: 'pdf-page-141',
      domWordOffset: 0,
      source: 'pdf',
      progressPercent: 77, // Math.round(141/184 * 100) = 77%
      excerpt: 'Undergo thorough verification of traceability requirements on page 141.',
      title: 'Traceability and System Requirements Spec',
      ts: 1788200000000,
    });
  });

  it('finds and restores the exact saved page and chunk upon reopening or recovering from crash', () => {
    const saved = {
      chunk: 1,
      totalChunks: 300,
      pageNumber: 141,
      anchorId: 'pdf-page-141',
      progressPercent: 77,
      excerpt: 'Undergo thorough verification of traceability requirements on page 141.',
      title: 'Traceability and System Requirements Spec',
    };

    const reloadedChunks = [
      { speech: 'Intro header on page 140', pageNumber: 140, anchorId: 'pdf-page-140' },
      { speech: 'Undergo thorough verification of traceability requirements on page 141.', pageNumber: 141, anchorId: 'pdf-page-141' },
      { speech: 'Next section on page 141', pageNumber: 141, anchorId: 'pdf-page-141' },
    ];

    // Excerpt match locates the exact sentence
    const restoredIndex = getSavedResumeChunk(saved, reloadedChunks);
    expect(restoredIndex).toBe(1);
    expect(reloadedChunks[restoredIndex].pageNumber).toBe(141);
  });

  it('restores by pageNumber/anchorId if the document was re-chunked or text edited', () => {
    const saved = {
      chunk: 10,
      totalChunks: 300,
      pageNumber: 141,
      anchorId: 'pdf-page-141',
      excerpt: 'Old text that was slightly edited',
    };

    const newlyStreamedChunks = [
      { speech: 'Page 139 content', pageNumber: 139, anchorId: 'pdf-page-139' },
      { speech: 'Page 140 content', pageNumber: 140, anchorId: 'pdf-page-140' },
      { speech: 'Page 141 freshly parsed content', pageNumber: 141, anchorId: 'pdf-page-141' },
    ];

    const restoredIndex = getSavedResumeChunk(saved, newlyStreamedChunks);
    expect(restoredIndex).toBe(2);
    expect(newlyStreamedChunks[restoredIndex].pageNumber).toBe(141);
  });

  it('buffers streaming PDF chunks sequentially until target resume chunk is satisfied', async () => {
    const streamChunks = Array.from({ length: 10 }, (_, i) => ({
      speech: `Page chunk ${i + 1}`,
      pageNumber: Math.floor(i / 2) + 140,
      anchorId: `pdf-page-${Math.floor(i / 2) + 140}`,
    }));

    let currentStreamIndex = 0;
    const mockIterator = {
      async next(count = 1) {
        if (currentStreamIndex >= streamChunks.length) return { done: true, value: undefined };
        const size = Math.max(1, count);
        const batch = streamChunks.slice(currentStreamIndex, currentStreamIndex + size);
        currentStreamIndex += batch.length;
        return { done: false, value: batch };
      },
    };

    const state = {
      iterator: mockIterator,
      chunks: [],
      wordCounts: [],
      articleSource: 'pdf',
    };

    const orchestrator = createReadOrchestrator({ state });

    // Target chunk index 5 (Page 142)
    const success = await orchestrator.fillChunkBuffer(5);
    expect(success).toBe(true);
    expect(state.chunks.length).toBeGreaterThanOrEqual(6);
    expect(state.chunks[5].pageNumber).toBe(142);
  });

  it('formats resume storage key for PDF source URLs consistently', () => {
    expect(getResumePositionStorageKey(pdfUrl)).toBe(`pos:${pdfUrl}`);
  });
});
