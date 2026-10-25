import { describe, expect, it } from 'vitest';
import {
  buildCorpusContentReport,
  buildCorpusFlowReport,
  normalizeToken,
} from '../e2e/corpus-flow-invariants.js';

describe('corpus flow invariant helpers', () => {
  it('reports extracted chunk drops and consecutive short chunk runs', () => {
    const report = buildCorpusFlowReport({
      readerEngineLog: [
        { kind: 'chunks_extracted', totalChunks: 7 },
        { kind: 'chunk_play', chunkIndex: 0, t: 0, speechText: 'Short one.' },
        { kind: 'chunk_end', chunkIndex: 0, t: 1 },
        { kind: 'chunk_play', chunkIndex: 1, t: 1.01, speechText: 'Short two.' },
        { kind: 'chunk_end', chunkIndex: 1, t: 2 },
        { kind: 'chunk_play', chunkIndex: 2, t: 2.01, speechText: 'Short three.' },
        { kind: 'chunk_end', chunkIndex: 2, t: 3 },
        { kind: 'chunk_play', chunkIndex: 4, t: 3.01, speechText: 'Short four.' },
        { kind: 'chunk_end', chunkIndex: 4, t: 4 },
        { kind: 'chunk_play', chunkIndex: 5, t: 4.01, speechText: 'Short five.' },
        { kind: 'chunk_end', chunkIndex: 5, t: 5 },
        { kind: 'chunk_play', chunkIndex: 6, t: 5.01, speechText: 'This chunk is deliberately long enough to reset the short-chunk run before it reaches the limit.' },
        { kind: 'chunk_end', chunkIndex: 6, t: 6 },
      ],
      pageLog: [
        { kind: 'word', speechText: 'Marta', domToken: 'Marta' },
        { kind: 'word', speechText: 'cafe', domToken: 'cafe\u0301' },
        { kind: 'word', speechText: 'wrong', domToken: 'right' },
      ],
    });

    expect(report.chunksExtracted).toBe(7);
    expect(report.chunksSpoken).toBe(6);
    expect(report.missingChunkIndices).toEqual([3]);
    expect(report.maxConsecutiveShortChunks).toBe(5);
    expect(report.wordEvents).toHaveLength(3);
    expect(report.wordEventsWithComparableTokens).toHaveLength(3);
    expect(report.tokenMismatches).toEqual([
      expect.objectContaining({ speechText: 'wrong', domToken: 'right' }),
    ]);
    expect(normalizeToken('Stra\u00dfe')).toBe('strasse');
  });

  it('counts only the planned playback window when reading starts below the first extracted chunk', () => {
    const report = buildCorpusFlowReport({
      readerEngineLog: [
        { kind: 'chunks_extracted', totalChunks: 4, startChunk: 1 },
        { kind: 'chunk_play', chunkIndex: 1, t: 0, speechText: 'Heading:' },
        { kind: 'chunk_end', chunkIndex: 1, t: 0.1 },
        { kind: 'chunk_play', chunkIndex: 2, t: 0.1, speechText: 'First paragraph.' },
        { kind: 'chunk_end', chunkIndex: 2, t: 0.2 },
        { kind: 'chunk_play', chunkIndex: 3, t: 0.2, speechText: 'Second paragraph.' },
        { kind: 'chunk_end', chunkIndex: 3, t: 0.3 },
      ],
    });

    expect(report.totalChunksExtracted).toBe(4);
    expect(report.startChunk).toBe(1);
    expect(report.chunksExtracted).toBe(3);
    expect(report.chunksSpoken).toBe(3);
    expect(report.missingChunkIndices).toEqual([]);
  });

  it('uses the latest streaming extraction count when streams grow after playback starts', () => {
    const report = buildCorpusFlowReport({
      readerEngineLog: [
        { kind: 'chunks_extracted', totalChunks: 5, startChunk: 1, streaming: true },
        { kind: 'chunk_play', chunkIndex: 1, t: 0, speechText: 'Heading:' },
        { kind: 'chunk_end', chunkIndex: 1, t: 0.1 },
        { kind: 'chunk_play', chunkIndex: 2, t: 0.1, speechText: 'First paragraph.' },
        { kind: 'chunk_end', chunkIndex: 2, t: 0.2 },
        { kind: 'chunk_play', chunkIndex: 3, t: 0.2, speechText: 'Second paragraph.' },
        { kind: 'chunk_end', chunkIndex: 3, t: 0.3 },
        { kind: 'chunk_play', chunkIndex: 4, t: 0.3, speechText: 'Table caption.' },
        { kind: 'chunk_end', chunkIndex: 4, t: 0.4 },
        { kind: 'chunk_play', chunkIndex: 5, t: 0.4, speechText: 'Table row.' },
        { kind: 'chunk_end', chunkIndex: 5, t: 0.5 },
        { kind: 'chunks_extracted', totalChunks: 6, startChunk: 1, streaming: true, final: true },
      ],
    });

    expect(report.totalChunksExtracted).toBe(6);
    expect(report.chunksExtracted).toBe(5);
    expect(report.chunksSpoken).toBe(5);
    expect(report.missingChunkIndices).toEqual([]);
  });

  it('captures preload-path decode latency in a separate p95 metric independent of playback-start latency', () => {
    const report = buildCorpusFlowReport({
      readerEngineLog: [
        { kind: 'chunks_extracted', totalChunks: 2 },
        { kind: 'audio_preload_decode_latency', channel: 'preload_decode_latency', chunkIndex: 0, decodeLatencyMs: 38 },
        { kind: 'audio_preload_decode_latency', channel: 'preload_decode_latency', chunkIndex: 1, decodeLatencyMs: 45 },
        { kind: 'audio_decode_latency', channel: 'decode_latency', chunkIndex: 0, decodeLatencyMs: 3 },
      ],
    });
    expect(report.preloadDecodeLatencyP95Ms).toBe(45);
    expect(report.decodeLatencyP95Ms).toBe(3);
  });

  it('flags replayed chunks and de-duplicates them from handoff-gap inputs', () => {
    const report = buildCorpusFlowReport({
      readerEngineLog: [
        { kind: 'chunks_extracted', totalChunks: 3 },
        { kind: 'chunk_play', chunkIndex: 0, t: 0, speechText: 'A' },
        { kind: 'chunk_end', chunkIndex: 0, t: 1 },
        { kind: 'chunk_play', chunkIndex: 1, t: 1.5, speechText: 'B' },
        { kind: 'chunk_play', chunkIndex: 1, t: 1.5, speechText: 'B' },
        { kind: 'chunk_end', chunkIndex: 1, t: 2 },
        { kind: 'chunk_play', chunkIndex: 2, t: 2.25, speechText: 'C' },
        { kind: 'chunk_end', chunkIndex: 2, t: 3 },
      ],
    });
    expect(report.replayedChunkIndices).toEqual([1]);
    expect(report.p95HandoffGapMs).toBe(500);
    expect(report.chunksSpoken).toBe(3);
  });

  it('uses media time to avoid inflating handoff gaps when chunk play events arrive late', () => {
    const report = buildCorpusFlowReport({
      readerEngineLog: [
        { kind: 'chunks_extracted', totalChunks: 2 },
        { kind: 'chunk_play', chunkIndex: 0, t: 0, mediaTime: 0, speechText: 'A' },
        { kind: 'chunk_end', chunkIndex: 0, t: 1, mediaTime: 1, speechText: 'A' },
        { kind: 'chunk_play', chunkIndex: 1, t: 1.025, mediaTime: 0.012, speechText: 'B' },
        { kind: 'chunk_end', chunkIndex: 1, t: 2, mediaTime: 1, speechText: 'B' },
      ],
    });

    expect(report.p95HandoffGapMs).toBeCloseTo(13, 5);
  });

  it('reports missing chunks correctly for large logs (Set membership)', () => {
    const total = 500;
    const readerEngineLog = [{ kind: 'chunks_extracted', totalChunks: total }];
    for (let i = 0; i < total; i += 1) {
      if (i === 250) continue;
      readerEngineLog.push({ kind: 'chunk_play', chunkIndex: i, t: i, speechText: 'word '.repeat(20) });
      readerEngineLog.push({ kind: 'chunk_end', chunkIndex: i, t: i + 0.5 });
    }
    const report = buildCorpusFlowReport({ readerEngineLog });
    expect(report.missingChunkIndices).toEqual([250]);
    expect(report.chunksSpoken).toBe(total - 1);
  });

  it('exposes word events that are missing comparable speech/DOM tokens', () => {
    const report = buildCorpusFlowReport({
      readerEngineLog: [{ kind: 'chunks_extracted', totalChunks: 1 }],
      pageLog: [
        { kind: 'word', speechText: 'hello', domToken: 'hello' },
        { kind: 'word', speechText: 'world' },
        { kind: 'word', domToken: 'orphan' },
      ],
    });
    expect(report.wordEventsMissingTokens).toHaveLength(2);
    expect(report.wordEventsWithComparableTokens).toHaveLength(1);
  });

  it('flags share phrases, private-use glyphs, and symbol-only spoken chunks', () => {
    const report = buildCorpusContentReport({
      readerEngineLog: [
        { kind: 'chunk_play', chunkIndex: 0, speechText: 'The article body remains.' },
        { kind: 'chunk_play', chunkIndex: 1, speechText: 'Share on Facebook.' },
        { kind: 'chunk_play', chunkIndex: 2, speechText: '\uE001' },
        { kind: 'chunk_play', chunkIndex: 3, speechText: '***' },
      ],
    });

    expect(report.forbiddenSpokenChunks).toHaveLength(3);
    expect(report.forbiddenSpokenChunks.map((entry) => entry.reason)).toEqual([
      'share-widget-text',
      'private-use-glyph',
      'symbol-only-text',
    ]);
  });

  it('reports missing gold main text with a recall score', () => {
    const report = buildCorpusContentReport({
      readerEngineLog: [
        { kind: 'chunk_play', chunkIndex: 0, speechText: 'First paragraph stays audible.' },
      ],
      gold: {
        requiredText: [
          'First paragraph stays audible.',
          'Second paragraph stays audible.',
        ],
      },
    });

    expect(report.goldTextCount).toBe(2);
    expect(report.mainTextRecall).toBe(0.5);
    expect(report.missingGoldText).toEqual(['Second paragraph stays audible.']);
  });

  it('recognizes short share labels without flagging ordinary prose containing tweet words', () => {
    const report = buildCorpusContentReport({
      readerEngineLog: [
        { kind: 'chunk_play', chunkIndex: 0, speechText: 'Researchers tweeted that the article would be updated later.' },
        { kind: 'chunk_play', chunkIndex: 1, speechText: 'Facebook.' },
        { kind: 'chunk_play', chunkIndex: 2, speechText: 'LinkedIn.' },
        { kind: 'chunk_play', chunkIndex: 3, speechText: 'Share by email.' },
        { kind: 'chunk_play', chunkIndex: 4, speechText: 'Email this article.' },
      ],
    });

    expect(report.forbiddenSpokenChunks.map((entry) => entry.speechText)).toEqual([
      'Facebook.',
      'LinkedIn.',
      'Share by email.',
      'Email this article.',
    ]);
  });
});
