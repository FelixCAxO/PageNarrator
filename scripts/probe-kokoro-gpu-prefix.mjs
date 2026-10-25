// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Diagnostic only: expose selected actual graph outputs without replacing their inputs.
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as oracle from 'onnxruntime-node';
import { decodeOnnxModel } from '../src/engines/onnx-model.js';
import { KOKORO_DATA } from '../src/tts/kokoro/model-data.js';
import { applyKokoroPhaseCorrection } from '../src/tts/kokoro/phase-correction.js';
import { debugOutputModel } from './lib/onnx-debug-outputs.mjs';
import { createKokoroBrowserSession } from './lib/kokoro-browser-session.mjs';
import { engineSourcePins } from './lib/engine-source-pins.mjs';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const option = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
const directory = resolve(option('--cache', `.cache/kokoro/${KOKORO_DATA.modelId}`));
const output = resolve(option('--output', 'artifacts/engines/kokoro-gpu-prefix.json'));
async function verified(path) {
  const bytes = await readFile(resolve(directory, path)), pin = KOKORO_DATA.files.find(file => file.path === path);
  if (!pin || bytes.length !== pin.bytes || createHash('sha256').update(bytes).digest('hex') !== pin.sha256) throw new Error(`Unpinned ${path}.`);
  return bytes;
}
const model = await verified('onnx/model.onnx'), corrected = await applyKokoroPhaseCorrection(model), graph = decodeOnnxModel(corrected.bytes).graph;
const names = option('--outputs', null)?.split(',') ?? (process.argv.includes('--activations') ? graph.nodes.filter(node => node.opType === 'Tanh').flatMap(node => [node.inputs[0], node.outputs[0]]) : graph.nodes.filter(node => node.opType === 'LSTM' || node.opType === 'STFT'
  || node.name === '/encoder/bert/embeddings/LayerNorm/LayerNormalization'
  || node.name === '/encoder/bert/encoder/albert_layer_groups.0/albert_layers.0/full_layer_layer_norm_11/LayerNormalization').map(node => node.outputs[0]));
if (process.argv.includes('--waveform')) names.push('waveform');
const ids = BigInt64Array.from(option('--ids', '0,43,0').split(','), BigInt), styles = await verified('voices/af_heart.bin');
const style = new Float32Array(styles.buffer.slice(styles.byteOffset + (ids.length - 2) * 1024, styles.byteOffset + (ids.length - 1) * 1024));
const feeds = { input_ids: { shape: [1, ids.length], data: ids }, style: { shape: [1, 256], data: style }, speed: { shape: [1], data: Float32Array.of(1) } };
const bytes = debugOutputModel(corrected.bytes, names), pins = await engineSourcePins(root, ['scripts/probe-kokoro-gpu-prefix.mjs', 'scripts/lib/kokoro-browser-session.mjs']);
const report = { status: 'incomplete', scope: 'Actual corrected f32 graph, exposing outputs only. Numerical diagnostic, no input injection or quality/performance acceptance.',
  ids: Array.from(ids, Number), sourcePins: pins, modelSha256: corrected.originalSha256, correctedSha256: corrected.modifiedSha256, outputs: [] };
let candidate, reference;
try {
  reference = await oracle.InferenceSession.create(bytes, { executionProviders: ['cpu'], intraOpNumThreads: 1, interOpNumThreads: 1, graphOptimizationLevel: 'disabled', logSeverityLevel: 3 });
  const expected = await reference.run(Object.fromEntries(Object.entries(feeds).map(([name, value]) => [name, new oracle.Tensor(name === 'input_ids' ? 'int64' : 'float32', value.data, value.shape)])));
  candidate = await createKokoroBrowserSession(bytes, root);
  const actual = await candidate.run(feeds);
  for (const name of names) {
    const a = actual[name], b = expected[name], record = { name, actualShape: a.shape, referenceShape: b.dims, elements: a.data.length, nonfinite: 0,
      referenceNonfinite: 0, maximumAbsoluteError: 0, relativeRmse: 0, firstNonfinite: [], minimum: Infinity, maximum: -Infinity };
    let squareError = 0, squareReference = 0;
    for (let i = 0; i < a.data.length; i++) {
      const x = a.data[i], y = b.data[i];
      if (!Number.isFinite(x)) { record.nonfinite++; if (record.firstNonfinite.length < 8) record.firstNonfinite.push(i); }
      if (!Number.isFinite(y)) record.referenceNonfinite++;
      if (Number.isFinite(x)) { record.minimum = Math.min(record.minimum, x); record.maximum = Math.max(record.maximum, x); }
      if (Number.isFinite(x) && Number.isFinite(y)) { const error = Math.abs(x - y); record.maximumAbsoluteError = Math.max(record.maximumAbsoluteError, error); squareError += error * error; squareReference += y * y; }
    }
    record.relativeRmse = Math.sqrt(squareError / Math.max(1e-30, squareReference));
    const producer = graph.nodes.find(node => node.outputs.includes(name));
    if (producer?.opType === 'Tanh' && actual[producer.inputs[0]]) record.nonfiniteInputValues = record.firstNonfinite.map(i => actual[producer.inputs[0]].data[i]);
    if (process.argv.includes('--capture')) {
      const data = new Uint8Array(Float32Array.from(a.data).buffer), file = `tensor-${report.outputs.length}.f32`;
      await mkdir(resolve(output, '..'), { recursive: true }); await writeFile(resolve(output, '..', file), data);
      record.capture = { file, sha256: createHash('sha256').update(data).digest('hex') };
    }
    report.outputs.push(record); console.log(JSON.stringify(record));
  }
  report.backend = await candidate.snapshot();
  report.status = report.outputs.some(value => value.nonfinite || value.referenceNonfinite || value.actualShape.join() !== value.referenceShape.join()) ? 'fail' : 'finite';
} catch (error) { report.status = 'fail'; report.failure = error.stack; throw error; }
finally {
  report.cleanup = await candidate?.dispose(); await reference?.release();
  report.sourcesUnchanged = JSON.stringify(pins) === JSON.stringify(await engineSourcePins(root, ['scripts/probe-kokoro-gpu-prefix.mjs', 'scripts/lib/kokoro-browser-session.mjs']));
  await mkdir(resolve(output, '..'), { recursive: true }); await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
}
if (report.status === 'fail') process.exitCode = 1;
