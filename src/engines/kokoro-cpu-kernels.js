// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { transposePlan, batchedMatmulPlan, axisIndex } from './index-shape.js';
import { tensorSize } from './tensor-shape.js';
import { gemmPlan, layerNormalizationPlan, lstmPlan, stftPlan } from './kokoro-kernels-shape.js';
import { cumulativeSumPlan, scatterNdPlan, KOKORO_UNARY_OPERATIONS } from './kokoro-kernels-duration.js';
import { convolutionPlan, liftConvolution } from './cnn-shape.js';

const bits = value => new Uint32Array(Float32Array.of(value).buffer)[0];
const quantized = tensor => ['int8', 'uint8'].includes(tensor.dataType);
function qcheck(batch, ...inputs) {
  batch.checkOwnership(...inputs);
  if (inputs.some(input => !quantized(input))) throw new Error('Quantized kernels require int8 or uint8 storage.');
}
function zeroPoint(input, zero, length = 1) {
  if (zero && (zero.dataType !== input.dataType || (zero.length !== 1 && (zero.shape.length !== 1 || zero.length !== length)))) throw new RangeError('Quantization zero point has a different type or shape.');
}
function scratchTranspose(batch, tensor, temporary) {
  const rank = tensor.shape.length, axes = tensor.shape.map((_, i) => i);
  [axes[rank - 2], axes[rank - 1]] = [axes[rank - 1], axes[rank - 2]];
  const result = batch.index(tensor, transposePlan(tensor.shape, axes)); temporary.push(result); return result;
}

/** The same speech delegate API as WebGPU, executed in the shared persistent WASM arena. */
export function createKokoroCpuKernels(engine) {
  engine.checkOpen();
  const kernels = {
    gemm(batch, a, b, bias = null, options = {}) {
      batch.check(a, b, ...(bias ? [bias] : []));
      const plan = gemmPlan(a.shape, b.shape, bias?.shape, options), temporary = [];
      if (plan.transA) a = scratchTranspose(batch, a, temporary);
      if (plan.transB) b = scratchTranspose(batch, b, temporary);
      const product = batch.matmul(a, b), output = bias ? batch.binary('Add', product, bias) : product;
      if (bias) temporary.push(product);
      for (const tensor of temporary) batch.recycle(tensor);
      return output;
    },
    layerNormalization(batch, input, scale, bias = null, options = {}) {
      batch.check(input, scale, ...(bias ? [bias] : []));
      const plan = layerNormalizationPlan(input.shape, scale.shape, bias?.shape, options), output = batch.output(plan.shape);
      batch.command('pn_kokoro_layer_norm', [input, scale, bias ?? scale, output], Uint32Array.of(plan.rows, plan.width, bits(plan.epsilon), Number(Boolean(bias))));
      return output;
    },
    lstm(batch, input, weight, recurrent, bias, initialH, initialC, options) {
      batch.check(input, weight, recurrent, bias, initialH, initialC);
      const plan = lstmPlan(input.shape, weight.shape, recurrent.shape, bias.shape, initialH.shape, initialC.shape, options);
      const outputs = [batch.output(plan.shape), batch.output(plan.stateShape), batch.output(plan.stateShape)];
      batch.command('pn_kokoro_lstm', [input, weight, recurrent, bias, initialH, initialC, ...outputs],
        Uint32Array.of(plan.steps, plan.batch, plan.features, plan.hidden, plan.directions, Number(plan.reverse)));
      return outputs;
    },
    stft(batch, input, window, options) {
      batch.check(input, window);
      const plan = stftPlan(input.shape, window.shape, options), output = batch.output(plan.shape);
      batch.command('pn_kokoro_stft', [input, window, output], Uint32Array.of(plan.batch, plan.samples, plan.frameLength, plan.frameStep, plan.frames, plan.bins));
      return output;
    },
    cumsum(batch, input, axis, options = {}) {
      batch.checkOwnership(input);
      if (!['float32', 'int32'].includes(input.dataType)) throw new Error('Cumulative sum requires float32 or int32.');
      const plan = cumulativeSumPlan(input.shape, axis, options);
      let bounds = null;
      if (input.dataType === 'int32') {
        const min = input.bounds ? Math.min(0, input.bounds.min * plan.length) : -2147483648;
        const max = input.bounds ? Math.max(0, input.bounds.max * plan.length) : 2147483647;
        // Native int64 accumulation checks every prefix before narrowing, including unknown input ranges.
        bounds = { min: Math.max(-2147483648, min), max: Math.min(2147483647, max) };
      }
      const output = batch.output(plan.shape, input.dataType, bounds);
      batch.command('pn_kokoro_cumsum', [input, output], Uint32Array.of(plan.outer, plan.length, plan.inner, Number(input.dataType === 'int32')));
      return output;
    },
    scatterNd(batch, input, indices, indexShape, updates) {
      batch.check(input, updates);
      const plan = scatterNdPlan(input.shape, indices, indexShape, updates.shape), output = batch.copy(input);
      if (plan.offsets.length > 2046) throw new RangeError('CPU ScatterND exceeds its bounded parameter slot.');
      batch.command('pn_kokoro_scatter', [updates, output], Uint32Array.of(plan.count, plan.blockSize, ...plan.offsets));
      return output;
    },
    unary(batch, input, operation, { alpha = .01, min = -Infinity, max = Infinity } = {}) {
      batch.check(input);
      const code = { ...KOKORO_UNARY_OPERATIONS, Sin: 5, Cos: 6, FastGelu: 7, Tanh: 8 }[operation];
      if (code === undefined || !Number.isFinite(alpha) || Number.isNaN(min) || Number.isNaN(max) || min > max) throw new Error('Invalid speech CPU activation.');
      const output = batch.output(input.shape);
      batch.command('pn_kokoro_unary', [input, output], Uint32Array.of(input.length, code, bits(alpha), bits(min), bits(max)));
      return output;
    },
    dynamicQuantizeLinear(batch, input) {
      batch.check(input);
      const output = batch.output(input.shape, 'uint8', { min: 0, max: 255 });
      const scale = batch.output([]), zero = batch.output([], 'uint8', { min: 0, max: 255 });
      batch.command('pn_kokoro_dynamic_quantize', [input, output, scale, zero], Uint32Array.of(input.length));
      return [output, scale, zero];
    },
    dequantizeLinear(batch, input, scale, zero = null, { axis = 1 } = {}) {
      qcheck(batch, input, ...(zero ? [zero] : [])); batch.check(scale);
      if (scale.length !== 1) {
        axis = axisIndex(axis, input.shape.length);
        if (scale.shape.length !== 1 || scale.length !== input.shape[axis]) throw new RangeError('Dequantization scale must be scalar or match its channel axis.');
      }
      if (zero && (zero.dataType !== input.dataType || zero.shape.join(',') !== scale.shape.join(','))) throw new RangeError('Dequantization scale/zero point shapes differ.');
      const output = batch.output(input.shape), inner = scale.length === 1 ? 1 : tensorSize(input.shape.slice(axis + 1));
      batch.command('pn_kokoro_dequantize', [input, scale, zero ?? input, output], Uint32Array.of(input.length, scale.length, inner, Number(input.dataType === 'int8'), Number(Boolean(zero))));
      return output;
    },
    matmulInteger(batch, a, b, az = null, bz = null) {
      qcheck(batch, a, b, ...[az, bz].filter(Boolean));
      const plan = batchedMatmulPlan(a.shape, b.shape), k = a.shape.at(-1), n = b.shape.at(-1);
      zeroPoint(a, az); zeroPoint(b, bz, n);
      if (k * 255 * 255 > 2147483647) throw new RangeError('Quantized matrix product may overflow int32.');
      const output = batch.output(plan.shape, 'int32', { min: -k * 65025, max: k * 65025 }), p = new Uint32Array(40);
      p.set([a.shape.at(-2), n, k, plan.batch.length, tensorSize(plan.batch), Number(a.dataType === 'int8'), Number(b.dataType === 'int8'), Number(Boolean(az)), bz?.length ?? 0]);
      p.set(plan.batch, 16); p.set(plan.aStrides, 24); p.set(plan.bStrides, 32);
      batch.command('pn_kokoro_matmul_integer', [a, b, az ?? a, bz ?? b, output], p);
      return output;
    },
    convInteger(batch, input, weight, xz = null, wz = null, options = {}) {
      qcheck(batch, input, weight, ...[xz, wz].filter(Boolean));
      if (input.shape.length !== 3 || weight.shape.length !== 3 || options.transpose) throw new Error('Quantized speech convolution requires one spatial dimension.');
      const lifted = liftConvolution(input.shape, weight.shape, options), plan = convolutionPlan(lifted.input, lifted.weights, lifted.options);
      zeroPoint(input, xz); zeroPoint(weight, wz, plan.shape[1]);
      const products = plan.inputChannelsPerGroup * plan.kernel[1], magnitude = products * 65025;
      if (magnitude > 2147483647) throw new RangeError('Quantized convolution may overflow int32.');
      const output = batch.output([plan.shape[0], plan.shape[1], plan.shape[3]], 'int32', { min: -magnitude, max: magnitude });
      const tile = plan.inputChannelsPerGroup > 1 && products >= 8 ? Math.min(32, plan.shape[3]) : 0;
      const scratch = tile ? batch.output([tile * products * 2], 'uint8') : input;
      batch.command('pn_kokoro_conv_integer', [input, weight, xz ?? input, wz ?? weight, output, scratch], Uint32Array.of(input.shape[0], input.shape[1], input.shape[2], plan.shape[1], plan.shape[3],
        plan.inputChannelsPerGroup, plan.outputChannelsPerGroup, plan.kernel[1], plan.strides[1], plan.dilations[1], plan.pads[1],
        Number(input.dataType === 'int8'), Number(weight.dataType === 'int8'), Number(Boolean(xz)), wz?.length ?? 0, tile));
      if (tile) batch.recycle(scratch);
      return output;
    },
    dynamicQuantizeLstm(batch, input, weight, recurrent, bias, initialH, initialC, wScale, wZero, rScale, rZero, options) {
      batch.check(input, bias, initialH, initialC, wScale, rScale); qcheck(batch, weight, recurrent, wZero, rZero);
      const weightShape = [weight.shape[0], weight.shape[2], weight.shape[1]], recurrentShape = [recurrent.shape[0], recurrent.shape[2], recurrent.shape[1]];
      const plan = lstmPlan(input.shape, weightShape, recurrentShape, bias.shape, initialH.shape, initialC.shape, options);
      if (plan.features * 65025 > 2147483647) throw new RangeError('Quantized recurrent projection may overflow int32.');
      const shapeCheck = (data, zero, weights) => {
        if (data.shape.join(',') !== zero.shape.join(',') || zero.dataType !== weights.dataType
          || (data.shape.join(',') !== [plan.directions].join(',') && data.shape.join(',') !== [plan.directions, 4 * plan.hidden].join(','))) throw new RangeError('Quantized LSTM needs per-direction or per-gate scales and zero points.');
      };
      shapeCheck(wScale, wZero, weight); shapeCheck(rScale, rZero, recurrent);
      const outputs = [batch.output(plan.shape), batch.output(plan.stateShape), batch.output(plan.stateShape)];
      const scratch = batch.output(input.shape, 'uint8');
      batch.command('pn_kokoro_dynamic_lstm', [input, weight, recurrent, bias, initialH, initialC, wScale, wZero, rScale, rZero, ...outputs, scratch],
        Uint32Array.of(plan.steps, plan.batch, plan.features, plan.hidden, plan.directions, Number(plan.reverse), Number(weight.dataType === 'int8'), Number(recurrent.dataType === 'int8'), Number(wScale.shape.length === 2), Number(rScale.shape.length === 2)));
      batch.recycle(scratch); return outputs;
    },
    fastGelu(batch, input, bias = null) {
      batch.check(input, ...(bias ? [bias] : []));
      if (bias && (bias.shape.length !== 1 || bias.length !== input.shape.at(-1))) throw new RangeError('FastGelu bias must match its final dimension.');
      const summed = bias ? batch.binary('Add', input, bias) : input, output = kernels.unary(batch, summed, 'FastGelu');
      if (bias) batch.recycle(summed); return output;
    },
    skipLayerNormalization(batch, input, skip, gamma, beta = null, bias = null, options = {}) {
      batch.check(input, skip, gamma, ...[beta, bias].filter(Boolean));
      if (input.shape.join(',') !== skip.shape.join(',')) throw new RangeError('SkipLayerNormalization input shapes differ.');
      const sum = batch.binary('Add', input, skip), combined = bias ? batch.binary('Add', sum, bias) : sum;
      const output = kernels.layerNormalization(batch, combined, gamma, beta, options);
      batch.recycle(sum); if (bias) batch.recycle(combined); return output;
    },
    fusedMatmul(batch, a, b, { alpha = 1, transA = 0, transB = 0, transBatchA = 0, transBatchB = 0 } = {}) {
      batch.check(a, b);
      if (alpha !== 1 || transBatchA !== 0 || transBatchB !== 0 || ![0, 1].includes(transA) || ![0, 1].includes(transB)) throw new Error('FusedMatMul supports unit alpha and optional last-axis transpose.');
      const temporary = [];
      if (transA) a = scratchTranspose(batch, a, temporary);
      if (transB) b = scratchTranspose(batch, b, temporary);
      const output = batch.matmul(a, b); for (const tensor of temporary) batch.recycle(tensor); return output;
    },
  };
  return kernels;
}
