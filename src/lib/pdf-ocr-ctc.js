// Diagnostic CTC alignment. Time-step boxes are estimates, not calibrated glyph bounds.
export function decodePdfOcrCtc(data, steps, alphabet, { left, top, height, inputWidth, width, inputHeight = 48, sourceLeft = null, sourceRight = null }) {
  const classes = alphabet.length;
  if (!Number.isInteger(steps) || steps < 1 || classes < 2 || data.length !== steps * classes
    || ![left, top, height, inputWidth, width].every(Number.isFinite) || height <= 0 || inputWidth <= 0 || width <= 0) {
    throw new Error('Invalid OCR CTC output or crop geometry');
  }
  const labels = new Int32Array(steps), scores = new Float64Array(steps);
  for (let step = 0; step < steps; step++) {
    let label = 0;
    for (let c = 1; c < classes; c++) if (data[step * classes + c] > data[step * classes + label]) label = c;
    labels[step] = label; scores[step] = data[step * classes + label];
  }
  return decodePdfOcrCtcLabels(labels, scores, alphabet, { left, top, height, inputWidth, width, inputHeight, sourceLeft, sourceRight });
}

export function decodePdfOcrCtcLabels(labels, scores, alphabet, { left, top, height, inputWidth, width, inputHeight = 48, sourceLeft = null, sourceRight = null }) {
  const steps = labels.length;
  if (!steps || scores.length !== steps || alphabet.length < 2
    || ![left, top, height, inputWidth, width, inputHeight].every(Number.isFinite) || height <= 0 || inputWidth <= 0 || width <= 0 || inputHeight <= 0
    || (sourceLeft !== null && (!Number.isFinite(sourceLeft) || sourceLeft < 0 || sourceRight === null))
    || (sourceRight !== null && (!Number.isFinite(sourceRight) || sourceRight <= Math.max(left, sourceLeft ?? left)))) {
    throw new Error('Invalid OCR CTC output or crop geometry');
  }
  const words = [];
  const availableWidth = sourceRight === null ? width : sourceRight - left;
  let previous = 0, word = null;
  const finish = () => { if (word) { word.confidence /= word.characters; delete word.characters; words.push(word); word = null; } };
  for (let step = 0; step < steps; step++) {
    const label = Number(labels[step]);
    if (!Number.isInteger(label) || label < 0 || label >= alphabet.length || !Number.isFinite(scores[step])) {
      throw new Error('Invalid OCR CTC label or confidence');
    }
    // A padded primary batch can emit beyond the sampled crop. Keep actual CTC
    // spans within its real pixel context; no geometry exists for padding alone.
    // Continue validating every model output, including the ignored padding.
    if (sourceRight !== null && left + (step + 1) / steps * inputWidth * height / inputHeight <= (sourceLeft ?? left)) {
      finish(); previous = 0; continue;
    }
    if (sourceRight !== null && step / steps * inputWidth * height / inputHeight >= availableWidth) {
      finish(); previous = label; continue;
    }
    const text = alphabet[label];
    if (label && label !== previous) {
      if (/^\s+$/.test(text)) finish();
      else {
        const x0 = Math.max(sourceLeft ?? left, left + Math.min(availableWidth, step / steps * inputWidth * height / inputHeight));
        const x1 = left + Math.min(availableWidth, (step + 1) / steps * inputWidth * height / inputHeight);
        word ||= { text: '', confidence: 0, characters: 0, symbols: [], bbox: { x0, y0: top, x1, y1: top + height } };
        word.text += text; word.confidence += scores[step] * 100; word.characters++;
        word.symbols.push({ text, confidence: scores[step] * 100 });
        word.bbox.x1 = x1;
      }
    } else if (label && word && !/^\s+$/.test(text)) {
      // Keep uncertainty for each emitted run without changing the word mean.
      word.symbols.at(-1).confidence = Math.max(word.symbols.at(-1).confidence, scores[step] * 100);
      word.bbox.x1 = left + Math.min(availableWidth, (step + 1) / steps * inputWidth * height / inputHeight);
    }
    previous = label;
  }
  finish();
  return words;
}
