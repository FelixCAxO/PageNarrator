// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Same actual model signal into original C++ STFT and independent Torch CPU STFT.
// Exported intermediate samples are test inputs only, never production oracle feeds.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import * as oracle from 'onnxruntime-node';
import { decodeOnnxModel } from '../src/engines/onnx-model.js';
import { WasmKokoroCompute } from '../src/engines/kokoro-cpu-compute.js';
import { debugOutputModel } from './lib/onnx-debug-outputs.mjs';
import { createEnglishPhonemizer } from '../src/tts/kokoro/english-phonemizer.js';
import { createKokoroTokenizer } from '../src/tts/kokoro/tokenizer.js';
import { KOKORO_DATA } from '../src/tts/kokoro/model-data.js';

const option = process.argv.indexOf('--cache'); if (option < 0) throw new Error('Pass verified local --cache.');
const cache = resolve(process.argv[option + 1]), output = resolve('artifacts/engines/kokoro-actual-stft'); await mkdir(output, { recursive: true });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const verify = async path => { const bytes = await readFile(resolve(cache, path)), pin = KOKORO_DATA.files.find(file => file.path === path);
  if (!pin || bytes.length !== pin.bytes || sha(bytes) !== pin.sha256) throw new Error(`Unpinned model data ${path}.`); return bytes; };
const bytes = await verify('onnx/model.onnx'), graph = decodeOnnxModel(bytes).graph;
const node = graph.nodes.find(node => node.opType === 'STFT'), phaseName = '/decoder/decoder/generator/Where_1_output_0';
if (!node || node.name !== '/decoder/decoder/generator/STFT') throw new Error('Unexpected actual STFT node.');
const windowInfo = graph.initializers.find(info => info.name === node.inputs[2]);
if (windowInfo?.dataType !== 1 || windowInfo.dims.join(',') !== '20' || windowInfo.rawData.length !== 80) throw new Error('Unexpected actual STFT window.');
const window = new Float32Array(windowInfo.rawData.slice().buffer);
const baseline = await oracle.InferenceSession.create(debugOutputModel(bytes, [node.inputs[0], node.outputs[0], phaseName]), { executionProviders: ['cpu'], graphOptimizationLevel: 'disabled', intraOpNumThreads: 1, interOpNumThreads: 1, logSeverityLevel: 3 });
const engine = await WasmKokoroCompute.create(await readFile('public/native/kokoro-engine.wasm'));
const phonemizer = await createEnglishPhonemizer({ wasmBinary: await readFile('public/assets/phonemizer/english.wasm'), pronunciationData: await readFile('public/assets/phonemizer/pronunciations.bin') });
const report = { scope: 'Same actual retained-model padded signal. Own C++ STFT versus independent Torch CPU; original ORT spectra are recorded separately. No supplied phase or FFT output enters production inference.', modelSha256: sha(bytes),
  implementationPins: Object.fromEntries(await Promise.all(['scripts/probe-kokoro-stft-input.mjs', 'scripts/kokoro-stft-review.py', 'public/native/kokoro-engine.wasm', 'src/engines/kokoro-cpu-kernels.js'].map(async file => [file, sha(await readFile(file))]))), cases: [] };
try {
  const tokenizer = createKokoroTokenizer(JSON.parse(await verify('tokenizer.json')), JSON.parse(await verify('tokenizer_config.json')));
  const corpus = JSON.parse(await readFile('tests/fixtures/kokoro-connected-prose.json'));
  const cases = [{ id: 'short-heart', voice: 'af_heart', text: 'Hello.' }, ...corpus.cases.map(entry => ({ id: entry.id, voice: entry.voice, text: `${entry.text.split('. ')[0]}.` }))];
  for (const entry of cases) {
    const ids = tokenizer.encode(await phonemizer.phonemizeText(entry.text, entry.voice[0] === 'b' ? 'en-gb' : 'en-us'));
    const styleBytes = await verify(`voices/${entry.voice}.bin`), row = ids.length - 2, style = new Float32Array(styleBytes.buffer.slice(styleBytes.byteOffset + row * 1024, styleBytes.byteOffset + (row + 1) * 1024));
    const feeds = { input_ids: new oracle.Tensor('int64', ids, [1, ids.length]), style: new oracle.Tensor('float32', style, [1, 256]), speed: new oracle.Tensor('float32', Float32Array.of(1), [1]) };
    const result = await baseline.run(feeds), signal = result[node.inputs[0]], reference = result[node.outputs[0]], phase = result[phaseName];
    if (![2, 3].includes(signal.dims.length) || signal.dims[0] !== 1 || signal.dims.length === 3 && signal.dims[2] !== 1) throw new Error(`Unexpected captured STFT signal ${signal.dims}.`);
    const batch = engine.batch(), input = engine.upload(signal.data, [1, signal.dims[1]]), windowTensor = engine.upload(window, [20]);
    const actual = engine.kokoro.stft(batch, input, windowTensor, { frameLength: 20, frameStep: 5 }); batch.submit();
    const spectrum = await engine.read(actual), files = {};
    for (const [name, data] of Object.entries({ signal: signal.data, window, own: spectrum, ort: reference.data, ortPhase: phase.data })) {
      const filename = `${entry.id}-${name}.f32`, raw = new Uint8Array(data.buffer, data.byteOffset, data.byteLength); await writeFile(resolve(output, filename), raw); files[name] = { filename, bytes: raw.length, sha256: sha(raw) };
    }
    report.cases.push({ ...entry, ids: Array.from(ids, Number), signalShape: signal.dims, spectrumShape: actual.shape, phaseShape: phase.dims, files });
    await engine.releaseMany([...engine.tensors], batch.scratchBuffers()); console.log(JSON.stringify({ id: entry.id, signalShape: signal.dims, frames: actual.shape[1] }));
  }
} finally { phonemizer.dispose(); await baseline.release(); report.remainingBuffers = engine.buffers.size; report.remainingTensors = engine.tensors.size; await engine.dispose(); }
const manifest = resolve(output, 'manifest.json'); await writeFile(manifest, `${JSON.stringify(report, null, 2)}\n`);
await new Promise((done, reject) => { const child = spawn('python', ['scripts/kokoro-stft-review.py', '--manifest', manifest], { stdio: 'inherit', windowsHide: true }); child.on('error', reject); child.on('exit', code => code === 0 ? done() : reject(new Error(`Torch STFT diagnostic failed ${code}.`))); });
