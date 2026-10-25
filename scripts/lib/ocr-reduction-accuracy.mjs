// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { spatialMeanFixture } from './onnx-debug-outputs.mjs';
import { WebGpuOnnxSession } from '../../src/engines/webgpu-onnx-session.js';

/** Fixed real-model operands; binary64 accumulation is independent of both runtimes. */
export async function verifyOcrReductionAccuracy(ort, input, shape) {
  if (!(input instanceof Float32Array) || shape.join(',') !== '1,32,192,320' || input.length !== 1966080) throw new Error('Unexpected pinned detector reduction operands.');
  const primitive = spatialMeanFixture(shape), area = shape[2] * shape[3], expected = new Float32Array(shape[0] * shape[1]);
  for (let channel = 0; channel < expected.length; channel++) {
    let sum = 0; for (let pixel = 0; pixel < area; pixel++) sum += input[channel * area + pixel];
    expected[channel] = sum / area;
  }
  const validationErrors = [], candidate = await WebGpuOnnxSession.create(primitive);
  candidate.engine.device.addEventListener('uncapturederror', event => validationErrors.push(event.error.message));
  let actual, oracle, reference;
  try {
    actual = (await candidate.run({ x: { data: input, shape } }, ['y'])).y.data;
    reference = await ort.InferenceSession.create(primitive, { executionProviders: ['wasm'], graphOptimizationLevel: 'disabled', logSeverityLevel: 3 });
    const tensor = new ort.Tensor('float32', input, shape);
    try {
      const result = await reference.run({ x: tensor });
      try { oracle = new Float32Array(await result.y.getData()); } finally { result.y.dispose(); }
    } finally { tensor.dispose(); }
  } finally { await candidate.dispose(); await reference?.release(); }
  const tolerance = { absolute: .0001, relative: .0001 };
  const metrics = values => {
    let maximumAbsolute = 0, squareError = 0, mismatches = 0;
    for (let i = 0; i < expected.length; i++) {
      const error = Math.abs(values[i] - expected[i]); if (!Number.isFinite(error)) throw new Error('Nonfinite reduction output.');
      maximumAbsolute = Math.max(maximumAbsolute, error); squareError += error ** 2;
      if (error > tolerance.absolute + tolerance.relative * Math.abs(expected[i])) mismatches++;
    }
    return { maximumAbsolute, rmse: Math.sqrt(squareError / expected.length), mismatches, elements: expected.length };
  };
  const own = metrics(actual), upstream = metrics(oracle);
  const digest = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), n => n.toString(16).padStart(2, '0')).join('');
  const resourceCleanup = candidate.engine.buffers.size === 0 && candidate.engine.tensors.size === 0;
  return { cases: [{ name: 'First detector spatial mean; common actual operands against binary64 accumulation rounded to float32',
    passed: own.mismatches === 0 && own.rmse <= upstream.rmse && own.maximumAbsolute <= upstream.maximumAbsolute,
    shape, tolerance, own, upstream, inputSha256: await digest(input), expectedSha256: await digest(expected),
    values: Array.from(expected, (value, i) => ({ expected: value, actual: actual[i], upstream: oracle[i] })) }],
  resourceCleanup, validationErrors, scope: 'Primitive accuracy only. The large full-model strict reference failure is preserved; no OCR quality or performance acceptance is inferred.' };
}
