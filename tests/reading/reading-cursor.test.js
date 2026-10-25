import { describe, expect, it } from 'vitest';
import {
  createReadingCursor,
  getCompletedCursorIndex,
  getJumpIndex,
} from '../../src/lib/reading-cursor.js';

describe('reading cursor', () => {
  it('continues linearly when no jump has been requested', () => {
    expect(getCompletedCursorIndex({ currentIndex: 0, totalChunks: 4 })).toBe(1);
    expect(getCompletedCursorIndex({ currentIndex: 3, totalChunks: 4 })).toBe(4);
  });

  it('uses a pending jump exactly once after the current chunk ends', () => {
    const cursor = createReadingCursor(5);

    expect(cursor.current()).toBe(0);
    expect(cursor.requestJump(3)).toBe(3);
    expect(cursor.completeCurrent()).toBe(3);
    expect(cursor.completeCurrent()).toBe(4);
  });

  it('clamps jump targets to the available queue', () => {
    expect(getJumpIndex(-10, 5)).toBe(0);
    expect(getJumpIndex(99, 5)).toBe(4);
    expect(getJumpIndex(2, 5)).toBe(2);
    expect(getJumpIndex(0, 0)).toBe(null);
  });

  it('supports bidirectional relative jumps from the current chunk', () => {
    const cursor = createReadingCursor(4);
    cursor.requestJump(2);
    cursor.completeCurrent();

    expect(cursor.requestPrevious()).toBe(1);
    expect(cursor.completeCurrent()).toBe(1);
    expect(cursor.requestNext()).toBe(2);
    expect(cursor.completeCurrent()).toBe(2);
  });

  it('can start from a restored saved position', () => {
    const cursor = createReadingCursor(5, { initialIndex: 2 });

    expect(cursor.current()).toBe(2);
    expect(cursor.completeCurrent()).toBe(3);
  });
});
