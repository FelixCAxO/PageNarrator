import { describe, expect, it } from 'vitest';
import {
  createProgressiveSegmentChunk,
  getChunkAnchorText,
  getChunkDomWordOffset,
  getChunkHighlightText,
  getChunkSpeechText,
} from '../../src/lib/reader-engine-chunks.js';

describe('readerEngine chunk helpers', () => {
  it('normalizes strings, compact PDF history, and structured chunks through one cohesive API', () => {
    expect(getChunkSpeechText('Plain text.')).toBe('Plain text.');
    expect(getChunkSpeechText({ speech: 'Speech text.', text: 'Fallback text.' })).toBe('Speech text.');
    expect(getChunkSpeechText({ compact: true, preview: 'Stored PDF preview.' })).toBe('Stored PDF preview.');

    expect(getChunkAnchorText({ anchorText: 'Raw DOM text.', speech: 'Speech text.' })).toBe('Raw DOM text.');
    expect(getChunkHighlightText({ chunkText: 'Chunk-local text.', speech: 'Full text.' })).toBe('Chunk-local text.');
    expect(getChunkDomWordOffset({ domWordOffset: 4.7 })).toBe(4);
  });

  it('offsets progressive segment chunks by the spoken words already consumed', () => {
    const chunk = {
      speech: 'one two three four',
      anchorText: 'one two three four',
      domWordOffset: 10,
      globalDomWordStartIndex: 10,
      anchorId: 'p1',
    };

    expect(createProgressiveSegmentChunk(chunk, {
      text: 'three four',
      speechWordOffset: 2,
    })).toMatchObject({
      speech: 'three four',
      text: 'three four',
      anchorText: 'one two three four',
      domWordOffset: 12,
      globalDomWordStartIndex: 12,
      anchorId: 'p1',
    });
  });
});
