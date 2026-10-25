export function getJumpIndex(targetIndex, totalChunks) {
  if (!Number.isFinite(totalChunks) || totalChunks <= 0) return null;
  const target = Number.isFinite(targetIndex) ? Math.trunc(targetIndex) : 0;
  return Math.max(0, Math.min(totalChunks - 1, target));
}

/**
 * @param {{ currentIndex?: number, totalChunks?: number, pendingJumpIndex?: number | null }} options
 */
export function getCompletedCursorIndex({ currentIndex, totalChunks, pendingJumpIndex = null } = {}) {
  if (Number.isFinite(pendingJumpIndex)) {
    const jumpIndex = getJumpIndex(pendingJumpIndex, totalChunks);
    if (jumpIndex !== null) return jumpIndex;
  }

  const current = Number.isFinite(currentIndex) ? Math.trunc(currentIndex) : 0;
  return Math.max(0, Math.min(totalChunks, current + 1));
}

export function createReadingCursor(totalChunks, { initialIndex = 0 } = {}) {
  let currentIndex = getJumpIndex(initialIndex, totalChunks) ?? 0;
  let pendingJumpIndex = null;

  return {
    current() {
      return currentIndex;
    },
    pending() {
      return pendingJumpIndex;
    },
    requestJump(targetIndex) {
      pendingJumpIndex = getJumpIndex(targetIndex, totalChunks);
      return pendingJumpIndex;
    },
    requestNext() {
      return this.requestJump(currentIndex + 1);
    },
    requestPrevious() {
      return this.requestJump(currentIndex - 1);
    },
    completeCurrent() {
      currentIndex = getCompletedCursorIndex({
        currentIndex,
        totalChunks,
        pendingJumpIndex,
      });
      pendingJumpIndex = null;
      return currentIndex;
    },
  };
}
