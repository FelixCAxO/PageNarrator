import { describe, expect, it } from 'vitest';
import { applyReadingPreferences } from '../../src/lib/reading-filters.js';

describe('reading preference filters', () => {
  it('removes anchored code chunks and rebuilds article text when code skipping is enabled', () => {
    const article = {
      title: 'Add operation in Deep Learning',
      source: 'reading-model',
      text: 'Intro.\n\nconst x = 1;\n\nExplanation.',
      chunks: [
        { type: 'paragraph', speech: 'Intro.', anchorId: 'p1' },
        { type: 'code', speech: 'const x = 1;', anchorId: 'code1' },
        { type: 'paragraph', speech: 'Explanation.', anchorId: 'p2' },
      ],
    };

    expect(applyReadingPreferences(article, { skipCodeSnippets: true })).toEqual({
      ...article,
      text: 'Intro.\n\nExplanation.',
      chunks: [
        { type: 'paragraph', speech: 'Intro.', anchorId: 'p1' },
        { type: 'paragraph', speech: 'Explanation.', anchorId: 'p2' },
      ],
    });
  });

  it('leaves code chunks intact unless cleanup is enabled', () => {
    const article = {
      text: 'Intro.\n\nconst x = 1;',
      chunks: [
        { type: 'paragraph', speech: 'Intro.' },
        { type: 'code', speech: 'const x = 1;' },
      ],
    };

    expect(applyReadingPreferences(article, { skipCodeSnippets: false })).toBe(article);
  });

  it('skips uncaptioned table chunks when table narration is gated', () => {
    const article = {
      text: 'Intro.\n\nTable.\n\nYear - Result.\n\nTable: Study results.',
      chunks: [
        { type: 'paragraph', speech: 'Intro.', anchorId: 'intro' },
        { type: 'table', speech: 'Table.', anchorId: 'table-1', anchorText: null },
        { type: 'table-row', speech: 'Year - Result.', anchorId: 'row-1', parentAnchorId: 'table-1' },
        { type: 'table', speech: 'Table: Study results.', anchorId: 'table-2', anchorText: 'Study results' },
      ],
    };

    expect(applyReadingPreferences(article, { skipTablesUnlessCaptioned: true })).toEqual({
      ...article,
      text: 'Intro.\n\nTable: Study results.',
      chunks: [
        { type: 'paragraph', speech: 'Intro.', anchorId: 'intro' },
        { type: 'table', speech: 'Table: Study results.', anchorId: 'table-2', anchorText: 'Study results' },
      ],
    });
  });

  it('skips uncaptioned table rows when the source table has no anchor id', () => {
    const article = {
      text: 'Intro.\n\nTable.\n\nYear - Result.\n\nAfter.',
      chunks: [
        { type: 'paragraph', speech: 'Intro.', anchorId: 'intro' },
        { type: 'table', speech: 'Table.', anchorText: null },
        { type: 'table-row', speech: 'Year - Result.' },
        { type: 'paragraph', speech: 'After.', anchorId: 'after' },
      ],
    };

    expect(applyReadingPreferences(article, { skipTablesUnlessCaptioned: true })).toEqual({
      ...article,
      text: 'Intro.\n\nAfter.',
      chunks: [
        { type: 'paragraph', speech: 'Intro.', anchorId: 'intro' },
        { type: 'paragraph', speech: 'After.', anchorId: 'after' },
      ],
    });
  });

  it('removes code-shaped tutorial chunks even when extraction missed the code type', () => {
    const code = [
      'import tensorflow as tf',
      '# Define input tensors',
      'tensor_a = tf.constant([1, 2, 3])',
      'tensor_b = tf.constant([4, 5, 6])',
      '# Perform element-wise addition using layers.Add',
      'output_tensor = tf.layers.Add()([tensor_a, tensor_b])',
      'with tf.Session() as sess:',
      '    result = sess.run(output_tensor)',
      '    print("Result:", result)',
    ].join(' ');
    const article = {
      title: 'TensorFlow layers.Add example',
      source: 'reading-model',
      text: `The setup explains why tensors are added.\n\n${code}\n\nIn this code example, the result tensor is printed.`,
      chunks: [
        { type: 'paragraph', speech: 'The setup explains why tensors are added.', anchorId: 'intro' },
        { type: 'paragraph', speech: code, anchorId: 'code-wrapper' },
        { type: 'paragraph', speech: 'In this code example, the result tensor is printed.', anchorId: 'after' },
      ],
    };

    expect(applyReadingPreferences(article, { skipCodeSnippets: true })).toEqual({
      ...article,
      text: 'The setup explains why tensors are added.\n\nIn this code example, the result tensor is printed.',
      chunks: [
        { type: 'paragraph', speech: 'The setup explains why tensors are added.', anchorId: 'intro' },
        { type: 'paragraph', speech: 'In this code example, the result tensor is printed.', anchorId: 'after' },
      ],
    });
  });

  it('keeps prose that mentions APIs and code concepts', () => {
    const article = {
      text: 'In this code example, TensorFlow layers.Add combines two tensors and returns an output tensor.',
      chunks: [
        {
          type: 'paragraph',
          speech: 'In this code example, TensorFlow layers.Add combines two tensors and returns an output tensor.',
        },
      ],
    };

    expect(applyReadingPreferences(article, { skipCodeSnippets: true })).toEqual(article);
  });

  it('filters code-like paragraphs when only article fallback text is available', () => {
    const article = {
      source: 'article-fallback',
      text: [
        'The article introduces tensor addition before showing the implementation.',
        [
          'import tensorflow as tf',
          'tensor_a = tf.constant([1, 2, 3])',
          'tensor_b = tf.constant([4, 5, 6])',
          'output_tensor = tf.layers.Add()([tensor_a, tensor_b])',
        ].join('\n'),
        'The next paragraph explains the output in plain language.',
      ].join('\n\n'),
    };

    expect(applyReadingPreferences(article, { skipCodeSnippets: true })).toEqual({
      ...article,
      text: 'The article introduces tensor addition before showing the implementation.\n\nThe next paragraph explains the output in plain language.',
    });
  });

  it('filters streamed chunks before considering an empty serialized chunks array', async () => {
    const article = {
      source: 'reading-model',
      text: '',
      chunks: [],
      streaming: true,
      chunkStream: (async function* streamChunks() {
        yield { type: 'paragraph', speech: 'The article introduces tensor addition.', anchorId: 'intro' };
        yield { type: 'code', speech: 'const x = 1;', anchorId: 'code' };
        yield { type: 'paragraph', speech: 'The next paragraph explains the output.', anchorId: 'after' };
      })(),
    };

    const filtered = applyReadingPreferences(article, { skipCodeSnippets: true });
    const streamed = [];
    for await (const chunk of filtered.chunkStream) streamed.push(chunk);

    expect(streamed).toEqual([
      { type: 'paragraph', speech: 'The article introduces tensor addition.', anchorId: 'intro' },
      { type: 'paragraph', speech: 'The next paragraph explains the output.', anchorId: 'after' },
    ]);
  });

  it('preserves requested batch sizes while filtering streamed chunks', async () => {
    const requests = [];
    const article = {
      source: 'reading-model',
      text: '',
      chunks: [],
      streaming: true,
      chunkStream: {
        [Symbol.asyncIterator]() {
          let buffered = [];
          return {
            async next(requestedCount) {
              if (buffered.length) return { done: false, value: buffered.shift() };
              requests.push(requestedCount);
              if (requestedCount !== 4) return { done: true, value: undefined };
              buffered = [{ type: 'paragraph', speech: 'First streamed section.' }];
              return { done: false, value: { type: 'code', speech: 'const skipped = true;' } };
            },
          };
        },
      },
    };

    const filtered = applyReadingPreferences(article, { skipCodeSnippets: true });

    await expect(filtered.chunkStream[Symbol.asyncIterator]().next(4)).resolves.toEqual({
      done: false,
      value: { type: 'paragraph', speech: 'First streamed section.' },
    });
    expect(requests).toEqual([4]);
  });

  it('filters each chunk inside streamed PDF batches', async () => {
    const requests = [];
    const article = {
      source: 'pdf',
      text: '',
      chunks: [],
      streaming: true,
      chunkStream: {
        [Symbol.asyncIterator]() {
          let sent = false;
          return {
            async next(requestedCount) {
              requests.push(requestedCount);
              if (sent) return { done: true, value: undefined };
              sent = true;
              return {
                done: false,
                value: [
                  { type: 'paragraph', speech: 'Before the code.', anchorId: 'p1' },
                  { type: 'code', speech: 'const skipped = true;', anchorId: 'code' },
                  { type: 'paragraph', speech: 'After the code.', anchorId: 'p2' },
                ],
              };
            },
          };
        },
      },
    };

    const filtered = applyReadingPreferences(article, { skipCodeSnippets: true });

    await expect(filtered.chunkStream[Symbol.asyncIterator]().next(3)).resolves.toEqual({
      done: false,
      value: [
        { type: 'paragraph', speech: 'Before the code.', anchorId: 'p1' },
        { type: 'paragraph', speech: 'After the code.', anchorId: 'p2' },
      ],
    });
    expect(requests).toEqual([3]);
  });

  it('forwards early stream close through filtered streamed chunks', async () => {
    let closed = false;
    let pulls = 0;
    const article = {
      source: 'reading-model',
      text: '',
      chunks: [],
      streaming: true,
      chunkStream: {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              pulls += 1;
              return { done: false, value: { type: 'paragraph', speech: 'Unread section.' } };
            },
            async return() {
              closed = true;
              return { done: true, value: undefined };
            },
          };
        },
      },
    };

    const filtered = applyReadingPreferences(article, { skipCodeSnippets: true });
    await filtered.chunkStream[Symbol.asyncIterator]().return();

    expect(closed).toBe(true);
    expect(pulls).toBe(0);
  });
});
