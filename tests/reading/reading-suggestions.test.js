import { describe, expect, it } from 'vitest';
import {
  createCodeCleanupSuggestion,
  getCodeDensity,
} from '../../src/lib/reading-suggestions.js';

describe('reading suggestions', () => {
  it('measures code density from structured chunks', () => {
    expect(getCodeDensity([
      { type: 'paragraph', speech: 'Intro text.' },
      { type: 'code', speech: 'const answer equals forty two' },
      { type: 'code', speech: 'return answer' },
      'Plain string chunk',
    ])).toBe(0.5);
  });

  it('suggests code cleanup when dense code would make narration noisy', () => {
    const suggestion = createCodeCleanupSuggestion({
      skipCodeSnippets: false,
      chunks: [
        { type: 'paragraph', speech: 'Developer tutorial intro.' },
        { type: 'code', speech: Array.from({ length: 170 }, (_, index) => `token${index}`).join(' ') },
      ],
    });

    expect(suggestion).toEqual({
      visible: true,
      title: 'Skip code snippets?',
      detail: 'This page has many code snippets. Skip about 1 min of code for smoother narration.',
      estimatedMinutes: 1,
    });
  });

  it('stays hidden when cleanup is already enabled', () => {
    const chunks = [
      { type: 'code', speech: 'const example = true' },
      { type: 'paragraph', speech: 'Explanation.' },
    ];

    expect(createCodeCleanupSuggestion({ skipCodeSnippets: true, chunks }).visible).toBe(false);
  });
});
