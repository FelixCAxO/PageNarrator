import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { chooseArticleExtraction } from '../../src/lib/article-extraction.js';

describe('article extraction empty result contract', () => {
  it('returns an explicit empty article error when fallback text has no readable content', () => {
    const dom = new JSDOM('<!doctype html><title>Empty</title><body><nav> </nav><script>ignored()</script></body>', {
      url: 'https://example.test/empty',
    });

    const result = chooseArticleExtraction(dom.window.document, {
      articleFallback: {
        isArticleDocument: () => false,
        parse: () => null,
      },
    });

    expect(result).toEqual({
      source: 'empty',
      title: 'Empty',
      text: '',
      chunks: [],
      url: 'https://example.test/empty',
      error: 'No readable article text was found.',
      totalReadableWordCount: 0,
    });
  });
});
