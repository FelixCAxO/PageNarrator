// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { broadcastShape, tensorSize } from './tensor-shape.js';
import { axisIndex } from './index-shape.js';

export function gemmPlan(a, b, bias = null, { alpha = 1, beta = 1, transA = 0, transB = 0 } = {}) {
  tensorSize(a); tensorSize(b);
  if (a.length !== 2 || b.length !== 2 || ![0, 1].includes(transA) || ![0, 1].includes(transB)
    || alpha !== 1 || beta !== 1) throw new Error('Gemm supports rank two and unit alpha/beta.');
  const m = a[transA], k = a[1 - transA], n = b[1 - transB];
  if (k !== b[transB]) throw new RangeError('Gemm inner dimensions differ.');
  const shape = [m, n];
  if (bias && broadcastShape(bias, shape).join(',') !== shape.join(',')) throw new RangeError('Gemm bias does not broadcast to its matrix.');
  return { shape, transA: Boolean(transA), transB: Boolean(transB), m, n, k };
}

export function layerNormalizationPlan(input, scale, bias = null, { axis = -1, epsilon = 1e-5 } = {}) {
  tensorSize(input); tensorSize(scale); if (bias) tensorSize(bias);
  if (!input.length || axisIndex(axis, input.length) !== input.length - 1 || !Number.isFinite(epsilon) || epsilon < 0) throw new Error('LayerNormalization requires a final feature axis and nonnegative finite epsilon.');
  const width = input.at(-1);
  if (!width || scale.length !== 1 || scale[0] !== width || (bias && (bias.length !== 1 || bias[0] !== width))) throw new RangeError('LayerNormalization scale/bias must match its feature width.');
  return { shape: [...input], width, rows: tensorSize(input) / width, epsilon };
}

export function lstmPlan(input, weight, recurrent, bias, initialH, initialC, { hiddenSize, direction = 'bidirectional' } = {}) {
  for (const shape of [input, weight, recurrent, bias, initialH, initialC]) tensorSize(shape);
  if (!['forward', 'reverse', 'bidirectional'].includes(direction) || !Number.isInteger(hiddenSize) || hiddenSize < 1 || hiddenSize > 256
    || input.length !== 3 || weight.length !== 3 || recurrent.length !== 3 || bias.length !== 2) throw new Error('LSTM requires sequence-first inputs and hidden size 1..256.');
  const [steps, batch, features] = input, directions = direction === 'bidirectional' ? 2 : 1, hidden = hiddenSize;
  if (!batch || !features || weight.join(',') !== [directions, 4 * hidden, features].join(',')
    || recurrent.join(',') !== [directions, 4 * hidden, hidden].join(',') || bias.join(',') !== [directions, 8 * hidden].join(',')
    || initialH.join(',') !== [directions, batch, hidden].join(',') || initialC.join(',') !== initialH.join(',')) throw new RangeError('LSTM weight, bias or state dimensions differ.');
  return { steps, batch, features, directions, hidden, reverse: direction === 'reverse',
    shape: [steps, directions, batch, hidden], stateShape: [directions, batch, hidden] };
}

export function stftPlan(input, window, { frameStep, frameLength, onesided = 1 } = {}) {
  tensorSize(input); tensorSize(window);
  if ((input.length !== 2 && !(input.length === 3 && input[2] === 1)) || !Number.isSafeInteger(frameLength)
    || frameLength < 1 || frameLength > 64 || !Number.isSafeInteger(frameStep) || frameStep < 1
    || ![0, 1].includes(onesided) || window.length !== 1 || window[0] !== frameLength) throw new Error('STFT supports real signal batches and windows of 1..64 samples.');
  const [batch, samples] = input, frames = samples < frameLength ? 0 : Math.floor((samples - frameLength) / frameStep) + 1;
  const bins = onesided ? Math.floor(frameLength / 2) + 1 : frameLength;
  return { batch, samples, frames, bins, frameLength, frameStep, shape: [batch, frames, bins, 2] };
}

/** Independent scalar references for numerical kernel probes; never used as hidden GPU fallbacks. */
export function referenceLayerNormalization(input, shape, scale, bias, options = {}) {
  const plan = layerNormalizationPlan(shape, [scale.length], bias ? [bias.length] : null, options);
  if (input.length !== tensorSize(shape)) throw new RangeError('LayerNormalization data length differs.');
  const output = new Float32Array(input.length);
  for (let row = 0; row < plan.rows; row++) {
    const offset = row * plan.width;
    let mean = 0, variance = 0;
    for (let i = 0; i < plan.width; i++) mean += input[offset + i];
    mean /= plan.width;
    for (let i = 0; i < plan.width; i++) variance += (input[offset + i] - mean) ** 2;
    const inverse = 1 / Math.sqrt(variance / plan.width + plan.epsilon);
    for (let i = 0; i < plan.width; i++) output[offset + i] = (input[offset + i] - mean) * inverse * scale[i] + (bias?.[i] ?? 0);
  }
  return output;
}

export function referenceLstm(input, weight, recurrent, bias, initialH, initialC, inputShape, options) {
  const d = (options.direction ?? 'bidirectional') === 'bidirectional' ? 2 : 1, h = options.hiddenSize;
  const plan = lstmPlan(inputShape, [d, h * 4, inputShape[2]], [d, h * 4, h], [d, h * 8], [d, inputShape[1], h], [d, inputShape[1], h], options);
  for (const [data, size] of [[input, tensorSize(inputShape)], [weight, d * h * 4 * plan.features], [recurrent, d * h * 4 * h],
    [bias, d * h * 8], [initialH, d * plan.batch * h], [initialC, d * plan.batch * h]]) if (data.length !== size) throw new RangeError('LSTM reference data length differs.');
  const output = new Float32Array(tensorSize(plan.shape)), outH = new Float32Array(initialH), outC = new Float32Array(initialC);
  const sigmoid = value => 1 / (1 + Math.exp(-value));
  for (let direction = 0; direction < d; direction++) for (let batch = 0; batch < plan.batch; batch++) {
    const stateOffset = (direction * plan.batch + batch) * h;
    for (let step = 0; step < plan.steps; step++) {
      const time = direction === 1 || plan.reverse ? plan.steps - step - 1 : step;
      const nextH = new Float32Array(h), nextC = new Float32Array(h);
      for (let unit = 0; unit < h; unit++) {
        const gates = new Float64Array(4);
        for (let gate = 0; gate < 4; gate++) {
          const row = (direction * 4 + gate) * h + unit;
          let sum = bias[direction * 8 * h + gate * h + unit] + bias[direction * 8 * h + (gate + 4) * h + unit];
          for (let feature = 0; feature < plan.features; feature++) sum += input[(time * plan.batch + batch) * plan.features + feature] * weight[row * plan.features + feature];
          for (let previous = 0; previous < h; previous++) sum += outH[stateOffset + previous] * recurrent[row * h + previous];
          gates[gate] = sum;
        }
        nextC[unit] = sigmoid(gates[2]) * outC[stateOffset + unit] + sigmoid(gates[0]) * Math.tanh(gates[3]);
        nextH[unit] = sigmoid(gates[1]) * Math.tanh(nextC[unit]);
        output[((time * d + direction) * plan.batch + batch) * h + unit] = nextH[unit];
      }
      outH.set(nextH, stateOffset); outC.set(nextC, stateOffset);
    }
  }
  return [output, outH, outC];
}

export function referenceStft(input, inputShape, window, options) {
  const plan = stftPlan(inputShape, [window.length], options);
  if (input.length !== tensorSize(inputShape)) throw new RangeError('STFT reference data length differs.');
  const output = new Float32Array(tensorSize(plan.shape));
  for (let batch = 0; batch < plan.batch; batch++) for (let frame = 0; frame < plan.frames; frame++) for (let bin = 0; bin < plan.bins; bin++) {
    let real = 0, imaginary = 0;
    for (let sample = 0; sample < plan.frameLength; sample++) {
      const value = input[batch * plan.samples + frame * plan.frameStep + sample] * window[sample];
      const angle = -2 * Math.PI * bin * sample / plan.frameLength;
      real += value * Math.cos(angle); imaginary += value * Math.sin(angle);
    }
    const offset = ((batch * plan.frames + frame) * plan.bins + bin) * 2;
    output[offset] = real; output[offset + 1] = imaginary;
  }
  return output;
}
