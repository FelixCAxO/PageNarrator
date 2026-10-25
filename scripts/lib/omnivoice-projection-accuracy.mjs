// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Development diagnostic: identical actual model operands, independent binary64 dot products.
import { decodeOnnxModel } from '../../src/engines/onnx-model.js';
import { bindExternalData } from '../../src/engines/onnx-external-data.js';
import { WebGpuOnnxSession } from '../../src/engines/webgpu-onnx-session.js';
import { halfToFloat } from '../../src/engines/tensor-format.js';
import { matmulFixture } from './onnx-debug-outputs.mjs';
import { binary64ToHalf } from './binary16-oracle.mjs';

export const OMNI_PROJECTION_INPUT = '/llm/layers.0/input_layernorm/Mul_1_output_0';
export async function verifyOmniProjectionAccuracy({ graph, feeds, ort, options }) {
  console.log('PN main projection: creating actual-model reference');
  const reference = await ort.InferenceSession.create(graph, options), input = {};
  let activation, shape;
  try {
    for (const [name, tensor] of Object.entries(feeds)) input[name] = new ort.Tensor(tensor.type, tensor.data, tensor.shape);
    console.log('PN main projection: reading common actual activation');
    const result = await reference.run(input, [OMNI_PROJECTION_INPUT]), tensor = result[OMNI_PROJECTION_INPUT];
    try {
      const data = await tensor.getData(); if (tensor.type !== 'float16' || data.byteLength !== tensor.size * 2) throw new Error('Projection activation is not binary16.');
      activation = new Uint16Array(new Uint16Array(data.buffer, data.byteOffset, tensor.size)); shape = [...tensor.dims];
    } finally { tensor.dispose(); }
  } finally { for (const tensor of Object.values(input)) tensor.dispose(); await reference.release(); }
  const model = bindExternalData(decodeOnnxModel(graph), options.externalData);
  const node = model.graph.nodes.find(node => node.outputs.includes('/llm/layers.0/self_attn/q_proj/MatMul_output_0'));
  const weight = model.graph.initializers.find(tensor => tensor.name === node?.inputs[1]);
  if (!node || node.inputs[0] !== OMNI_PROJECTION_INPUT || weight?.dataType !== 10 || weight.dims.length !== 2 || !weight.rawData) throw new Error('Unexpected actual projection signature.');
  const [k, n] = weight.dims, m = activation.length / k;
  console.log(`PN main projection: binary64 scalar ${m}x${k}x${n}`);
  if (shape.at(-1) !== k || !Number.isInteger(m) || m * k * n > 32_000_000) throw new Error('Unexpected projection dimensions.');
  const weightBytes = weight.rawData.slice(), weightBits = new Uint16Array(weightBytes.buffer), a = Float32Array.from(activation, halfToFloat), b = Float32Array.from(weightBits, halfToFloat);
  const expected = new Float32Array(m * n);
  for (let row = 0; row < m; row++) for (let col = 0; col < n; col++) {
    let sum = 0; for (let inner = 0; inner < k; inner++) sum += a[row * k + inner] * b[inner * n + col];
    expected[row * n + col] = halfToFloat(binary64ToHalf(sum));
  }
  const primitive = matmulFixture(10, [m, k], [k, n]), candidate = await WebGpuOnnxSession.create(primitive), validationErrors = [];
  candidate.engine.device.addEventListener('uncapturederror', event => validationErrors.push(event.error.message));
  let actual, oracle;
  try {
    console.log('PN main projection: original primitive');
    const output = (await candidate.run({ a: { data: activation, shape: [m, k], type: 'float16' }, b: { data: weightBits, shape: [k, n], type: 'float16' } }, ['y'])).y;
    actual = Float32Array.from(output.data, halfToFloat);
  } finally { await candidate.dispose(); }
  console.log('PN main projection: independent ORT primitive');
  const worker = new Worker(new URL('./omnivoice-projection-reference.mjs', import.meta.url), { type: 'module', name: 'Independent actual-projection oracle' });
  try {
    const bits = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Independent projection oracle timed out.')), 120000);
      worker.onmessage = ({ data }) => { clearTimeout(timeout); if (data.error) reject(new Error(data.error)); else resolve(data.bits); };
      worker.onerror = event => { clearTimeout(timeout); reject(new Error(event.message)); };
      worker.postMessage({ primitive, activation, weightBits, m, k, n });
    });
    oracle = Float32Array.from(bits, halfToFloat);
  } finally { worker.terminate(); }
  const metrics = values => {
    let maximumAbsolute = 0, squareError = 0, mismatches = 0;
    for (let i = 0; i < expected.length; i++) {
      const error = Math.abs(values[i] - expected[i]); if (!Number.isFinite(error)) throw new Error('Nonfinite actual projection output.');
      maximumAbsolute = Math.max(maximumAbsolute, error); squareError += error * error;
      if (error > .0001 + .001 * Math.abs(expected[i])) mismatches++;
    }
    return { maximumAbsolute, rmse: Math.sqrt(squareError / expected.length), mismatches, elements: expected.length };
  };
  const own = metrics(actual), upstream = metrics(oracle);
  const sha256 = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), n => n.toString(16).padStart(2, '0')).join('');
  const resourceCleanup = candidate.engine.buffers.size === 0 && candidate.engine.tensors.size === 0;
  const passed = own.mismatches === 0 && own.rmse <= upstream.rmse && own.maximumAbsolute <= upstream.maximumAbsolute && resourceCleanup && validationErrors.length === 0;
  return { cases: [{ name: 'Actual first-layer q projection; common pinned operands against independent binary64 then binary16 rounding',
    passed, m, k, n, own, upstream, activationSha256: await sha256(activation), weightSha256: await sha256(weightBytes), expectedSha256: await sha256(expected),
    tolerance: { absolute: .0001, relative: .001 } }], validationErrors, resourceCleanup,
  scope: 'Primitive numerical accuracy only. The original full-model parity failure is retained. No speech, token, lifecycle or performance acceptance is inferred.' };
}
