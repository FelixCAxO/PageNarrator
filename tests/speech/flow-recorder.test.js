import { describe, expect, it } from 'vitest';
import {
  createFlowRecorder,
  getFlowLog,
  normalizeFlowToken,
} from '../../src/lib/flow-recorder.js';

describe('flow recorder', () => {
  it('does not create page-visible logs while disabled', () => {
    const target = {};
    const recorder = createFlowRecorder({
      enabled: false,
      target,
      now: () => 1,
    });

    expect(recorder.record({ kind: 'chunk_play' })).toBeNull();
    expect(target.__pnFlowLog).toBeUndefined();
  });

  it('records chunk and word events into the page-visible flow log when enabled', () => {
    const target = {};
    const recorder = createFlowRecorder({
      enabled: true,
      target,
      now: () => 12.25,
    });

    recorder.record({
      kind: 'chunk_play',
      chunkIndex: 1,
      mediaTime: 0,
      speechText: 'Hello',
    });
    recorder.record({
      kind: 'word',
      chunkIndex: 1,
      wordIndex: 0,
      mediaTime: 0.1,
      speechText: 'café',
      domToken: 'cafe\u0301',
    });

    expect(getFlowLog(target)).toEqual([
      {
        t: 12.25,
        kind: 'chunk_play',
        chunkIndex: 1,
        mediaTime: 0,
        speechText: 'Hello',
      },
      {
        t: 12.25,
        kind: 'word',
        chunkIndex: 1,
        wordIndex: 0,
        mediaTime: 0.1,
        speechText: 'café',
        domToken: 'cafe\u0301',
      },
    ]);
    expect(normalizeFlowToken('Straße')).toBe('strasse');
    expect(normalizeFlowToken('cafe\u0301')).toBe('cafe');
  });
});
