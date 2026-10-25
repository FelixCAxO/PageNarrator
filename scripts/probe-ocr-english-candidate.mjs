// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import * as reference from 'onnxruntime-node';
import { WasmOcrCompute } from '../src/engines/wasm-ocr-compute.js';
import { WebGpuOnnxSession } from '../src/engines/webgpu-onnx-session.js';

const kind = process.argv.includes('--latin-candidate') ? 'latin' : 'english', classes = kind === 'latin' ? 838 : 438;
const manifest = JSON.parse(await readFile(new URL(`../tests/fixtures/ocr/${kind}-rec-candidate.json`, import.meta.url), 'utf8'));
const cache = resolve(process.env.PN_OCR_CANDIDATE_DIR || `.cache/ocr-${kind}-candidate`, manifest.modelId);
const bytes = await readFile(resolve(cache, 'inference.onnx'));
if (createHash('sha256').update(bytes).digest('hex') !== manifest.files[0].sha256) throw new Error('English candidate model pin differs.');
const report = { status: 'incomplete', candidateOnly: true, productionSelection: 'unchanged', manifest,
  scope: 'Exact candidate tensors/labels against independent ORT CPU, not page quality or physical weak-device acceptance', cases: [] };
const engine = await WasmOcrCompute.create(await readFile(new URL('../public/native/ocr-engine.wasm', import.meta.url)));
let candidate, baseline;
try {
  candidate = await WebGpuOnnxSession.create(bytes, { engine });
  baseline = await reference.InferenceSession.create(bytes, { executionProviders: ['cpu'], intraOpNumThreads: 1,
    interOpNumThreads: 1, graphOptimizationLevel: 'disabled' });
  for (const shape of [[1, 3, 48, 320], [2, 3, 48, 320], [1, 3, 48, 1280]]) for (let repeat = 0; repeat < 2; repeat++) {
    const input = Float32Array.from({ length: shape.reduce((a, b) => a * b) }, (_, i) => Math.sin(i * .137 + repeat) * .5);
    const start = performance.now(), actual = await candidate.run({ [candidate.inputNames[0]]: { data: input, shape } });
    const candidateMs = performance.now() - start, referenceStart = performance.now();
    const expected = await baseline.run({ [baseline.inputNames[0]]: new reference.Tensor('float32', input, shape) });
    const referenceMs = performance.now() - referenceStart;
    const a = actual[candidate.outputNames[0]], b = expected[baseline.outputNames[0]];
    if (a.shape.join(',') !== b.dims.join(',') || a.shape.at(-1) !== classes || a.data.length !== b.data.length) throw new Error('English candidate output dimensions differ.');
    let mismatches = 0, maximumAbsolute = 0, labelMismatches = 0;
    for (let i = 0; i < a.data.length; i++) {
      if (!Number.isFinite(a.data[i]) || !Number.isFinite(b.data[i])) throw new Error('English candidate produced nonfinite probabilities.');
      const delta = Math.abs(a.data[i] - b.data[i]); maximumAbsolute = Math.max(maximumAbsolute, delta);
      if (delta > 3e-4 + Math.abs(b.data[i]) * 3e-3) mismatches++;
    }
    for (let offset = 0; offset < a.data.length; offset += classes) {
      let ai = 0, bi = 0;
      for (let c = 1; c < classes; c++) { if (a.data[offset + c] > a.data[offset + ai]) ai = c; if (b.data[offset + c] > b.data[offset + bi]) bi = c; }
      if (ai !== bi) labelMismatches++;
    }
    const result = { shape, repeat, candidateMs, referenceMs, maximumAbsolute, mismatches, labelMismatches,
      arenaBytes: engine.memory.buffer.byteLength, stats: candidate.lastRun };
    report.cases.push(result); console.log(JSON.stringify(result));
    if (mismatches || labelMismatches) throw new Error('English candidate probabilities or exact CTC labels differ.');
  }
  report.status = 'pass-tensor-scope';
} catch (error) { report.status = 'fail'; report.failure = error.message; throw error; }
finally {
  await candidate?.dispose(); await baseline?.release();
  report.remainingBuffers = engine.buffers.size; report.remainingTensors = engine.tensors.size;
  await engine.dispose();
  await mkdir('artifacts/engines', { recursive: true });
  await writeFile(`artifacts/engines/ocr-${kind}-candidate-parity.json`, `${JSON.stringify(report, null, 2)}\n`);
}
