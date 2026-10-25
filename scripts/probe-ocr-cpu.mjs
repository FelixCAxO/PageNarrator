// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import * as reference from 'onnxruntime-node';
import { WasmOcrCompute } from '../src/engines/wasm-ocr-compute.js';
import { WebGpuOnnxSession } from '../src/engines/webgpu-onnx-session.js';

const large = process.argv.includes('--large');
const profile = process.argv.includes('--profile');
const report = { status: 'incomplete', reference: 'ONNX Runtime Node CPU, one thread, graph optimizations disabled',
  scope: 'Exact retained OCR graphs; numerical parity and lifecycle, not photograph quality or weak-device performance', cases: [] };
const engine = await WasmOcrCompute.create(await readFile(new URL('../public/native/ocr-engine.wasm', import.meta.url)));
let operationMs = {};
if (profile) {
  const invoke = engine.invoke.bind(engine);
  engine.invoke = (name, ...args) => {
    const start = performance.now();
    try { return invoke(name, ...args); }
    finally { operationMs[name] = (operationMs[name] || 0) + performance.now() - start; }
  };
}
try {
  for (const [file, shape] of [['tiny-det.onnx', large ? [1, 3, 768, 1280] : [1, 3, 64, 96]], ['small-rec.onnx', [1, 3, 48, 320]], ['small-rec.onnx', [2, 3, 48, 320]]]) {
    const bytes = await readFile(new URL(`../public/assets/ocr/${file}`, import.meta.url));
    const candidate = await WebGpuOnnxSession.create(bytes, { engine });
    const baseline = await reference.InferenceSession.create(bytes, { executionProviders: ['cpu'], intraOpNumThreads: 1,
      interOpNumThreads: 1, graphOptimizationLevel: 'disabled' });
    try {
      for (let repeat = 0; repeat < 2; repeat++) {
        const input = Float32Array.from({ length: shape.reduce((a, b) => a * b) }, (_, i) => Math.sin(i * 0.113 + repeat) * 0.5);
        operationMs = {}; const before = performance.now();
        const actual = await candidate.run({ [candidate.inputNames[0]]: { data: input, shape } });
        const candidateMs = performance.now() - before;
        const expected = await baseline.run({ [baseline.inputNames[0]]: new reference.Tensor('float32', input, shape) });
        const outputs = [];
        for (const [name, tensor] of Object.entries(actual)) {
          const other = expected[name];
          if (tensor.shape.join(',') !== other.dims.join(',') || tensor.data.length !== other.data.length) throw new Error(`OCR CPU output shape differs: ${file}/${name}`);
          let maximumAbsolute = 0, maximumRelative = 0, mismatches = 0;
          for (let i = 0; i < tensor.data.length; i++) {
            const a = Number(tensor.data[i]), b = Number(other.data[i]);
            if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error(`Nonfinite OCR CPU output: ${file}/${name}`);
            const delta = Math.abs(a - b); maximumAbsolute = Math.max(maximumAbsolute, delta);
            maximumRelative = Math.max(maximumRelative, delta / Math.max(1e-5, Math.abs(b)));
            if (typeof tensor.data[i] === 'bigint' ? tensor.data[i] !== other.data[i] : delta > 3e-4 + Math.abs(b) * 3e-3) mismatches++;
          }
          outputs.push({ name, shape: tensor.shape, maximumAbsolute, maximumRelative, mismatches });
          if (mismatches) throw new Error(`OCR CPU differs: ${file}/${name}: ${JSON.stringify(outputs.at(-1))}`);
        }
        report.cases.push({ file, modelSha256: createHash('sha256').update(bytes).digest('hex'), shape, repeat,
          candidateMs, ...(profile ? { operationMs } : {}), arenaBytes: engine.memory.buffer.byteLength, stats: candidate.lastRun, outputs });
        console.log(`${file} ${shape.join('x')}, repeat ${repeat}: ${Math.round(candidateMs)} ms, exact labels/tolerant scores match.`);
      }
    } finally { await candidate.dispose(); await baseline.release(); }
    if (engine.buffers.size || engine.tensors.size) throw new Error('OCR CPU session leaked arena buffers.');
  }
  report.status = 'pass';
} catch (error) { report.status = 'fail'; report.failure = error.message; throw error; }
finally {
  await engine.dispose();
  report.remainingBuffers = engine.buffers.size; report.remainingTensors = engine.tensors.size;
  const directory = new URL('../artifacts/engines/', import.meta.url); await mkdir(directory, { recursive: true });
  await writeFile(new URL(large ? 'ocr-cpu-large-parity.json' : 'ocr-cpu-parity.json', directory), `${JSON.stringify(report, null, 2)}\n`);
}
