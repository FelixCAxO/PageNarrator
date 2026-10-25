import { describe, expect, it } from 'vitest';
import {
  createResumePosition,
  getSavedResumeChunk,
} from '../../src/lib/resume-position.js';

describe('resume position helpers', () => {
  const chunks = [
    { speech: 'Opening context before the saved position.' },
    { speech: 'The original saved paragraph starts here and carries the important anchor text.' },
    { speech: 'A later paragraph follows the saved point.' },
  ];

  it('stores a visible, text-backed resume object', () => {
    expect(createResumePosition({
      article: { title: 'Long guide' },
      chunks,
      chunk: 1,
      total: 3,
      now: () => 1700000000000,
    })).toEqual({
      chunk: 1,
      totalChunks: 3,
      progressPercent: 33,
      excerpt: 'The original saved paragraph starts here and carries the important anchor text.',
      title: 'Long guide',
      ts: 1700000000000,
    });
  });

  it('restores exact chunk positions when the section count is unchanged', () => {
    const saved = createResumePosition({
      article: { title: 'Long guide' },
      chunks,
      chunk: 1,
      total: 3,
    });

    expect(getSavedResumeChunk(saved, chunks)).toBe(1);
  });

  it('starts from the top when the text changed but the section count did not', () => {
    const saved = createResumePosition({ article: { title: 'Live page' }, chunks, chunk: 1, total: 3 });
    const replacedChunks = [
      { speech: 'Fresh headline published after the last visit.' },
      { speech: 'An unrelated update replaced the paragraph that was saved.' },
      { speech: 'Another new paragraph closes the updated page.' },
    ];

    expect(getSavedResumeChunk(saved, replacedChunks)).toBe(0);
    // Short excerpts cannot be checked, so the saved index is still trusted.
    expect(getSavedResumeChunk({ chunk: 1, totalChunks: 3, excerpt: 'Intro' }, replacedChunks)).toBe(1);
  });

  it('falls back to excerpt matching when minor page edits change the section count', () => {
    const saved = createResumePosition({
      article: { title: 'Long guide' },
      chunks,
      chunk: 1,
      total: 3,
    });
    const editedChunks = [
      'New intro inserted after publication.',
      chunks[0],
      chunks[1],
      chunks[2],
    ];

    expect(getSavedResumeChunk(saved, editedChunks)).toBe(2);
  });

  it('ignores invalid or completed resume positions', () => {
    expect(getSavedResumeChunk(null, chunks)).toBe(0);
    expect(getSavedResumeChunk({ chunk: 3, totalChunks: 3 }, chunks)).toBe(0);
    expect(createResumePosition({ chunks, chunk: 0, total: 3 })).toBeNull();
  });
});
