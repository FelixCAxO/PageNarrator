// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { tensorSize } from './tensor-shape.js';

function ints(values, count, fallback, minimum, label) {
  const result = values ?? new Array(count).fill(fallback);
  if (!Array.isArray(result) || result.length !== count || result.some(value => !Number.isSafeInteger(value) || value < minimum || value > 0x7fffffff)) {
    throw new RangeError(`Invalid ${label}.`);
  }
  return result;
}

function image(shape) {
  tensorSize(shape);
  ints(shape, 4, 0, 0, 'NCHW shape');
  if (shape.slice(1).some(n => !n)) throw new RangeError('Image channels and spatial dimensions must be positive.');
}

function spatial(input, kernel, { strides, dilations, pads, autoPad = 'NOTSET', ceilMode = false }, transpose = false, outputPadding = [0, 0]) {
  strides = ints(strides, 2, 1, 1, 'strides');
  dilations = ints(dilations, 2, 1, 1, 'dilations');
  if (!['NOTSET', 'VALID', 'SAME_UPPER', 'SAME_LOWER'].includes(autoPad)) throw new RangeError('Unsupported automatic padding.');
  if (pads && autoPad !== 'NOTSET') throw new RangeError('Explicit and automatic padding cannot both be set.');
  pads = [...ints(pads, 4, 0, 0, 'padding')];
  const output = [];
  for (let axis = 0; axis < 2; axis += 1) {
    const extent = dilations[axis] * (kernel[axis] - 1) + 1;
    if (autoPad.startsWith('SAME_')) {
      const target = transpose ? input[axis] * strides[axis] : Math.ceil(input[axis] / strides[axis]);
      const total = Math.max(0, transpose
        ? strides[axis] * (input[axis] - 1) + extent + outputPadding[axis] - target
        : (target - 1) * strides[axis] + extent - input[axis]);
      pads[axis] = autoPad === 'SAME_LOWER' ? Math.ceil(total / 2) : Math.floor(total / 2);
      pads[axis + 2] = total - pads[axis];
    }
    let size = transpose
      ? (input[axis] - 1) * strides[axis] - pads[axis] - pads[axis + 2] + extent + outputPadding[axis]
      : (ceilMode ? Math.ceil : Math.floor)((input[axis] + pads[axis] + pads[axis + 2] - extent) / strides[axis]) + 1;
    if (!transpose && ceilMode && (size - 1) * strides[axis] >= input[axis] + pads[axis]) size -= 1;
    if (!Number.isSafeInteger(size) || size <= 0 || size > 0x7fffffff) throw new RangeError('Invalid spatial output dimension.');
    output.push(size);
  }
  return { output, strides, dilations, pads };
}

export function convolutionPlan(input, weights, options = {}) {
  image(input); image(weights);
  const { group = 1, transpose = false } = options;
  ints([group], 1, 1, 1, 'convolution group');
  const [batch, channels, height, width] = input;
  const [weightChannels, weightInputs, kh, kw] = weights;
  const outputChannels = transpose ? weightInputs * group : weightChannels;
  if (channels % group || outputChannels % group || (transpose ? weightChannels !== channels : weightInputs !== channels / group)) {
    throw new RangeError('Convolution weights and groups do not match the input channels.');
  }
  const outputPadding = ints(options.outputPadding, 2, 0, 0, 'output padding');
  const params = spatial([height, width], [kh, kw], options, transpose, outputPadding);
  if (outputPadding.some((p, axis) => p >= Math.max(params.strides[axis], params.dilations[axis]))) throw new RangeError('Output padding must be smaller than stride or dilation.');
  const shape = [batch, outputChannels, ...params.output];
  tensorSize(shape);
  return { ...params, shape, kernel: [kh, kw], group, transpose, inputChannelsPerGroup: channels / group, outputChannelsPerGroup: outputChannels / group };
}

// A length-one height lets the same kernels perform exact 1-D convolution,
// without copying or expanding weight/input payloads.
export function liftConvolution(input, weights, options) {
  if (input.length !== 3) return { input, weights, options, squeeze: false };
  if (weights.length !== 3) throw new RangeError('Convolution weight and input ranks differ.');
  const pair = (values, fallback, minimum, label) => values ? [fallback, ...ints(values, 1, fallback, minimum, label)] : undefined;
  const pads = options.pads ? ints(options.pads, 2, 0, 0, '1-D padding') : null;
  return { input: [input[0], input[1], 1, input[2]], weights: [weights[0], weights[1], 1, weights[2]], squeeze: true,
    options: { ...options, strides: pair(options.strides, 1, 1, '1-D strides'), dilations: pair(options.dilations, 1, 1, '1-D dilations'),
      outputPadding: pair(options.outputPadding, 0, 0, '1-D output padding'), pads: pads ? [0, pads[0], 0, pads[1]] : undefined } };
}

export function poolingPlan(input, options) {
  image(input);
  const kernel = ints(options.kernel, 2, 1, 1, 'pooling kernel');
  const params = spatial(input.slice(2), kernel, options);
  const shape = [...input.slice(0, 2), ...params.output];
  tensorSize(shape);
  return { ...params, shape, kernel };
}

export function reductionPlan(input, axes, keepDims = true) {
  tensorSize(input);
  const rank = input.length;
  const normalized = (axes ?? input.map((_, i) => i)).map(axis => {
    if (!Number.isSafeInteger(axis) || axis < -rank || axis >= rank) throw new RangeError('Reduction axis is out of range.');
    return (axis + rank) % rank;
  });
  if (new Set(normalized).size !== normalized.length) throw new RangeError('Reduction axes must be distinct.');
  const mask = normalized.reduce((value, axis) => value | (1 << axis), 0);
  const shape = input.flatMap((dim, axis) => mask & (1 << axis) ? keepDims ? [1] : [] : [dim]);
  return { shape, mask, reductionSize: normalized.reduce((size, axis) => size * input[axis], 1) };
}

export function resizePlan(input, { scales = null, sizes = null, mode = 'nearest', coordinateMode = 'half_pixel', nearestMode = 'round_prefer_floor' } = {}) {
  image(input);
  if ((scales?.length > 0) === (sizes?.length > 0)) throw new RangeError('Resize requires exactly one of scales or sizes.');
  if (sizes?.length) ints(sizes, 4, 1, 1, 'resize sizes');
  if (scales?.length && (scales.length !== 4 || scales.some(s => !Number.isFinite(s) || s <= 0))) throw new RangeError('Invalid resize scales.');
  const shape = sizes?.length ? [...sizes] : input.map((dim, axis) => Math.floor(dim * scales[axis]));
  if (shape[0] !== input[0] || shape[1] !== input[1] || shape.slice(2).some(n => !n)) throw new RangeError('Resize supports positive spatial dimensions with unchanged N and C.');
  if (scales?.length && (scales[0] !== 1 || scales[1] !== 1)) throw new RangeError('Resize does not resample N or C.');
  if (!['nearest', 'linear'].includes(mode)) throw new RangeError(`Unsupported resize mode ${mode}.`);
  const coordinates = ['half_pixel', 'align_corners', 'asymmetric', 'pytorch_half_pixel'];
  const nearest = ['round_prefer_floor', 'round_prefer_ceil', 'floor', 'ceil'];
  if (!coordinates.includes(coordinateMode) || !nearest.includes(nearestMode)) throw new RangeError('Unsupported resize coordinate or rounding mode.');
  tensorSize(shape);
  return { shape, scales: scales?.length ? scales.slice(2) : [shape[2] / input[2], shape[3] / input[3]], mode: Number(mode === 'linear'), coordinateMode: coordinates.indexOf(coordinateMode), nearestMode: nearest.indexOf(nearestMode) };
}

export function concatPlan(shapes, axis) {
  if (!shapes.length) throw new RangeError('Concat requires at least one input.');
  shapes.forEach(tensorSize);
  const rank = shapes[0].length;
  if (!Number.isSafeInteger(axis) || axis < -rank || axis >= rank) throw new RangeError('Concat axis is out of range.');
  axis = (axis + rank) % rank;
  const shape = [...shapes[0]];
  shape[axis] = 0;
  for (const input of shapes) {
    if (input.length !== rank || input.some((dim, i) => i !== axis && dim !== shape[i])) throw new RangeError('Concat input shapes do not match.');
    shape[axis] += input[axis];
  }
  tensorSize(shape);
  return { shape, axis, innerSize: shape.slice(axis + 1).reduce((a, b) => a * b, 1) };
}
