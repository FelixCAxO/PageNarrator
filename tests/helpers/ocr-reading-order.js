// Separate ordering evidence from WER: all anchors must occur exactly once, in order.
export function measureOcrReadingOrder(text, anchors) {
  const normalize = value => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const speech = ` ${normalize(text)} `;
  let previous = -1;
  return anchors.map(anchor => {
    const needle = ` ${normalize(anchor)} `;
    const index = speech.indexOf(needle);
    const unique = needle.trim().length > 0 && index >= 0 && speech.indexOf(needle, index + 1) < 0;
    const inOrder = unique && index > previous;
    if (unique) previous = Math.max(previous, index);
    return { anchor, index, unique, inOrder };
  });
}
