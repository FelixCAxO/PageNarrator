import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { chunkText, getInitialPreview, splitSpeechSentences } from '../../src/lib/speech-chunks.js';
import { getDomWordIndexForSpeechWord } from '../../src/lib/reading-model.js';
import { TUNING_CONFIG } from '../../src/lib/tuning-config.js';

describe('speech chunking', () => {
  it('bounds the first fast-start chunk without changing the complete article text', () => {
    const text = 'PageNarrator is an on-device Chrome reader designed for natural speech synthesis. It processes web pages and PDF documents directly inside the browser using Kokoro TTS. Playback follows the original word order so readers can keep their place. Longer paragraphs continue after the short initial chunk without losing or repeating content.';
    const standard = chunkText(text, 480, { targetMinLen: 260 });
    const fastStart = chunkText(text, 480, {
      targetMinLen: 260,
      initialMaxChunkLength: 120,
      initialTargetMinLength: 80,
    });

    expect(fastStart[0].length).toBeLessThan(standard[0].length);
    expect(fastStart[0].length).toBeLessThanOrEqual(120);
    expect(fastStart.join(' ')).toBe(standard.join(' '));
    expect(fastStart.join(' ')).toBe(text);
  });

  it.each(['”', '’', ')]'])('keeps terminal closing punctuation %s with its sentence', (closing) => {
    const sentence = `The woodland remains quiet.${closing}`;
    expect(splitSpeechSentences(`${sentence} A new paragraph follows.`)).toEqual([`${sentence} `, 'A new paragraph follows.']);
    expect(chunkText(sentence, 60, { targetMinLen: 0 })).toEqual([sentence]);
  });

  it('keeps a closing curly quote attached when an oversized sentence splits at a comma', () => {
    const sentence = '“The forest is calm and quiet,” and this second long clause explains why visitors should select an appropriate campsite.';
    const chunks = chunkText(sentence, 60, { targetMinLen: 0 });
    expect(chunks[0]).toBe('“The forest is calm and quiet,”');
    expect(chunks.join(' ')).toBe(sentence);
    expect(chunks.every(chunk => chunk.length <= 60)).toBe(true);
  });
  it.each(['7,500', '12,345,678', '7,5', '٧,٥٠٠'])('keeps the numeral %s intact across short speech chunks', (numeral) => {
    const sentence = `For example, in northern Spain, archaeologists have found ${numeral}-year-old cave paintings depicting ancient humans scaling a rope ladder to gather honey.`;
    const chunks = chunkText(sentence, 120, { targetMinLen: 80 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every(chunk => chunk.length <= 120)).toBe(true);
    expect(chunks.some(chunk => chunk.includes(numeral))).toBe(true);
    expect(chunks.join(' ')).toBe(sentence);
  });
  it('normalizes a shared DOM anchor once while preserving all split text and offsets', () => {
    const anchor = '  First sentence.\n\n Second sentence.\tThird sentence.  ';
    const stringify = vi.fn(() => anchor);
    const source = {
      type: 'paragraph', speech: 'First sentence. Second sentence. Third sentence.',
      anchorText: { toString: stringify }, anchorId: 'shared-anchor', domWordOffset: 5,
      globalDomWordStartIndex: 12,
    };
    const chunks = chunkText([source], 17, { targetMinLen: 0 });
    expect(chunks).toEqual([
      { ...source, speech: 'First sentence.', text: 'First sentence.', anchorText: 'First sentence. Second sentence. Third sentence.', speechPrefixWords: 0, domWordOffset: 5, globalDomWordStartIndex: 12 },
      { ...source, speech: 'Second sentence.', text: 'Second sentence.', anchorText: 'First sentence. Second sentence. Third sentence.', speechPrefixWords: 0, domWordOffset: 7, globalDomWordStartIndex: 14 },
      { ...source, speech: 'Third sentence.', text: 'Third sentence.', anchorText: 'First sentence. Second sentence. Third sentence.', speechPrefixWords: 0, domWordOffset: 9, globalDomWordStartIndex: 16 },
    ]);
    expect(stringify).toHaveBeenCalledOnce();
  });

  it('returns the first readable paragraph synchronously for preview before audio is generated', () => {
    const text = [
      'The first paragraph should be visible right away.',
      'The second paragraph can preload while the first one is displayed.',
    ].join('\n\n');

    expect(getInitialPreview(text)).toBe('The first paragraph should be visible right away.');
  });

  it('keeps paragraph order from top to bottom when creating speech chunks', () => {
    const chunks = chunkText('Top paragraph.\n\nMiddle paragraph.\n\nBottom paragraph.');

    expect(chunks).toEqual(['Top paragraph.', 'Middle paragraph.', 'Bottom paragraph.']);
  });

  it('uses the documented Kokoro-safe default chunk length', () => {
    const text = Array.from({ length: 60 }, (_, index) => `Sentence ${index + 1} has enough words to make the article long.`).join(' ');
    const chunks = chunkText(text);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= TUNING_CONFIG.speechChunking.defaultMaxLength)).toBe(true);
  });

  it('groups normal sentences until the target lower bound to reduce TTS transitions', () => {
    const text = [
      'The first sentence has enough words to stand on its own during a normal narrated article.',
      'The second sentence also has a complete thought for narration without being unusually brief.',
      'The third sentence should not be packed into the same audio blob during playback.',
    ].join(' ');

    expect(chunkText(text)).toEqual([
      text,
    ]);
  });

  it('keeps grouped sentence chunks under the max length while honoring a configurable target minimum', () => {
    const sentences = Array.from({ length: 8 }, (_, index) => (
      `Sentence ${index + 1} has enough words for normal article narration.`
    ));
    const chunks = chunkText(sentences.join(' '), 180, { targetMinLen: 120 });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 180)).toBe(true);
    expect(chunks.slice(0, -1).every((chunk) => chunk.length >= 120)).toBe(true);
  });

  it('splits a punctuation-heavy English sentence into bounded timing chunks', () => {
    const sentence = [
      'The narrator follows the opening claim',
      'tracks the qualifying evidence',
      'keeps the quoted exception together',
      'then moves through the contrast',
      'the implication',
      'and the final practical takeaway without waiting for a period',
    ].join(', ');
    const chunks = chunkText(sentence, 120, { targetMinLen: 80 });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 120)).toBe(true);
    expect(chunks.join(' ')).toBe(sentence);
  });

  it('splits an overlong English sentence on word boundaries when there is no clause punctuation', () => {
    const sentence = Array.from({ length: 46 }, (_, index) => `word${index + 1}`).join(' ');
    const chunks = chunkText(sentence, 80, { targetMinLen: 50 });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 80)).toBe(true);
    expect(chunks.join(' ')).toBe(sentence);
  });

  it('does not split decimal values inside an anchored paragraph', () => {
    const text = 'When Bias changed from -1.0 to -5.0, It led to the increase in the value of triggering activation function.';

    expect(chunkText([{
      type: 'paragraph',
      speech: text,
      text,
      anchorText: text,
      anchorId: 'bias-paragraph',
      speechPrefixWords: 0,
    }])).toEqual([{
      type: 'paragraph',
      speech: text,
      text,
      anchorText: text,
      anchorId: 'bias-paragraph',
      domWordOffset: 0,
      speechPrefixWords: 0,
    }]);
  });

  it('does not split email or domain periods when preserving anchor offsets', () => {
    const text = 'Contact apptek.com for the benchmark details. The abstract explains the evaluation protocol.';

    expect(chunkText([{
      type: 'pdf-page',
      speech: text,
      text,
      anchorText: text,
      anchorId: 'pdf-page-1',
      speechPrefixWords: 0,
      pageNumber: 1,
    }], 60)).toEqual([
      {
        type: 'pdf-page',
        speech: 'Contact apptek.com for the benchmark details.',
        text: 'Contact apptek.com for the benchmark details.',
        anchorText: text,
        anchorId: 'pdf-page-1',
        domWordOffset: 0,
        speechPrefixWords: 0,
        pageNumber: 1,
      },
      {
        type: 'pdf-page',
        speech: 'The abstract explains the evaluation protocol.',
        text: 'The abstract explains the evaluation protocol.',
        anchorText: text,
        anchorId: 'pdf-page-1',
        domWordOffset: 6,
        speechPrefixWords: 0,
        pageNumber: 1,
      },
    ]);
  });

  it('keeps structured speech text separate from DOM anchor text', () => {
    const chunks = chunkText([
      {
        type: 'heading',
        speech: 'Why structure matters.',
        anchorText: 'Why structure matters',
        speechPrefixWords: 0,
      },
      {
        type: 'paragraph',
        speech: 'Plain DOM text.',
        anchorText: 'Plain DOM text',
        speechPrefixWords: 0,
      },
    ]);

    expect(chunks).toEqual([
      {
        type: 'heading',
        speech: 'Why structure matters.',
        text: 'Why structure matters.',
        anchorText: 'Why structure matters',
        speechPrefixWords: 0,
      },
      {
        type: 'paragraph',
        speech: 'Plain DOM text.',
        text: 'Plain DOM text.',
        anchorText: 'Plain DOM text',
        speechPrefixWords: 0,
      },
    ]);
  });

  it('strips non-spoken markup from structured speech while preserving raw DOM anchors', () => {
    const text = 'Artificial intelligence (AI) improves tasks[1] quickly.';

    expect(chunkText([{
      type: 'paragraph',
      speech: text,
      text,
      anchorText: text,
      anchorId: 'paragraph-ai',
      speechPrefixWords: 0,
    }])).toEqual([{
      type: 'paragraph',
      speech: 'Artificial intelligence (AI) improves tasks quickly.',
      text: 'Artificial intelligence (AI) improves tasks quickly.',
      anchorText: text,
      anchorId: 'paragraph-ai',
      domWordOffset: 0,
      speechPrefixWords: 0,
    }]);
  });

  it('chunks pre-stripped structured speech without recursively re-stripping through chunkText', () => {
    const source = readFileSync(new URL('../../src/lib/speech-chunks.js', import.meta.url), 'utf8');
    const structuredPath = source.slice(source.indexOf('function chunkSpeechItems'));

    expect(structuredPath).not.toContain('chunkText(speech');
  });

  it('drops structured anchor metadata when a long speech item must be split', () => {
    const chunks = chunkText([
      {
        type: 'heading',
        speech: Array.from({ length: 10 }, (_, index) => `Section part ${index + 1} has enough words to split.`).join(' '),
        anchorText: Array.from({ length: 10 }, (_, index) => `part ${index + 1} has enough words to split`).join(' '),
        speechPrefixWords: 0,
      },
    ], 60);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.speechPrefixWords === 0)).toBe(true);
    expect(chunks.every((chunk) => chunk.anchorText === chunk.text)).toBe(true);
  });

  it('keeps DOM anchor metadata and records word offsets when structured text is split', () => {
    const chunks = chunkText([
      {
        type: 'paragraph',
        speech: [
          'The first sentence has enough words to be split into its own audio chunk.',
          'The second sentence should stay anchored to the same paragraph.',
        ].join(' '),
        anchorText: [
          'The first sentence has enough words to be split into its own audio chunk.',
          'The second sentence should stay anchored to the same paragraph.',
        ].join(' '),
        anchorId: 'paragraph-1',
        speechPrefixWords: 0,
      },
    ], 80);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatchObject({
      anchorId: 'paragraph-1',
      anchorText: 'The first sentence has enough words to be split into its own audio chunk. The second sentence should stay anchored to the same paragraph.',
      domWordOffset: 0,
    });
    expect(chunks[1]).toMatchObject({
      anchorId: 'paragraph-1',
      anchorText: 'The first sentence has enough words to be split into its own audio chunk. The second sentence should stay anchored to the same paragraph.',
      domWordOffset: 14,
    });
  });

  it('keeps a prefixed structured item grounded across every split chunk', () => {
    const speechPrefix = 'Table one summarizes results.';
    const anchorText = [
      'The first row reports steady growth across all measured regions.',
      'The second row records a smaller increase during the same period.',
      'The final row confirms that the overall pattern remains consistent.',
    ].join(' ');
    const chunks = chunkText([
      {
        type: 'table',
        speech: `${speechPrefix} ${anchorText}`,
        text: anchorText,
        anchorText,
        anchorId: 'results-table',
        domWordOffset: 6,
        speechPrefixWords: 4,
      },
    ], 72);

    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks.every((chunk) => chunk.anchorId === 'results-table')).toBe(true);
    expect(chunks.every((chunk) => chunk.anchorText === anchorText)).toBe(true);
    expect(chunks.map((chunk) => chunk.speechPrefixWords)).toEqual([
      4,
      ...Array(chunks.length - 1).fill(0),
    ]);

    const offsets = chunks.map((chunk) => chunk.domWordOffset);
    expect(offsets.every(Number.isFinite)).toBe(true);
    expect(offsets[0]).toBe(6);
    expect(offsets).toEqual([...offsets].sort((left, right) => left - right));
  });

  it('refreshes global DOM word starts when splitting anchored chunks', () => {
    const chunks = chunkText([
      {
        type: 'paragraph',
        speech: [
          'The first sentence has enough words to be split into its own audio chunk.',
          'The second sentence should stay anchored to the same paragraph.',
        ].join(' '),
        anchorText: [
          'The first sentence has enough words to be split into its own audio chunk.',
          'The second sentence should stay anchored to the same paragraph.',
        ].join(' '),
        anchorId: 'paragraph-1',
        domWordOffset: 0,
        globalDomWordStartIndex: 0,
        speechPrefixWords: 0,
      },
    ], 80);

    expect(chunks).toHaveLength(2);
    expect(chunks.map((chunk) => chunk.globalDomWordStartIndex)).toEqual([0, 14]);
    expect(getDomWordIndexForSpeechWord(chunks[1], 0)).toBe(14);
  });

  it('counts split anchor offsets in spoken-token space when raw anchors contain non-spoken markup', () => {
    const text = [
      'Artificial intelligence (AI) improves tasks[1] quickly.',
      'The second sentence stays anchored after the citation marker.',
    ].join(' ');

    const chunks = chunkText([
      {
        type: 'paragraph',
        speech: text,
        text,
        anchorText: text,
        anchorId: 'paragraph-ai',
        domWordOffset: 5,
        globalDomWordStartIndex: 20,
        speechPrefixWords: 0,
      },
    ], 62);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatchObject({
      speech: 'Artificial intelligence (AI) improves tasks quickly.',
      anchorText: text,
      anchorId: 'paragraph-ai',
      domWordOffset: 5,
      globalDomWordStartIndex: 20,
    });
    expect(chunks[1]).toMatchObject({
      speech: 'The second sentence stays anchored after the citation marker.',
      anchorText: text,
      anchorId: 'paragraph-ai',
      domWordOffset: 11,
      globalDomWordStartIndex: 26,
    });
  });

  it('keeps PDF split offsets in narrated word space when visual anchors retain citation words', () => {
    const speech = [
      'The first sentence establishes the measured result clearly.',
      'The second sentence remains aligned after the removed citation.',
    ].join(' ');
    const chunks = chunkText([{
      type: 'pdf-page',
      speech,
      text: speech,
      anchorText: [
        'The first sentence establishes the measured result clearly.',
        '(Smith et al., 2025)',
        'The second sentence remains aligned after the removed citation.',
      ].join(' '),
      anchorId: 'pdf-page-1',
      speechPrefixWords: 0,
      pageNumber: 1,
    }], 68);

    expect(chunks).toHaveLength(2);
    expect(chunks.map((chunk) => chunk.domWordOffset)).toEqual([0, 8]);
    expect(chunks.every((chunk) => chunk.anchorId === 'pdf-page-1')).toBe(true);
  });

  it('preserves selected-text DOM word offsets when splitting anchored selections', () => {
    const chunks = chunkText([
      {
        type: 'paragraph',
        speech: 'Selected first sentence for playback. The second selected sentence should retain the original DOM offset.',
        text: 'Selected first sentence for playback. The second selected sentence should retain the original DOM offset.',
        anchorText: 'Selected first sentence for playback. The second selected sentence should retain the original DOM offset.',
        anchorId: 'sel-1',
        domWordOffset: 3,
        speechPrefixWords: 0,
      },
    ], 60);

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toMatchObject({
      anchorId: 'sel-1',
      domWordOffset: 3,
    });
    expect(chunks[1]).toMatchObject({
      anchorId: 'sel-1',
      domWordOffset: 8,
    });
    expect(chunks[2]).toMatchObject({
      anchorId: 'sel-1',
      domWordOffset: 17,
    });
  });

  it('keeps anchorId on chunks that fit without splitting', () => {
    const chunks = chunkText([
      {
        type: 'heading',
        speech: 'Why structure matters.',
        anchorText: 'Why structure matters',
        anchorId: 'heading-1',
        speechPrefixWords: 0,
      },
    ]);

    expect(chunks).toEqual([
      {
        type: 'heading',
        speech: 'Why structure matters.',
        text: 'Why structure matters.',
        anchorText: 'Why structure matters',
        anchorId: 'heading-1',
        domWordOffset: 0,
        speechPrefixWords: 0,
      },
    ]);
  });

  it('carries PDF page numbers through chunk splitting for queue wayfinding', () => {
    const chunks = chunkText([
      {
        type: 'pdf-page',
        speech: [
          'The first page sentence has enough words to be split into its own chunk.',
          'The follow up sentence remains on the same source page.',
        ].join(' '),
        anchorText: [
          'The first page sentence has enough words to be split into its own chunk.',
          'The follow up sentence remains on the same source page.',
        ].join(' '),
        anchorId: 'pdf-page-7',
        speechPrefixWords: 0,
        pageNumber: 7,
      },
    ], 80);

    expect(chunks).toHaveLength(2);
    expect(chunks.every((chunk) => chunk.pageNumber === 7)).toBe(true);
    expect(chunks.every((chunk) => chunk.anchorId === 'pdf-page-7')).toBe(true);
    expect(chunks.map((chunk) => chunk.domWordOffset)).toEqual([0, 14]);
  });
});
