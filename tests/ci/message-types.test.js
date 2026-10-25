import { describe, expect, it } from 'vitest';
import {
  CONTENT_MESSAGE_TYPES,
  MESSAGE_TYPES,
  PDF_VIEWER_MESSAGE_TYPES,
  READER_ACTION_TYPES,
  RUNTIME_MESSAGE_TYPES,
} from '../../src/lib/message-types.js';

describe('message type registry', () => {
  it('centralizes runtime, content, PDF viewer, and reader action protocol strings', () => {
    expect(MESSAGE_TYPES).toMatchObject({
      READER_STATE_CHANGED: 'readerStateChanged',
      READER_ENGINE_ACTION: 'readerEngineAction',
      EXTRACT: 'extract',
      HIGHLIGHT_WORD_PLAN: 'highlightWordPlan',
      HIGHLIGHT_PLAN_RESYNC: 'highlightPlanResync',
      GET_FLOW_LOG: 'getFlowLog',
      GET_PDF_CHUNK: 'getPdfChunk',
      CLOSE_PDF_CHUNK_STREAM: 'closePdfChunkStream',
    });

    expect(RUNTIME_MESSAGE_TYPES.READER_ENGINE_ACTION).toBe(MESSAGE_TYPES.READER_ENGINE_ACTION);
    expect(CONTENT_MESSAGE_TYPES.HIGHLIGHT_CHUNK).toBe(MESSAGE_TYPES.HIGHLIGHT_CHUNK);
    expect(CONTENT_MESSAGE_TYPES.GET_FLOW_LOG).toBe(MESSAGE_TYPES.GET_FLOW_LOG);
    expect(PDF_VIEWER_MESSAGE_TYPES.GET_PDF_CHUNK).toBe(MESSAGE_TYPES.GET_PDF_CHUNK);
    expect(READER_ACTION_TYPES.TOGGLE_PLAYBACK).toBe('togglePlayback');
  });

  it('keeps registries frozen so protocol values cannot drift at runtime', () => {
    expect(Object.isFrozen(MESSAGE_TYPES)).toBe(true);
    expect(Object.isFrozen(RUNTIME_MESSAGE_TYPES)).toBe(true);
    expect(Object.isFrozen(CONTENT_MESSAGE_TYPES)).toBe(true);
    expect(Object.isFrozen(PDF_VIEWER_MESSAGE_TYPES)).toBe(true);
    expect(Object.isFrozen(READER_ACTION_TYPES)).toBe(true);
  });
});
