// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { InferenceSession, Tensor } from '../../engines/browser-inference.js';
import { loadVerifiedFile } from '../verified-download.js';
import { sidonFeatures, SIDON_FEATURE_WIDTH, SIDON_INPUT_RATE } from './sidon-features.js';

const BASE = 'https://huggingface.co/soniqo/Sidon-ONNX/resolve/a6dce244cbcd0361ef79c030e246e6f9671770c1';
const CHUNK_BYTES = 64 * 1024 * 1024;
const PREDICTOR = {
  path: 'fp16/sidon-predictor.onnx',
  bytes: 387515203,
  sha256: 'bbfebb1ea059fb74ec702602df86707e8196d0b6b746aaf7bdec82cbf093d0da',
  chunkBytes: CHUNK_BYTES,
  hashes: [
    'a4fdc2659a2cc7c6ee24ea1aa52954c31c1dd8de8f93aaac47dc1a2726322141',
    'ebc87ffe75331f845819ec648b861036f9f8a18206c7de4045ca0ad4723e6b46',
    'ecba93a39b5e9fc8bec54cb986f70f1cf1d35c03eb1877766505ccd6a591002e',
    '7a355a5d9bf35af39a577f309fb1e2275c49941de70c2e1979d6fb692701efee',
    'f9ffe3d82798be57d1f33359342f7d756190d79865767bb1dea0b57f3145f62e',
    '0d7b7d4aec4b89e40b1bc3c823ef5b9f1db78dead4d06b7f06908389223fbc21',
  ],
};
const VOCODER = {
  path: 'fp16/sidon-vocoder.onnx',
  bytes: 105055596,
  sha256: 'b2598f7fae8913ee42a4ddedc4bb50ccd76f15546ec1f93520c19187f4a33644',
  chunkBytes: CHUNK_BYTES,
  hashes: [
    'df9a86bb6dce117c601f477e227b62fc6e204cf4a89392a053e6be990db75b9c',
    'eccc0c17900b35bae171dbbc6feb97e8d36df3c57d33aea4df4d7e24a920a36d',
  ],
};
const TOTAL = PREDICTOR.bytes + VOCODER.bytes;

/** @param {typeof PREDICTOR} file @param {Cache|null} cache @param {Tensor} input */
async function infer(file, cache, input) {
  try {
    /** @param {number} loaded */
    const reportDownload = loaded => self.postMessage({ progress: { loaded: loaded + (file === VOCODER ? PREDICTOR.bytes : 0), total: TOTAL } });
    const weights = await loadVerifiedFile(`${BASE}/${file.path}`, file, {
      label: 'Sidon', cache, fetcher: globalThis.fetch.bind(globalThis), verificationChunks: file,
      onDownload: () => reportDownload(0), onProgress: reportDownload,
    });
    self.postMessage({ processing: true });
    const session = await InferenceSession.create(weights, { releaseHostWeights: true, maxPlanBytes: 0 });
    try {
      const [name] = session.outputNames;
      return (await session.run({ [session.inputNames[0]]: input }, [name]))[name];
    } finally { await session.release(); }
  } finally { input.dispose(); }
}

self.onmessage = async ({ data }) => {
  try {
    const pcm = data.pcm;
    if (!(pcm instanceof Float32Array) || pcm.length < 3 * SIDON_INPUT_RATE || pcm.length > 10 * SIDON_INPUT_RATE) {
      throw new Error('Invalid Sidon input length.');
    }
    const padded = new Float32Array(pcm.length + 800);
    padded.set(pcm, 160);
    const features = sidonFeatures(padded);
    const cache = await globalThis.caches?.open('pagenarrator-sidon-v1').catch(() => null) ?? null;
    const prediction = await infer(PREDICTOR, cache, new Tensor('float32', features, [1, features.length / SIDON_FEATURE_WIDTH, SIDON_FEATURE_WIDTH]));
    const restored = await infer(VOCODER, cache, prediction);
    const output = restored.data;
    if (!(output instanceof Float32Array) || !(output.buffer instanceof ArrayBuffer)
      || output.length < pcm.length * 3 || output.some(value => !Number.isFinite(value))) {
      throw new Error('Sidon returned invalid audio.');
    }
    self.postMessage({ pcm: output }, { transfer: [output.buffer] });
    restored.dispose();
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
