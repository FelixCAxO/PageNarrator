// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { KOKORO_FFT_SHADER } from './kokoro-stft-shader.js';
import { stftCoefficients } from './kokoro-stft-coefficients.js';
import { KOKORO_RESIZE_SHADER } from './kokoro-resize-shader.js';
import { KOKORO_REDUCE_SHADER } from './kokoro-reduction-shaders.js';
import * as convolutionShaders from './kokoro-convolution-shaders.js';
import { contiguousStrides, transposePlan } from './index-shape.js';
import { gemmPlan, layerNormalizationPlan, lstmPlan, stftPlan } from './kokoro-kernels-shape.js';
import { KOKORO_LAYER_NORM_SHADER, KOKORO_LSTM_SHADER } from './kokoro-kernels-shaders.js';
import { KOKORO_ELEMENTWISE_SHADER, KOKORO_SOFTMAX_SHADER } from './kokoro-activation-shaders.js';
import { KOKORO_MATMUL_SHADER } from './kokoro-linear-shaders.js';
import { createKokoroDurationKernels } from './kokoro-kernels-duration.js';

const floatBits = value => new Uint32Array(Float32Array.of(value).buffer)[0];

/** Model-specific kernels, attached explicitly by the session after all pipelines prepare. */
export async function createKokoroKernels(engine) {
  const [normalization, recurrent, spectral, duration] = await Promise.all([
    engine.pipeline(KOKORO_LAYER_NORM_SHADER, 'PageNarrator Kokoro LayerNormalization'),
    engine.pipeline(KOKORO_LSTM_SHADER, 'PageNarrator Kokoro LSTM'),
    engine.pipeline(KOKORO_FFT_SHADER, 'PageNarrator Kokoro STFT'),
    createKokoroDurationKernels(engine),
  ]);
  const shaders = {
    matmul: KOKORO_MATMUL_SHADER, elementwise: KOKORO_ELEMENTWISE_SHADER, softmax: KOKORO_SOFTMAX_SHADER,
    resize1d: KOKORO_RESIZE_SHADER, reduceMean: KOKORO_REDUCE_SHADER,
    snake: convolutionShaders.KOKORO_SNAKE_SHADER, conv1d: convolutionShaders.KOKORO_CONV_1D_SHADER,
    convDirect: convolutionShaders.KOKORO_CONV_DIRECT_SHADER, convTranspose1d: convolutionShaders.KOKORO_CONV_TRANSPOSE_1D_SHADER,
    convZeroInsert1d: convolutionShaders.KOKORO_ZERO_INSERT_CONV_1D_SHADER, convZeroTail1d: convolutionShaders.KOKORO_ZERO_TAIL_CONV_1D_SHADER,
  };
  const arithmetic = Object.fromEntries(await Promise.all(Object.entries(shaders).map(async ([name, code]) => [name, await engine.pipeline(code, `PageNarrator Kokoro ${name}`)])));
  const spectra = new Map();
  return {
    arithmetic,
    ...duration,
    gemm(batch, a, b, bias = null, options = {}) {
      batch.check(a, b, ...(bias ? [bias] : []));
      const plan = gemmPlan(a.shape, b.shape, bias?.shape, options), temporary = [];
      if (plan.transA) { a = batch.index(a, transposePlan(a.shape, [1, 0])); temporary.push(a); }
      if (plan.transB) { b = batch.index(b, transposePlan(b.shape, [1, 0])); temporary.push(b); }
      const product = batch.matmul(a, b);
      const output = bias ? batch.binary('Add', product, bias) : product;
      if (bias) temporary.push(product);
      for (const tensor of temporary) batch.recycle(tensor);
      return output;
    },
    layerNormalization(batch, input, scale, bias = null, options = {}) {
      batch.check(input, scale, ...(bias ? [bias] : []));
      const plan = layerNormalizationPlan(input.shape, scale.shape, bias?.shape, options);
      const output = batch.output(plan.shape), [x, y] = batch.grid(plan.rows);
      batch.dispatchTensors(normalization, [input, scale, bias ?? scale, output],
        Uint32Array.of(plan.rows, plan.width, floatBits(plan.epsilon), x, Number(Boolean(bias)), 0, 0), x, y);
      return output;
    },
    lstm(batch, input, weight, r, bias, initialH, initialC, options) {
      batch.check(input, weight, r, bias, initialH, initialC);
      const plan = lstmPlan(input.shape, weight.shape, r.shape, bias.shape, initialH.shape, initialC.shape, options);
      const flat = batch.view(input, [1, plan.steps * plan.batch, plan.features]);
      const w = batch.index(weight, transposePlan(weight.shape, [0, 2, 1]));
      const projected = batch.matmul(flat, w);
      batch.recycle(flat); batch.recycle(w);
      const recurrentWeights = batch.index(r, transposePlan(r.shape, [0, 2, 1]));
      const output = batch.output(plan.shape), packedStates = batch.output([2, ...plan.stateShape]);
      batch.dispatchTensors(recurrent, [projected, recurrentWeights, bias, initialH, initialC, output, packedStates],
        Uint32Array.of(plan.steps, plan.batch, plan.hidden, plan.directions, Number(plan.reverse), 0), plan.directions, plan.batch);
      batch.recycle(projected); batch.recycle(recurrentWeights);
      const stateCount = plan.directions * plan.batch * plan.hidden;
      const lastH = batch.index(packedStates, { shape: plan.stateShape, strides: contiguousStrides(plan.stateShape), offset: 0 });
      const lastC = batch.index(packedStates, { shape: plan.stateShape, strides: contiguousStrides(plan.stateShape), offset: stateCount });
      batch.recycle(packedStates);
      return [output, lastH, lastC];
    },
    stft(batch, input, window, options) {
      batch.check(input, window);
      const plan = stftPlan(input.shape, window.shape, options), output = batch.output(plan.shape);
      if (!spectra.has(plan.frameLength)) spectra.set(plan.frameLength, stftCoefficients(plan.frameLength));
      const table = spectra.get(plan.frameLength), [x, y] = batch.grid(plan.batch * plan.frames);
      const parameters = new Uint32Array(10 + table.values.length);
      parameters.set([plan.batch, plan.samples, plan.frameLength, plan.frameStep, plan.frames, plan.bins, table.size, x, table.bits, 0]);
      parameters.set(table.values, 10);
      batch.dispatchTensors(spectral, [input, window, output], parameters, x, y);
      return output;
    },
  };
}
