// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Causal diagnosis only: supplied reference intermediates are NEVER production inference.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import * as oracle from 'onnxruntime-node';
import { debugOutputModel, debugOverrideModel } from './lib/onnx-debug-outputs.mjs';
import { WasmKokoroCompute } from '../src/engines/kokoro-cpu-compute.js';
import { WebGpuOnnxSession } from '../src/engines/webgpu-onnx-session.js';
import { createEnglishPhonemizer } from '../src/tts/kokoro/english-phonemizer.js';
import { createKokoroTokenizer } from '../src/tts/kokoro/tokenizer.js';
import { KOKORO_DATA } from '../src/tts/kokoro/model-data.js';
import { compareAudio } from './lib/kokoro-speech-acceptance.mjs';

const option = process.argv.indexOf('--cache'); if (option < 0) throw new Error('Pass the pinned local Kokoro --cache path.');
const cache = resolve(process.argv[option + 1]), bytes = await readFile(resolve(cache, 'onnx/model.onnx'));
const modelSha256 = createHash('sha256').update(bytes).digest('hex');
if (modelSha256 !== KOKORO_DATA.files.find(file => file.path === 'onnx/model.onnx').sha256) throw new Error('Unpinned model.');
const phaseName = '/decoder/decoder/generator/Where_1_output_0', spectrumName = '/decoder/decoder/generator/Concat_3_output_0';
const reference = await oracle.InferenceSession.create(debugOutputModel(bytes, [phaseName, spectrumName, 'waveform']), { executionProviders: ['cpu'], intraOpNumThreads: 1, interOpNumThreads: 1, graphOptimizationLevel: 'disabled' });
const phonemizer = await createEnglishPhonemizer({ wasmBinary: await readFile(new URL('../public/assets/phonemizer/english.wasm', import.meta.url)), pronunciationData: await readFile(new URL('../public/assets/phonemizer/pronunciations.bin', import.meta.url)) });
const engine = await WasmKokoroCompute.create(await readFile(new URL('../public/native/kokoro-engine.wasm', import.meta.url)));
const report = { status: 'incomplete', modelSha256, scope: 'Diagnostic causal intervention supplies independent reference phase/spectrum to identify drift. This is not standalone synthesis, parity acceptance, or production execution.', cases: [] };
try {
  const tokenizer = createKokoroTokenizer(JSON.parse(await readFile(resolve(cache, 'tokenizer.json'))), JSON.parse(await readFile(resolve(cache, 'tokenizer_config.json'))));
  const ids = tokenizer.encode(await phonemizer.phonemizeText('Hello.')), styleBytes = await readFile(resolve(cache, 'voices/af_heart.bin')), row = ids.length - 2;
  const style = new Float32Array(styleBytes.buffer.slice(styleBytes.byteOffset + row * 1024, styleBytes.byteOffset + (row + 1) * 1024));
  const feeds = { input_ids: { shape: [1, ids.length], data: ids }, style: { shape: [1, 256], data: style }, speed: { shape: [1], data: Float32Array.of(1) } };
  const baseline = await reference.run(Object.fromEntries(Object.entries(feeds).map(([name, value]) => [name, new oracle.Tensor(name === 'input_ids' ? 'int64' : 'float32', value.data, value.shape)])));
  for (const name of [phaseName, spectrumName]) {
    const intervention = debugOverrideModel(bytes, name, baseline[name].dims), session = await WebGpuOnnxSession.create(intervention.bytes, { engine });
    try {
      const result = (await session.run({ ...feeds, [intervention.inputName]: { shape: baseline[name].dims, data: baseline[name].data } }, ['waveform'])).waveform;
      const gate = { minimumRms: .001, maximumDurationRelativeDifference: .1, maximumDurationAbsoluteDifferenceSeconds: .1, pcmAbsoluteTolerance: .0003, pcmRelativeTolerance: .003 };
      const record = { overriddenTensor: name, suppliedShape: baseline[name].dims, nodes: session.lastRun.nodes, comparison: compareAudio(result.data, baseline.waveform.data, gate) };
      report.cases.push(record); console.log(JSON.stringify(record));
    } finally { await session.dispose(); }
  }
  report.status = 'diagnostic complete';
} finally {
  await reference.release(); phonemizer.dispose(); report.remainingBuffers = engine.buffers.size; report.remainingTensors = engine.tensors.size; await engine.dispose();
  await mkdir(new URL('../artifacts/engines/', import.meta.url), { recursive: true }); await writeFile(new URL('../artifacts/engines/kokoro-phase-intervention.json', import.meta.url), `${JSON.stringify(report, null, 2)}\n`);
}
