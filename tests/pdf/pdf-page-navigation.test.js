import { describe, expect, it } from 'vitest';
import {
  createPdfPageNavigation,
  findNextPdfPageStartIndex,
  findPdfPageStartIndex,
  getCurrentPdfPage,
} from '../../src/lib/pdf-page-navigation.js';

describe('PDF page navigation', () => {
  const chunks = [
    { speech: 'Page one opening.', pageNumber: 1 },
    { speech: 'Page one continuation.', pageNumber: 1 },
    { speech: 'Page two opening.', pageNumber: 2 },
    { speech: 'Page four opening after a blank page.', pageNumber: 4 },
  ];

  it('stays hidden unless a PDF is actively being read or paused', () => {
    expect(createPdfPageNavigation({
      source: 'pdf',
      state: 'idle',
      chunks,
      currentChunk: 0,
      pageCount: 4,
    }).visible).toBe(false);

    expect(createPdfPageNavigation({
      source: 'reading-model',
      state: 'reading',
      chunks,
      currentChunk: 0,
      pageCount: 4,
    }).visible).toBe(false);

    expect(createPdfPageNavigation({
      source: 'pdf',
      state: 'paused',
      chunks,
      currentChunk: 2,
      pageCount: 4,
    })).toMatchObject({
      visible: true,
      currentPage: 2,
      firstPage: 1,
      maxPage: 4,
      canJumpFirst: true,
      canSkipCurrentPage: true,
      inputValue: '2',
    });
  });

  it('finds the first chunk for a requested page and the next page after the current chunk', () => {
    expect(getCurrentPdfPage(chunks, 1)).toBe(1);
    expect(getCurrentPdfPage(chunks, 99)).toBe(4);
    expect(findPdfPageStartIndex(chunks, 1)).toBe(0);
    expect(findPdfPageStartIndex(chunks, 4)).toBe(3);
    expect(findPdfPageStartIndex(chunks, 3)).toBeNull();
    expect(findNextPdfPageStartIndex(chunks, 0)).toBe(2);
    expect(findNextPdfPageStartIndex(chunks, 2)).toBe(3);
    expect(findNextPdfPageStartIndex(chunks, 3)).toBeNull();
  });

  it('keeps skip enabled for streamed PDFs when a later page can still be loaded', () => {
    expect(createPdfPageNavigation({
      source: 'pdf',
      state: 'reading',
      chunks: chunks.slice(0, 2),
      currentChunk: 1,
      pageCount: 10,
      canLoadMorePages: true,
    })).toMatchObject({
      visible: true,
      currentPage: 1,
      maxPage: 10,
      canJumpFirst: false,
      canSkipCurrentPage: true,
    });
  });
});
