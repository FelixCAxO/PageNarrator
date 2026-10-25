// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as oracle from 'onnxruntime-node';
import { debugOutputModel } from './lib/onnx-debug-outputs.mjs';
import { kokoroOperatorFixture } from './lib/kokoro-operator-fixture.mjs';
import { WasmKokoroCompute } from '../src/engines/kokoro-cpu-compute.js';
import { KOKORO_DATA } from '../src/tts/kokoro/model-data.js';

const cacheIndex = process.argv.indexOf('--cache');
if (cacheIndex < 0) throw new Error('Pass --cache with the verified Kokoro data directory.');
const directory = resolve(process.argv[cacheIndex + 1]);
async function pinned(path) {
  const data = await readFile(resolve(directory, path)), file = KOKORO_DATA.files.find(item => item.path === path);
  if (!file || data.byteLength !== file.bytes || createHash('sha256').update(data).digest('hex') !== file.sha256) throw new Error(`Unpinned ${path}.`);
  return data;
}
const prefix = '/encoder/bert/encoder/albert_layer_groups.0/albert_layers.0/attention_3/';
const names = ['Mul_output_0', 'Mul_1_output_0', 'Add_output_0'].map(name => `${prefix}${name}`);
const model = await pinned('onnx/model_quantized.onnx'), styleBytes = await pinned('voices/af_heart.bin');
const engine = await WasmKokoroCompute.create(await readFile(new URL('../public/native/kokoro-engine.wasm', import.meta.url)));
const report = { scope: 'Frozen real ALBERT attention inputs, candidate and ORT isolated operators both compared with Float64 scalar math rounded once to Float32; no speech-quality acceptance', cases: [] };
let baseline;
function error(actual, ideal) {
  let maximumAbsolute = 0, sum = 0, reference = 0;
  for (let i = 0; i < actual.length; i++) { const delta = Math.abs(actual[i] - ideal[i]); maximumAbsolute = Math.max(maximumAbsolute, delta); sum += delta * delta; reference += ideal[i] * ideal[i]; }
  return { maximumAbsolute, relativeRmse: Math.sqrt(sum / Math.max(1e-30, reference)) };
}
try {
  baseline = await oracle.InferenceSession.create(debugOutputModel(model, names), { executionProviders: ['cpu'], intraOpNumThreads: 1, interOpNumThreads: 1, graphOptimizationLevel: 'disabled', logSeverityLevel: 3 });
  const frozen = await baseline.run({ input_ids: new oracle.Tensor('int64', BigInt64Array.of(0n, 50n, 83n, 54n, 156n, 57n, 135n, 4n, 0n), [1, 9]),
    style: new oracle.Tensor('float32', new Float32Array(styleBytes.buffer.slice(styleBytes.byteOffset + 7 * 1024, styleBytes.byteOffset + 8 * 1024)), [1, 256]),
    speed: new oracle.Tensor('float32', Float32Array.of(1), [1]) });
  for (const op of ['MatMul', 'Softmax']) {
    const inputs = op === 'MatMul' ? [frozen[names[0]], frozen[names[1]]] : [frozen[names[2]]];
    const shape = op === 'MatMul' ? [...inputs[0].dims.slice(0, -1), inputs[1].dims.at(-1)] : [...inputs[0].dims];
    const fixtures = inputs.map((input, i) => ({ name: `x${i}`, type: 1, shape: input.dims }));
    const session = await oracle.InferenceSession.create(kokoroOperatorFixture(op, fixtures, [{ name: 'y', type: 1, shape }], op === 'Softmax' ? { axis: -1 } : {}),
      { executionProviders: ['cpu'], intraOpNumThreads: 1, interOpNumThreads: 1, graphOptimizationLevel: 'disabled' });
    const batch = engine.batch();
    try {
      const tensors = inputs.map(input => engine.upload(input.data, input.dims));
      const output = op === 'MatMul' ? batch.matmul(...tensors) : batch.softmax(tensors[0]); batch.submit();
      const actual = await engine.read(output), expected = (await session.run(Object.fromEntries(inputs.map((input, i) => [`x${i}`, input])))).y.data;
      const ideal = new Float32Array(actual.length);
      if (op === 'MatMul') {
        const m = inputs[0].dims.at(-2), n = inputs[1].dims.at(-1), k = inputs[0].dims.at(-1), count = actual.length / (m * n);
        for (let b = 0; b < count; b++) for (let row = 0; row < m; row++) for (let col = 0; col < n; col++) {
          let sum = 0; for (let i = 0; i < k; i++) sum += inputs[0].data[(b * m + row) * k + i] * inputs[1].data[(b * k + i) * n + col];
          ideal[(b * m + row) * n + col] = sum;
        }
      } else {
        const width = shape.at(-1);
        for (let offset = 0; offset < actual.length; offset += width) {
          const row = inputs[0].data.subarray(offset, offset + width), maximum = Math.max(...row);
          const values = Array.from(row, x => Math.exp(x - maximum)), sum = values.reduce((a, b) => a + b, 0);
          values.forEach((x, i) => { ideal[offset + i] = x / sum; });
        }
      }
      const result = { op, shape, ownVsDouble: error(actual, ideal), ortVsDouble: error(expected, ideal), ownVsOrt: error(actual, expected) };
      report.cases.push(result); console.log(JSON.stringify(result));
    } finally { await session.release(); await engine.releaseMany([...engine.tensors], batch.scratchBuffers()); }
  }
} finally {
  await baseline?.release(); report.remainingBuffers = engine.buffers.size; report.remainingTensors = engine.tensors.size; await engine.dispose();
  await mkdir(new URL('../artifacts/engines/', import.meta.url), { recursive: true });
  await writeFile(new URL('../artifacts/engines/kokoro-cpu-attention-accuracy.json', import.meta.url), `${JSON.stringify(report, null, 2)}\n`);
}
