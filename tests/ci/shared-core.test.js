import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import {
  chooseArticleExtraction as chooseArticleExtractionFromCore,
} from '../../src/lib/core/article-extraction.js';
import {
  chooseArticleExtraction as chooseArticleExtractionFromLegacyPath,
} from '../../src/lib/article-extraction.js';
import {
  buildReadingModel as buildReadingModelFromCore,
} from '../../src/lib/core/reading-model.js';
import {
  buildReadingModel as buildReadingModelFromLegacyPath,
} from '../../src/lib/reading-model.js';
import {
  getHighlightedWordIndex as getHighlightedWordIndexFromCore,
} from '../../src/lib/core/speech-playback.js';
import {
  getHighlightedWordIndex as getHighlightedWordIndexFromLegacyPath,
} from '../../src/lib/speech-playback.js';
import {
  synthesizeSpeechChunk as synthesizeSpeechChunkFromCore,
} from '../../src/lib/core/speech-audio.js';
import {
  synthesizeSpeechChunk as synthesizeSpeechChunkFromLegacyPath,
} from '../../src/lib/speech-audio.js';

describe('shared core boundary', () => {
  it('exports article extraction from the shared core and keeps the legacy path compatible', () => {
    const dom = new JSDOM(`
      <title>Shared article</title>
      <main>
        <h1>Shared article</h1>
        <p>This article body is long enough to produce a structured reading-model chunk.</p>
      </main>
    `, { url: 'https://example.test/shared' });
    dom.window.getSelection = () => ({ toString: () => '' });

    const result = chooseArticleExtractionFromCore(dom.window.document, {
      articleFallback: { isArticleDocument: () => false, parse: () => null },
    });

    expect(result.source).toBe('reading-model');
    expect(result.url).toBe('https://example.test/shared');
    expect(chooseArticleExtractionFromLegacyPath).toBe(chooseArticleExtractionFromCore);
  });

  it('exports Tier-1 pure-domain modules from core while preserving legacy facades', () => {
    expect(buildReadingModelFromLegacyPath).toBe(buildReadingModelFromCore);
    expect(getHighlightedWordIndexFromLegacyPath).toBe(getHighlightedWordIndexFromCore);
    expect(synthesizeSpeechChunkFromLegacyPath).toBe(synthesizeSpeechChunkFromCore);
  });
});
