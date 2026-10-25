// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { contiguousStrides, transposePlan } from './index-shape.js';
import { gemmPlan, layerNormalizationPlan, lstmPlan, stftPlan } from './kokoro-kernels-shape.js';
import { KOKORO_LAYER_NORM_SHADER, KOKORO_LSTM_SHADER, KOKORO_STFT_SHADER } from './kokoro-kernels-shaders.js';
import { createKokoroDurationKernels } from './kokoro-kernels-duration.js';

const floatBits = value => new Uint32Array(Float32Array.of(value).buffer)[0];

/** Model-specific kernels, attached explicitly by the session after all pipelines prepare. */
export async function createKokoroKernels(engine) {
  const [normalization, recurrent, spectral, duration] = await Promise.all([
    engine.pipeline(KOKORO_LAYER_NORM_SHADER, 'PageNarrator Kokoro LayerNormalization'),
    engine.pipeline(KOKORO_LSTM_SHADER, 'PageNarrator Kokoro LSTM'),
    engine.pipeline(KOKORO_STFT_SHADER, 'PageNarrator Kokoro STFT'),
    createKokoroDurationKernels(engine),
  ]);
  return {
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
        Uint32Array.of(plan.rows, plan.width, floatBits(plan.epsilon), x, Number(Boolean(bias))), x, y);
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
        Uint32Array.of(plan.steps, plan.batch, plan.hidden, plan.directions, Number(plan.reverse)), plan.directions, plan.batch);
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
      const pairs = plan.batch * plan.frames * plan.bins, [x, y] = batch.grid(Math.ceil(pairs / 64));
      batch.dispatchTensors(spectral, [input, window, output],
        Uint32Array.of(plan.batch, plan.samples, plan.frameLength, plan.frameStep, plan.frames, plan.bins, pairs, x), x, y);
      return output;
    },
  };
}
