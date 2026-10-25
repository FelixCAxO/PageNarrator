import { describe, expect, it } from 'vitest';
import { createArticleSummary, createTranscriptWindow, getChunkWordCounts, getContentModeLabel, getPanelView, getSetupView, getWeightedProgress } from "../../src/lib/reader-engine-view.js";

describe('toolbar player view model', () => {
  it('computes reading progress from cumulative words when chunk sizes vary', () => {
    const chunks = [
      { speech: 'Short heading.' },
      { speech: 'This paragraph carries most of the listening time because it has more words.' },
      'Final note.',
    ];
    const wordCounts = getChunkWordCounts(chunks);

    expect(wordCounts).toEqual([2, 13, 2]);
    expect(getWeightedProgress(1, wordCounts)).toBe(12);

    const view = getPanelView({
      state: 'reading',
      currentChunk: 1,
      totalChunks: 3,
      wordCounts,
    });

    expect(view.progressPercent).toBe(12);
    expect(view.progressLabel).toBe('12% complete');
    expect(view.remainingLabel).toBe('15 words left');
  });

  it('uses the whole readable document total while streaming only a small chunk window', () => {
    const view = getPanelView({
      state: 'reading',
      currentChunk: 1,
      totalChunks: 3,
      wordCounts: [20, 50, 30],
      totalReadableWordCount: 1000,
    });

    expect(view.progressPercent).toBe(2);
    expect(view.remainingLabel).toBe('980 words left');
  });

  it('caches word-count prefix sums across repeated progress renders', () => {
    let reads = 0;
    const wordCounts = Array.from({ length: 100 }, () => 1);
    for (let index = 0; index < wordCounts.length; index += 1) {
      Object.defineProperty(wordCounts, index, {
        configurable: true,
        get() {
          reads += 1;
          return 1;
        },
      });
    }

    getPanelView({
      state: 'reading',
      currentChunk: 40,
      totalChunks: wordCounts.length,
      wordCounts,
    });
    const readsAfterFirstRender = reads;

    getPanelView({
      state: 'paused',
      currentChunk: 41,
      totalChunks: wordCounts.length,
      wordCounts,
    });

    expect(readsAfterFirstRender).toBeGreaterThan(0);
    expect(reads).toBe(readsAfterFirstRender);
  });

  it('surfaces first-run bundled voice preparation before reading starts', () => {
    const view = getPanelView({
      state: 'idle',
      modelSetup: {
        phase: 'loading',
        progress: 38,
        eta: 'About 2m left',
      },
    });

    expect(view.statusText).toBe('Preparing voice - 38%, about 2m left');
    expect(view.statusTone).toBe('preparing');
    expect(view.primaryAction).toEqual({ label: 'Preparing voice...', disabled: true });
  });

  it('uses clear finished and error states', () => {
    expect(getPanelView({ state: 'finished' }).primaryAction.label).toBe('Read again');
    expect(getPanelView({ state: 'finished' }).statusText).toBe('Finished reading');

    const error = getPanelView({ state: 'error', message: 'Could not detect article text' });
    expect(error.statusText).toBe('Could not detect article text');
    expect(error.isError).toBe(true);
    expect(error.statusTone).toBe('error');

    expect(getPanelView({ state: 'error', errorCode: 'article_text_not_found' }).primaryAction).toEqual({
      label: 'Read selected',
      disabled: false,
      action: 'read-selected',
    });
  });

  it('summarizes detected content with word count and reading time', () => {
    const summary = createArticleSummary({
      title: 'Relation of Data Science to ML, AI, NLP, DL',
      text: 'Deep learning is advanced machine learning where algorithms use complex layered structures. It improves recognition and classification with data.',
      source: 'reading-model',
    });

    expect(summary.title).toBe('Relation of Data Science to ML, AI, NLP, DL');
    expect(summary.modeLabel).toBe('Article only');
    expect(summary.metaText).toBe('19 words · ~1 min');
    expect(summary.previewText).toBe('Deep learning is advanced machine learning where algorithms use complex layered structures. It improves recognition and classification with data.');
  });

  it('derives article metadata from the detected article text instead of a fixed sample value', () => {
    const shortArticle = createArticleSummary({
      title: 'Short note',
      text: 'One two three four five six seven eight nine ten.',
      source: 'reading-model',
    });
    const longArticle = createArticleSummary({
      title: 'Long note',
      text: Array.from({ length: 310 }, (_, index) => `word${index + 1}`).join(' '),
      source: 'reading-model',
    });

    expect(shortArticle.wordCount).toBe(10);
    expect(shortArticle.minutes).toBe(1);
    expect(shortArticle.metaText).toBe('10 words · ~1 min');

    expect(longArticle.wordCount).toBe(310);
    expect(longArticle.minutes).toBe(2);
    expect(longArticle.metaText).toBe('310 words · ~2 min');

    expect(shortArticle.metaText).not.toBe(longArticle.metaText);
    expect(shortArticle.metaText).not.toBe('855 words · ~6 min');
    expect(longArticle.metaText).not.toBe('855 words · ~6 min');
  });

  it('falls back to useful detected content copy when no article is loaded', () => {
    const summary = createArticleSummary({ title: '', text: '', source: 'reading-model' });

    expect(summary.title).toBe('No page loaded');
    expect(summary.metaText).toBe('Open an article, then read the page');
    expect(summary.previewText).toBe('Text appears when reading starts.');
  });

  it('summarizes streamed article chunk metadata before the chunk stream is pulled', () => {
    const summary = createArticleSummary({
      title: 'Fetch API',
      text: '',
      source: 'reading-model',
      chunks: [
        { speech: 'Fetch API.' },
        { speech: 'The Fetch API provides an interface for fetching resources across the network.' },
      ],
    });

    expect(summary.title).toBe('Fetch API');
    expect(summary.metaText).toBe('14 words \u00b7 ~1 min');
    expect(summary.previewText).toBe('Fetch API. The Fetch API provides an interface for fetching resources across the network.');
  });

  it('keeps setup UI hidden after the voice model is ready', () => {
    expect(getSetupView({ phase: 'idle' }).visible).toBe(false);
    expect(getSetupView({ phase: 'ready' })).toEqual({
      visible: false,
      compactText: 'Voice ready',
    });

    const loading = getSetupView({
      phase: 'loading',
      progress: 38,
      detail: 'Loading model...',
      eta: 'About 2m left',
    });
    expect(loading.visible).toBe(true);
    expect(loading.title).toBe('Preparing voice');
    expect(loading.progressPercent).toBe(38);
    expect(loading.detail).toBe('Loading model...');
    expect(loading.eta).toBe('About 2m left');
  });

  it('names content modes in user-facing language', () => {
    expect(getContentModeLabel('reading-model')).toBe('Article only');
    expect(getContentModeLabel('selection')).toBe('Selected text');
    expect(getContentModeLabel('pdf')).toBe('PDF document');
    expect(getContentModeLabel('fallback')).toBe('Full page');
  });

  it('builds transcript paragraphs from short detected text with the default window', () => {
    expect(createTranscriptWindow('First paragraph.\n\nSecond paragraph.').paragraphs).toEqual([
      'First paragraph.',
      'Second paragraph.',
    ]);
    expect(createTranscriptWindow('').paragraphs).toEqual(['Transcript appears when text loads.']);
  });

  it('creates a bounded transcript window for book-sized PDFs without materializing every paragraph', () => {
    const text = Array.from({ length: 200 }, (_, index) => `Paragraph ${index + 1}`).join('\n\n');
    const transcript = createTranscriptWindow(text, { limit: 12 });

    expect(transcript.paragraphs).toEqual(Array.from({ length: 12 }, (_, index) => `Paragraph ${index + 1}`));
    expect(transcript.totalCount).toBe(200);
    expect(transcript.visibleCount).toBe(12);
    expect(transcript.isLimited).toBe(true);
    expect(transcript.countLabel).toBe('200 paragraphs · first 12 shown');
  });

  it('keeps short transcript windows exact and uses the empty transcript fallback', () => {
    expect(createTranscriptWindow('First paragraph.\n\nSecond paragraph.', { limit: 12 })).toEqual({
      paragraphs: ['First paragraph.', 'Second paragraph.'],
      totalCount: 2,
      visibleCount: 2,
      isLimited: false,
      countLabel: '2 paragraphs',
    });

    expect(createTranscriptWindow('', { limit: 12 })).toEqual({
      paragraphs: ['Transcript appears when text loads.'],
      totalCount: 1,
      visibleCount: 1,
      isLimited: false,
      countLabel: '1 paragraph',
    });
  });
});
