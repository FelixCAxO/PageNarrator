import { describe, expect, it } from 'vitest';
import { findStartChunkIndex, findStartChunkIndexByText } from '../../src/lib/reading-start.js';

describe('reading start selection', () => {
  it('prefers selected text inside a later split chunk over the shared anchor', () => {
    const chunks = [
      {
        speech: 'The first sentence has enough words to be split.',
        anchorId: 'paragraph-1',
      },
      {
        speech: 'The selected second sentence should start playback here.',
        anchorId: 'paragraph-1',
      },
    ];

    expect(findStartChunkIndex(chunks, {
      anchorId: 'paragraph-1',
      text: 'selected second sentence',
    })).toBe(1);
  });

  it('falls back to a PDF page number when text is unavailable', () => {
    const chunks = [
      { speech: 'Page two opening.', pageNumber: 2 },
      { speech: 'Page three opening.', pageNumber: 3 },
    ];

    expect(findStartChunkIndex(chunks, { pageNumber: 3 })).toBe(1);
  });

  it('returns no text match for tiny snippets that are likely accidental', () => {
    expect(findStartChunkIndexByText(['One two three.'], 'two')).toBe(-1);
  });
});

describe('reading start anchors', () => {
  it('keeps the anchored block when the same text appears earlier', () => {
    const chunks = [
      { speech: 'Please continue the previous answer.', anchorId: 'prompt-1' },
      { speech: 'First answer body.', anchorId: 'answer-1' },
      { speech: 'Please continue the previous answer.', anchorId: 'prompt-2' },
      { speech: 'Second answer body.', anchorId: 'answer-2' },
    ];

    expect(findStartChunkIndex(chunks, {
      anchorId: 'prompt-2',
      text: 'Please continue the previous answer.',
    })).toBe(2);
  });

  it('falls back to text when the anchor is not in the chunks', () => {
    const chunks = [
      { speech: 'Opening paragraph of the page.' },
      { speech: 'The visible paragraph where reading starts.' },
    ];

    expect(findStartChunkIndex(chunks, {
      anchorId: 'missing',
      text: 'The visible paragraph where reading starts.',
    })).toBe(1);
  });
});
