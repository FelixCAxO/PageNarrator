// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { decodePdfOcrCtcLabels } from '../lib/pdf-ocr-ctc.js';
import { refinePdfOcrWordBounds } from '../lib/pdf-ocr-word-bounds.js';
import { decodePdfOcrCtcBeam, OCR_CTC_BEAM_POLICY } from '../lib/pdf-ocr-ctc-beam.js';

const HEIGHT = 36;
const rounded = value => value < 0 ? -Math.floor(-value + .5) : Math.floor(value + .5);

function percentile(histogram, fraction) {
  const total = histogram.reduce((sum, value) => sum + value, 0);
  const rank = Math.max(1, Math.min(total, total * fraction));
  let count = 0;
  for (let value = 0; value < 256; value++) {
    count += histogram[value];
    if (count >= rank) return value + 1 - (count - rank) / histogram[value];
  }
  throw new Error('Empty English line contrast histogram.');
}

/** Deterministic original RGBA resampling and int8 normalization, shared by Node and browsers. */
export function normalizeTesseractLine({ data, width, height }, { left = 0, top = 0, cropWidth = width, cropHeight = height } = {}) {
  if (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray) || data.length !== width * height * 4
    || ![width, height, left, top, cropWidth, cropHeight].every(Number.isInteger) || width < 1 || height < 1
    || width * height > 4_000_000 || left < 0 || top < 0 || cropWidth < 1 || cropHeight < 1
    || left + cropWidth > width || top + cropHeight > height) throw new RangeError('Invalid English line pixels or crop.');
  const outputWidth = Math.max(3, Math.ceil(cropWidth * HEIGHT / cropHeight));
  if (outputWidth > 8192) throw new RangeError('English line exceeds its width limit.');
  const gray = new Uint8Array(outputWidth * HEIGHT);
  const pixel = (x, y) => {
    const offset = ((top + y) * width + left + x) * 4, alpha = data[offset + 3];
    const intensity = (data[offset] * 77 + data[offset + 1] * 150 + data[offset + 2] * 29) / 256;
    return (intensity * alpha + 255 * (255 - alpha)) / 255;
  };
  for (let y = 0; y < HEIGHT; y++) {
    const sy = Math.max(0, Math.min(cropHeight - 1, (y + .5) * cropHeight / HEIGHT - .5));
    const y0 = Math.floor(sy), y1 = Math.min(cropHeight - 1, y0 + 1), fy = sy - y0;
    for (let x = 0; x < outputWidth; x++) {
      const sx = Math.max(0, Math.min(cropWidth - 1, (x + .5) * cropWidth / outputWidth - .5));
      const x0 = Math.floor(sx), x1 = Math.min(cropWidth - 1, x0 + 1), fx = sx - x0;
      const first = pixel(x0, y0) * (1 - fx) + pixel(x1, y0) * fx;
      const second = pixel(x0, y1) * (1 - fx) + pixel(x1, y1) * fx;
      gray[y * outputWidth + x] = Math.round(first * (1 - fy) + second * fy);
    }
  }
  const minima = new Uint32Array(256), maxima = new Uint32Array(256), center = Math.floor(HEIGHT / 2) * outputWidth;
  for (let x = 1; x + 1 < outputWidth; x++) {
    const previous = gray[center + x - 1], current = gray[center + x], next = gray[center + x + 1];
    if (current < previous && current <= next || current <= previous && current < next) minima[current]++;
    if (current > previous && current >= next || current >= previous && current > next) maxima[current]++;
  }
  if (!minima.some(Boolean)) minima[0] = 1;
  if (!maxima.some(Boolean)) maxima[255] = 1;
  const black = Math.fround(percentile(minima, .25)), white = Math.fround(percentile(maxima, .75));
  const range = Math.fround((white - black) / 2), contrast = range > 0 ? range : 1;
  const input = Int8Array.from(gray, value => Math.max(-127, Math.min(127,
    rounded(Math.fround(128 * Math.fround(Math.fround(Math.fround(value - black) / contrast) - 1))))));
  return { data: input, width: outputWidth, height: HEIGHT, black, white };
}

export function decodeTesseractLine(output, alphabet, geometry, { beam = false } = {}) {
  const steps = output?.dims?.[0];
  if (!Number.isInteger(steps) || steps < 1 || steps > 2730 || output?.dims?.[1] !== 111 || alphabet?.length !== 111 || alphabet[110] !== ''
    || !(output.data instanceof Float32Array) || output.data.length !== steps * 111) throw new Error('Invalid English line posteriors.');
  const labels = new Int32Array(steps), scores = new Float32Array(steps);
  for (let step = 0; step < steps; step++) {
    let best = 0;
    for (let c = 0; c < 111; c++) {
      const value = output.data[step * 111 + c];
      if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error('Invalid English line probability.');
      if (value > output.data[step * 111 + best]) best = c;
    }
    labels[step] = best === 110 ? 0 : best + 1; scores[step] = output.data[step * 111 + best];
  }
  const symbols = ['', ...alphabet.slice(0, 110)];
  if (beam) {
    const probabilities = new Float32Array(output.data.length);
    for (let step = 0; step < steps; step++) {
      probabilities[step * 111] = output.data[step * 111 + 110];
      probabilities.set(output.data.subarray(step * 111, step * 111 + 110), step * 111 + 1);
    }
    const result = decodePdfOcrCtcBeam(probabilities, steps, symbols, OCR_CTC_BEAM_POLICY);
    return decodePdfOcrCtcLabels(result.labels, result.scores, symbols, { ...geometry, inputHeight: HEIGHT });
  }
  // A collapsed character is emitted over an entire same-label run. Use that
  // run's strongest frame, rather than the arbitrary transition frame. This is
  // a mean character score, not a calibrated probability that a word is correct.
  for (let start = 0; start < steps;) {
    let end = start + 1, peak = scores[start];
    while (end < steps && labels[end] === labels[start]) { peak = Math.max(peak, scores[end]); end++; }
    scores[start] = peak; start = end;
  }
  return decodePdfOcrCtcLabels(labels, scores, symbols, { ...geometry, inputHeight: HEIGHT });
}

/** Explicit candidate adapter; production continues to select the retained OCR graphs. */
export function tesseractLineSession(model, { beam = false } = {}) {
  return {
    async recognizeLines(sources) {
      const results = [];
      for (const source of sources) {
        const width = source.width - 20, height = source.height - 20;
        const pixels = source.getContext('2d').getImageData(0, 0, source.width, source.height);
        const input = normalizeTesseractLine(pixels, { left: 10, top: 10, cropWidth: width, cropHeight: height });
        const output = await model.runPixels(input.data, input.width);
        const timed = decodeTesseractLine(output, model.manifest.alphabet, { left: 10, top: 10, height, width, inputWidth: input.width }, { beam });
        const words = refinePdfOcrWordBounds(timed, pixels);
        results.push({ blocks: [{ paragraphs: [{ lines: [{ bbox: { x0: 10, y0: 10, x1: width + 10, y1: height + 10 }, words }] }] }] });
      }
      return results;
    },
  };
}
