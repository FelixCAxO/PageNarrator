// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import * as oracle from 'onnxruntime-node';
import { WasmKokoroCompute } from '../src/engines/kokoro-cpu-compute.js';
import { WebGpuOnnxSession } from '../src/engines/webgpu-onnx-session.js';
import { decodeOnnxModel } from '../src/engines/onnx-model.js';
import { debugOutputModel } from './lib/onnx-debug-outputs.mjs';
import { createEnglishPhonemizer } from '../src/tts/kokoro/english-phonemizer.js';
import { createKokoroTokenizer } from '../src/tts/kokoro/tokenizer.js';
import { KOKORO_DATA } from '../src/tts/kokoro/model-data.js';

const cacheIndex = process.argv.indexOf('--cache'), outputIndex = process.argv.indexOf('--outputs');
if (cacheIndex < 0) throw new Error('Pass --cache with the verified local Kokoro data directory.');
const fp32 = process.argv.includes('--fp32'), graphFile = fp32 ? 'onnx/model.onnx' : 'onnx/model_quantized.onnx';
const directory = resolve(process.argv[cacheIndex + 1]), model = await readFile(resolve(directory, graphFile));
const modelSha256 = createHash('sha256').update(model).digest('hex');
if (modelSha256 !== KOKORO_DATA.files.find(file => file.path === graphFile).sha256) throw new Error('Unpinned Kokoro graph.');
const graph = decodeOnnxModel(model).graph;
const vocoder = process.argv.includes('--vocoder'), noise = process.argv.includes('--noise');
const selected = noise ? graph.nodes.filter(node => node.name === '/decoder/decoder/generator/STFT' || node.name === '/decoder/decoder/generator/noise_convs.0/Conv'
  || node.name.startsWith('/decoder/decoder/generator/noise_res.0/') && ['adain1.0/Add_3', 'Sin', 'convs1.0/Conv', 'adain2.0/Add_3', 'Sin_1', 'convs2.0/Conv', 'Add_2', 'Add_8'].some(suffix => node.name === `/decoder/decoder/generator/noise_res.0/${suffix}`))
  .map(node => node.outputs[0]) : vocoder ? graph.nodes.filter(node => node.name.startsWith('/decoder/decoder/generator/')
  && ((node.opType === 'ConvTranspose' && !node.name.includes('resblocks')) || /resblocks\.\d\/Add_8$/.test(node.name)
    || node.name === '/decoder/decoder/generator/conv_post/Conv' || ['Exp', 'Sin', 'istft/stft/Concat'].some(suffix => node.name === `/decoder/decoder/generator/${suffix}`))).map(node => node.outputs[0])
  : outputIndex < 0 ? graph.nodes.filter(node => ['DynamicQuantizeLSTM', 'LSTM'].includes(node.opType)
  || node.name === '/encoder/bert/embeddings/LayerNorm/LayerNormalization'
  || node.name === '/encoder/bert/encoder/albert_layer_groups.0/albert_layers.0/attention/LayerNorm/LayerNormalization'
  || node.name === '/encoder/bert/encoder/albert_layer_groups.0/albert_layers.0/full_layer_layer_norm/LayerNormalization'
  || node.name === '/decoder/decoder/generator/m_source/l_sin_gen/CumSum'
  || node.opType === 'STFT' || node.name === '/decoder/decoder/generator/istft/stft/ConvTranspose').map(node => node.outputs[0])
  : process.argv[outputIndex + 1].split(',');
if (!selected.length) throw new Error('No intermediate outputs selected.');
const bytes = debugOutputModel(model, selected), engine = await WasmKokoroCompute.create(await readFile(new URL('../public/native/kokoro-engine.wasm', import.meta.url)));
const report = { status: 'incomplete', dtype: fp32 ? 'fp32' : 'q8', modelSha256, scope: 'Diagnostic actual pinned graph intermediate comparison; production stays gated', outputs: [] };
let candidate, baseline, phonemizer;
try {
  phonemizer = await createEnglishPhonemizer({ wasmBinary: await readFile(new URL('../public/assets/phonemizer/english.wasm', import.meta.url)), pronunciationData: await readFile(new URL('../public/assets/phonemizer/pronunciations.bin', import.meta.url)) });
  const tokenizer = createKokoroTokenizer(JSON.parse(await readFile(resolve(directory, 'tokenizer.json'))), JSON.parse(await readFile(resolve(directory, 'tokenizer_config.json'))));
  const ids = tokenizer.encode(await phonemizer.phonemizeText('Hello.'));
  const styleBytes = await readFile(resolve(directory, 'voices/af_heart.bin')), row = ids.length - 2;
  const style = new Float32Array(styleBytes.buffer.slice(styleBytes.byteOffset + row * 1024, styleBytes.byteOffset + (row + 1) * 1024));
  const feeds = { input_ids: { shape: [1, ids.length], data: ids }, style: { shape: [1, 256], data: style }, speed: { shape: [1], data: Float32Array.of(1) } };
  candidate = await WebGpuOnnxSession.create(bytes, { engine, maxPlanBytes: 0 });
  baseline = await oracle.InferenceSession.create(bytes, { executionProviders: ['cpu'], intraOpNumThreads: 1, interOpNumThreads: 1, graphOptimizationLevel: 'disabled', logSeverityLevel: 3 });
  const expected = await baseline.run(Object.fromEntries(Object.entries(feeds).map(([name, feed]) => [name, new oracle.Tensor(name === 'input_ids' ? 'int64' : 'float32', feed.data, feed.shape)])));
  const actual = await candidate.run(feeds);
  for (const name of selected) {
    const a = actual[name], b = expected[name];
    if (a.shape.join(',') !== b.dims.join(',')) throw new Error(`${name}: output shapes differ ${a.shape}/${b.dims}.`);
    let maximumAbsolute = 0, squareError = 0, squareReference = 0, mismatches = 0;
    const firstDifferences = [];
    for (let i = 0; i < a.data.length; i++) {
      const x = Number(a.data[i]), y = Number(b.data[i]), error = Math.abs(x - y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`${name}: nonfinite output.`);
      maximumAbsolute = Math.max(maximumAbsolute, error); squareError += error * error; squareReference += y * y;
      if (error > (a.type === 'float32' ? 3e-4 + Math.abs(y) * 3e-3 : 0)) { mismatches++; if (firstDifferences.length < 6) firstDifferences.push({ i, actual: x, expected: y }); }
    }
    const result = { name, shape: a.shape, maximumAbsolute, relativeRmse: Math.sqrt(squareError / Math.max(1e-30, squareReference)), mismatches, elements: a.data.length, firstDifferences };
    if (a.shape.length === 3 && a.shape[0] === 1 && a.shape[1] <= 32) {
      const width = a.shape[2];
      result.channels = Array.from({ length: a.shape[1] }, (_, channel) => {
        let errors = 0, reference = 0, maximum = 0, bad = 0;
        for (let i = channel * width; i < (channel + 1) * width; i++) {
          const error = Math.abs(Number(a.data[i]) - Number(b.data[i])); errors += error ** 2; reference += Number(b.data[i]) ** 2; maximum = Math.max(maximum, error);
          if (error > 3e-4 + Math.abs(Number(b.data[i])) * 3e-3) bad++;
        }
        return { channel, maximumAbsolute: maximum, relativeRmse: Math.sqrt(errors / Math.max(1e-30, reference)), mismatches: bad };
      });
    }
    report.outputs.push(result); console.log(JSON.stringify(result));
  }
  report.stats = candidate.lastRun; report.status = report.outputs.some(output => output.mismatches) ? 'mismatch' : 'pass';
} catch (error) { report.status = 'fail'; report.failure = error.message; throw error; }
finally {
  await candidate?.dispose(); await baseline?.release(); phonemizer?.dispose();
  report.remainingBuffers = engine.buffers.size; report.remainingTensors = engine.tensors.size; await engine.dispose();
  await mkdir(new URL('../artifacts/engines/', import.meta.url), { recursive: true });
  await writeFile(new URL(`../artifacts/engines/kokoro-cpu-${fp32 ? 'fp32-' : ''}${noise ? 'noise-' : vocoder ? 'vocoder-' : ''}prefix.json`, import.meta.url), `${JSON.stringify(report, null, 2)}\n`);
}
