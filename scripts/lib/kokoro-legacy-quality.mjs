// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Isolated development oracle process. No third-party executable enters the app.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KOKORO_DATA } from '../../src/tts/kokoro/model-data.js';
import { readQualityFreeze, qualityFingerprint, hashQualityBytes, reusableQualityClip, saveQualityClip } from './kokoro-quality-controls.mjs';

const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const request = JSON.parse(await readFile(process.argv[2])), freeze = await readQualityFreeze(root, request.manifest, { candidate: false });
const dtype = request.device === 'wasm' ? 'q8' : 'fp32', graph = dtype === 'q8' ? 'onnx/model_quantized.onnx' : 'onnx/model.onnx';
const nativeFetch = globalThis.fetch, requests = [], records = [], files = new Map(KOKORO_DATA.files.map(file => [file.path, file]));
async function pinnedFile(path) {
  const file = files.get(path), bytes = await readFile(resolve(request.cacheDirectory, path));
  if (!file || bytes.length !== file.bytes || hashQualityBytes(bytes) !== file.sha256) throw new Error(`Unverified legacy model data: ${path}.`);
  return bytes;
}
for (const file of [graph, 'config.json', 'tokenizer.json', 'tokenizer_config.json', ...new Set(request.entries.map(entry => `voices/${entry.voice}.bin`))]) await pinnedFile(file);
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.protocol === 'data:') return nativeFetch(input, init); // Installed, hash-pinned eSpeak bundle only; no network.
  const prefix = `/${KOKORO_DATA.modelId}/resolve/`, rest = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : '';
  const at = rest.indexOf('/'), revision = rest.slice(0, at), path = rest.slice(at + 1);
  if (url.origin !== 'https://huggingface.co' || url.search || !['main', KOKORO_DATA.revision].includes(revision) || !files.has(path)) throw new Error(`Blocked unexpected legacy request: ${url.href}.`);
  const bytes = await pinnedFile(path); requests.push({ requested: url.href, pinnedRevision: KOKORO_DATA.revision, path, sha256: files.get(path).sha256 });
  return new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream' } });
};
let tts;
try {
  const { KokoroTTS, TextSplitterStream } = await import('kokoro-js');
  const { env } = await import('@huggingface/transformers');
  env.allowRemoteModels = false; env.allowLocalModels = true; env.useBrowserCache = false; env.useFSCache = false;
  tts = await KokoroTTS.from_pretrained(request.cacheDirectory.replaceAll('\\', '/'), { dtype, device: 'cpu' });
  for (const entry of request.entries) {
    const key = `${request.partition}-${entry.voice}-${entry.id}-legacy-${dtype}`;
    const fingerprint = qualityFingerprint({ corpus: freeze.corpusSha256, entry, dtype, rawGraph: files.get(graph), data: KOKORO_DATA,
      legacyPins: freeze.legacyPins, inputPolicy: 'Raw fixture text pushed once into public TextSplitterStream and closed; unmodified KokoroTTS.stream normalization/tokenization/eSpeak.' });
    let record = await reusableQualityClip(request.outputDirectory, key, fingerprint);
    if (!record) {
      const chunks = [], splitter = new TextSplitterStream();
      const consume = (async () => { for await (const chunk of tts.stream(splitter, { voice: entry.voice, speed: entry.speed })) {
        if (chunk.audio.sampling_rate !== 24000) throw new Error('Legacy sample rate changed.');
        chunks.push({ text: chunk.text, phonemes: chunk.phonemes, audio: chunk.audio.audio });
      } })();
      splitter.push(entry.text); splitter.close(); await consume;
      const pcm = new Float32Array(chunks.reduce((sum, chunk) => sum + chunk.audio.length, 0)); let offset = 0;
      for (const chunk of chunks) { pcm.set(chunk.audio, offset); offset += chunk.audio.length; }
      record = await saveQualityClip(request.outputDirectory, key, pcm, { fingerprint, entry, variant: 'legacy-full-pipeline',
        dtype, backend: 'onnxruntime-node-cpu', graphSha256: files.get(graph).sha256, source: 'Unmodified installed Kokoro-js/Transformers/eSpeak public stream API.',
        chunks: chunks.map(({ text, phonemes, audio }) => ({ text, phonemes, samples: audio.length })) });
    }
    records.push(record); console.log(JSON.stringify({ variant: 'legacy', voice: entry.voice, id: entry.id, samples: record.samples }));
  }
  await readQualityFreeze(root, request.manifest, { candidate: false });
  await mkdir(request.outputDirectory, { recursive: true });
  await writeFile(resolve(request.outputDirectory, `legacy-${request.groupId}.json`), `${JSON.stringify({ status: 'pass', records, requests, dtype,
    scope: 'Full independent legacy text-to-PCM reference; raw graph. No speed or cross-backend PCM acceptance.' }, null, 2)}\n`);
} finally {
  await tts?.model?.dispose(); globalThis.fetch = nativeFetch;
}
