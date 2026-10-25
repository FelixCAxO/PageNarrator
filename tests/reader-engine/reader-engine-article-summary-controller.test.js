import { describe, expect, it, vi } from 'vitest';

import { createReaderEngineArticleSummaryController } from '../../src/lib/reader-engine-article-summary-controller.js';

function createElement(initial = {}) {
  return {
    hidden: false,
    textContent: '',
    ...initial,
  };
}

function createEls(overrides = {}) {
  return {
    title: createElement(),
    readingTitle: createElement(),
    meta: createElement(),
    mode: createElement(),
    body: createElement(),
    resumePrompt: createElement(),
    resumeTitle: createElement(),
    resumeDetail: createElement(),
    resumeExcerpt: createElement(),
    codeSuggestion: createElement(),
    codeSuggestionTitle: createElement(),
    codeSuggestionDetail: createElement(),
    ...overrides,
  };
}

function createController({
  els = createEls(),
  articleSummary = {
    title: 'Readable Title',
    metaText: '8 min read',
    modeLabel: 'Article',
    previewText: 'Clean preview',
  },
  resumePrompt = {
    visible: true,
    title: 'Resume',
    detail: 'Continue where you stopped',
    excerpt: 'The saved excerpt',
  },
  state = { activeChunks: ['a', 'b'], currentChunk: 1 },
} = {}) {
  const renderTranscript = vi.fn();
  const renderQueue = vi.fn();
  const getInitialPreview = vi.fn(() => 'Fallback preview');
  const createArticleSummary = vi.fn(() => articleSummary);
  const createResumePrompt = vi.fn(() => resumePrompt);

  const controller = createReaderEngineArticleSummaryController({
    els,
    renderTranscript,
    renderQueue,
    getInitialPreview,
    createArticleSummary,
    createResumePrompt,
    getState: () => state,
  });

  return {
    controller,
    els,
    renderTranscript,
    renderQueue,
    getInitialPreview,
    createArticleSummary,
    createResumePrompt,
  };
}

describe('createReaderEngineArticleSummaryController', () => {
  it('sets article summary fields and refreshes transcript and queue from current state', () => {
    const article = {
      title: 'Source Title',
      text: 'Article body',
      source: 'page',
      chunks: ['chunk 1', 'chunk 2'],
    };
    const { controller, els, createArticleSummary, renderTranscript, renderQueue } = createController();

    controller.setArticleSummary(article);

    expect(createArticleSummary).toHaveBeenCalledWith({
      title: 'Source Title',
      text: 'Article body',
      source: 'page',
      chunks: ['chunk 1', 'chunk 2'],
    });
    expect(els.title.textContent).toBe('Readable Title');
    expect(els.readingTitle.textContent).toBe('Readable Title');
    expect(els.meta.textContent).toBe('8 min read');
    expect(els.mode.textContent).toBe('Reading: Article');
    expect(els.body.textContent).toBe('Clean preview');
    expect(renderTranscript).toHaveBeenCalledWith('Article body');
    expect(renderQueue).toHaveBeenCalledWith(['a', 'b'], 1);
  });

  it('falls back to the initial preview when the summary has no preview text', () => {
    const { controller, els, getInitialPreview } = createController({
      articleSummary: {
        title: 'Readable Title',
        metaText: '8 min read',
        modeLabel: 'Article',
        previewText: '',
      },
    });

    controller.setArticleSummary({
      title: 'Source Title',
      text: 'Article body',
      source: 'page',
      chunks: ['chunk 1', 'chunk 2'],
    });

    expect(getInitialPreview).toHaveBeenCalledWith(['chunk 1', 'chunk 2']);
    expect(els.body.textContent).toBe('Fallback preview');
  });

  it('renders resume and code suggestion visibility while tolerating missing optional nodes', () => {
    const { controller, els } = createController();

    controller.renderResumePrompt({
      title: 'Saved section',
      detail: '2 minutes ago',
      excerpt: 'Resume here',
    });
    expect(els.resumePrompt.hidden).toBe(false);
    expect(els.resumeTitle.textContent).toBe('Resume');
    expect(els.resumeDetail.textContent).toBe('Continue where you stopped');
    expect(els.resumeExcerpt.textContent).toBe('The saved excerpt');

    const hiddenResume = createController({
      resumePrompt: { visible: false },
    });
    hiddenResume.controller.renderResumePrompt(null);
    expect(hiddenResume.els.resumePrompt.hidden).toBe(true);

    controller.renderCodeSuggestion({
      visible: true,
      title: 'Read code blocks',
      detail: 'Selected snippets are included',
    });
    expect(els.codeSuggestion.hidden).toBe(false);
    expect(els.codeSuggestionTitle.textContent).toBe('Read code blocks');
    expect(els.codeSuggestionDetail.textContent).toBe('Selected snippets are included');

    controller.renderCodeSuggestion();
    expect(els.codeSuggestion.hidden).toBe(true);

    const guarded = createController({
      els: createEls({
        resumePrompt: null,
        codeSuggestion: null,
      }),
    });
    expect(() => guarded.controller.renderResumePrompt({ visible: true })).not.toThrow();
    expect(() => guarded.controller.renderCodeSuggestion({ visible: true })).not.toThrow();
  });
});
