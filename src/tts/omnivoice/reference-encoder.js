// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { InferenceSession, Tensor } from '../../engines/browser-inference.js';
import { loadVerifiedFile } from '../verified-download.js';
import { OMNIVOICE_DATA } from './model-data.js';

export const REFERENCE_SAMPLE_RATE = 24_000;
const SAMPLES_PER_FRAME = 960;
const CODEC_ALIGNMENT = 2 * SAMPLES_PER_FRAME;
const MIN_SAMPLES = 3 * REFERENCE_SAMPLE_RATE;
const MAX_SAMPLES = 10 * REFERENCE_SAMPLE_RATE;
export const OMNIVOICE_ENCODER_DATA = Object.freeze({
  path: 'omnivoice-encoder-fixed.onnx',
  bytes: 654406661,
  sha256: 'e6b492911cdec14af947bddc6723a866595641e5c240c7df76619ac22ee39ad0',
  chunkBytes: 64 * 1024 * 1024,
  hashes: Object.freeze([
    '1e9dc433d9743d8a2bf78af05a019d344b00f1825c2c391a929767a9fcdfa654',
    'ef38ec441f99d4152102a95e93dcb0f96c26005b7b5120e438256c63b7ad9cae',
    'd1ee8294fe2f2a8bea68aa36f69ab48f4e98999886592582ac7bca6c3bd5684b',
    'b56361c8e92f0c052c963f26f7ead0de5ac20d68cfc111fe917319cb597c54e2',
    'a945efc4dcd3c34b238d5cebbd3e5fe62abad31392a43bc1a38e9f317bb695e8',
    '969f22317a3660d4c6fb5017e36ba6a8d3ac5ccf5a3cdff9bd58b9704afa6d5c',
    'b45abf40b06716656d101c481ac83167ad5e930bd4ef6a5888b01c29f799d7b7',
    'e41ffa9e7ec7fc53f359ade76af2be142135842ef1dec88e4137a17d4657a4b2',
    'e2fde09784dbb75166cf0bc07095a41090e97022382762ff03cc7fab1b0c89b8',
    'f20fd80d0b113140519a7e6234cc7228d528efde6a8b61e9bfed0d00ac016f1b',
  ]),
});
const ENCODER_URL = `https://huggingface.co/${OMNIVOICE_DATA.modelId}/resolve/${OMNIVOICE_DATA.revision}/${OMNIVOICE_ENCODER_DATA.path}`;

/** @param {Float32Array} pcm */
function prepareReference(pcm) {
  if (!(pcm instanceof Float32Array) || pcm.length < MIN_SAMPLES || pcm.length > MAX_SAMPLES) {
    throw new RangeError('Choose a voice sample between 3 and 10 seconds.');
  }
  let energy = 0;
  for (const sample of pcm) {
    if (!Number.isFinite(sample)) throw new Error('The voice sample contains invalid audio.');
    energy += sample * sample;
  }
  if (energy / pcm.length < 1e-6) throw new Error('The voice sample is too quiet.');
  const aligned = new Float32Array(Math.ceil(pcm.length / CODEC_ALIGNMENT) * CODEC_ALIGNMENT);
  aligned.set(pcm);
  return aligned;
}

/** Encode a 24 kHz mono reference locally. The only network request loads the pinned encoder model.
 * @param {Float32Array} pcm
 * @param {{signal?:AbortSignal, onProgress?:(loaded:number,total:number)=>void}} [options]
 */
export async function encodeOmniVoiceReference(pcm, { signal, onProgress = () => {} } = {}) {
  signal?.throwIfAborted();
  const aligned = prepareReference(pcm);
  const cache = await globalThis.caches?.open('pagenarrator-omnivoice-v1').catch(() => null);
  const weights = await loadVerifiedFile(ENCODER_URL, OMNIVOICE_ENCODER_DATA, {
    label: 'OmniVoice voice encoder', cache, fetcher: globalThis.fetch.bind(globalThis), signal,
    verificationChunks: OMNIVOICE_ENCODER_DATA,
    onDownload: () => onProgress(0, OMNIVOICE_ENCODER_DATA.bytes), onProgress,
  });
  const session = await InferenceSession.create(weights, { repairNodeOrder: true, releaseHostWeights: true, maxPlanBytes: 0 });
  try {
    signal?.throwIfAborted();
    const input = new Tensor('float32', aligned, [1, 1, aligned.length]);
    try {
      const { audio_codes: output } = await session.run({ input_values: input }, ['audio_codes']);
      try {
        signal?.throwIfAborted();
        const frames = aligned.length / SAMPLES_PER_FRAME;
        const codes = output.data;
        if (output.type !== 'int64' || output.dims.join(',') !== `1,8,${frames}`
          || !(codes instanceof BigInt64Array) || codes.some(code => code < 0n || code > 1023n)) throw new Error('The voice encoder returned invalid audio codes.');
        return { frames, codes: Uint16Array.from(codes, Number) };
      } finally { output.dispose(); }
    } finally { input.dispose(); }
  } finally { await session.release(); }
}
