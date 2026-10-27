// Copyright 2026 Felix Olsson. Licensed under GPL-3.0-or-later.
// Inference algorithm reference: Copyright 2026 Xiaomi Corp. (Han Zhu), Apache-2.0.
// New browser implementation; see vendor/omnivoice/PROVENANCE.md.

import { getOmniVoiceLanguage } from './languages.js';
import * as browserInference from '../../engines/browser-inference.js';
import { assertOmniVoiceAudio } from './audio-quality.js';
import { applyOmniVoiceRmsNormCorrection } from './rmsnorm-correction.js';
import { getOmniVoiceSpeakerReference } from './speakers.js';
import { renderOmniVoiceWhisper } from './whisper.js';

const MAIN = 'omnivoice-main-kv-fp16-b1.onnx';
const DECODER = 'omnivoice-decoder-webgpu.onnx';
const CODEBOOKS = 8;
const VOCAB = 1025;
const MASK = 1024;
const LAYERS = 28;
const HALF = Float32Array.from({ length: 65536 }, (_, bits) => {
  const sign = bits & 32768 ? -1 : 1;
  const exponent = (bits >>> 10) & 31;
  const fraction = bits & 1023;
  return sign * (exponent === 31 ? (fraction ? NaN : Infinity)
    : exponent ? 2 ** (exponent - 15) * (1 + fraction / 1024) : fraction * 2 ** -24);
});

const SCRIPT_WEIGHTS = [
  [0x58F, 1],
  [0x8FF, 1.5],
  [0xDFF, 1.8],
  [0xEFF, 1.5],
  [0x109F, 1.8],
  [0x10FF, 1],
  [0x11FF, 2.5],
  [0x139F, 3],
  [0x177F, 1],
  [0x17FF, 1.8],
  [0x18FF, 1],
  [0x1C7F, 1.8],
  [0x1CBF, 1],
  [0x1CFF, 1.8],
  [0x1EFF, 1],
  [0x30FF, 2.2],
  [0x312F, 3],
  [0x318F, 2.5],
  [0xA4CF, 3],
  [0xA7FF, 1],
  [0xA82F, 1.8],
  [0xA87F, 1],
  [0xA95F, 1.8],
  [0xA97F, 2.5],
  [0xAAFF, 1.8],
  [0xAB2F, 3],
  [0xABBF, 1],
  [0xABFF, 1.8],
  [0xD7AF, 2.5],
  [0xFAFF, 3],
  [0xFDFF, 1.5],
  [0xFE6F, 1],
  [0xFEFF, 1.5],
  [0xFFEF, 1],
];

/** @param {string} char */
function characterWeight(char) {
  const code = char.codePointAt(0) ?? 0;
  if (code === 0x640 || /\p{M}/u.test(char)) return 0;
  if (/\p{P}|\p{S}/u.test(char)) return 0.5;
  if (/\p{Z}|\s/u.test(char)) return 0.2;
  if (/\p{N}/u.test(char)) return 3.5;
  return SCRIPT_WEIGHTS.find(([end]) => code <= end)?.[1] ?? (code > 0x20000 ? 3 : 1);
}

/** @param {string} text @param {string} [lang] */
function normalizeSpokenText(text, lang) {
  // Mathematical letter styling is visual; retain other compatibility characters such as superscripts.
  const normalized = text.replace(/[\u{1D400}-\u{1D7FF}]/gu, char => char.normalize('NFKC')).normalize('NFC');
  // The space-prefixed title-case BPE token mispronounces this Turkish word during cloning.
  return lang === 'tr' ? normalized.replace(/(?<!\p{L})Bugün/gu, 'bugün') : normalized;
}

/** @param {string} text @param {number} speed */
export function estimateOmniVoiceFrames(text, speed) {
  // The decoder emits 960 samples per code frame (25 Hz); bundle metadata incorrectly says 75 Hz.
  const weight = [...normalizeSpokenText(text)].reduce((total, char) => total + characterWeight(char), 0);
  // Generated references use this same rule; calibrating from their rounded frames loses target frames.
  const estimate = weight * 25 / 14.1;
  return Math.max(1, Math.floor((estimate < 50 ? 50 * (estimate / 50) ** (1 / 3) : estimate) / speed));
}

/** @param {number} total @param {number} steps */
export function omniVoiceUnmaskSchedule(total, steps) {
  /** @param {number} step */
  const time = (step) => 0.1 * (step / steps) / (1 - 0.9 * (step / steps));
  let remaining = total;
  return Array.from({ length: steps }, (_, step) => {
    const count = step === steps - 1 ? remaining : Math.min(remaining, Math.ceil(total * (time(step + 1) - time(step))));
    remaining -= count;
    return count;
  });
}

/** @param {number} seed */
function randomSource(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state + 0.5) / 4294967296;
  };
}

/** @param {any} tensor */
async function readLogits(tensor) {
  const data = await tensor.getData();
  if (tensor.type === 'float16' && ArrayBuffer.isView(data) && data.byteLength === tensor.size * 2) {
    // Current Chromium returns native Float16Array; older ORT uses raw Uint16Array bits.
    const bits = new Uint16Array(data.buffer, data.byteOffset, data.byteLength / 2);
    // TypedArray.from boxes each element through its iterator; indexed lookup preserves every fp16 value.
    const values = new Float32Array(bits.length);
    for (let index = 0; index < bits.length; index++) values[index] = HALF[bits[index]];
    return values;
  }
  if (tensor.type === 'float32' && data instanceof Float32Array) return data;
  throw new Error('Unexpected OmniVoice logits format.');
}

/** @param {any} tensors */
function disposeTensors(tensors) {
  for (const tensor of new Set(Object.values(tensors))) tensor.dispose();
}

/** @param {Float32Array} conditional @param {Float32Array} unconditional
 * @param {BigInt64Array} codes @param {number} frames @param {number} prefix
 * @param {number} count @param {() => number} random */
export function unmaskOmniVoiceTokens(conditional, unconditional, codes, frames, prefix, count, random) {
  const scores = new Float64Array(codes.length);
  const predictions = new Int32Array(codes.length);
  const candidates = [];
  const guided = new Float64Array(VOCAB);
  for (let index = 0; index < codes.length; index += 1) {
    if (codes[index] !== BigInt(MASK)) continue;
    const book = Math.floor(index / frames);
    const frame = index % frames;
    const cOffset = (book * (prefix + frames) + prefix + frame) * VOCAB;
    const uOffset = index * VOCAB;
    let maximum = -Infinity;
    let best = -Infinity;
    let token = 0;
    for (let v = 0; v < VOCAB; v += 1) {
      // Log-softmax constants cancel when the guided logits are normalized again.
      const value = 3 * conditional[cOffset + v] - 2 * unconditional[uOffset + v];
      if (!Number.isFinite(value)) throw Object.assign(new Error('OmniVoice produced non-finite logits.'), { name: 'OmniVoiceAudioQualityError' });
      guided[v] = value;
      maximum = Math.max(maximum, value);
      if (v !== MASK && value > best) { best = value; token = v; }
    }
    let sum = 0;
    for (const value of guided) sum += Math.exp(value - maximum);
    scores[index] = (best - maximum - Math.log(sum) - book * 5) / 5 - Math.log(-Math.log(random()));
    predictions[index] = token;
    candidates.push(index);
  }
  candidates.sort((a, b) => scores[b] - scores[a] || a - b);
  for (const index of candidates.slice(0, count)) codes[index] = BigInt(predictions[index]);
}

/** @param {any} deps */
export function createOmniVoiceRuntime({ ort, tokenizer, fetch: fetchModel, log = () => {}, gpu = globalThis.navigator?.gpu, decoderRuntime = browserInference,
  getSpeaker = getOmniVoiceSpeakerReference }) {
  /** @type {any} */
  let main = null;
  /** @type {any} */
  let decoder = null;
  /** @type {{ version: string, norms: number, originalSha256: string, modifiedSha256: string }|null} */
  let mainGraphCorrection = null;
  /** @type {Promise<void>|null} */
  let loading = null;
  /** @type {Promise<any>|null} */
  let active = null;
  /** @type {Promise<void>|null} */
  let disposal = null;
  let retired = false;
  let generation = 0;

  async function releaseSessions() {
    const sessions = [main, decoder];
    main = decoder = null;
    mainGraphCorrection = null;
    const results = await Promise.allSettled(sessions.filter(Boolean).map(session => session.release()));
    for (const result of results) if (result.status === 'rejected') log('cleanup', String(result.reason));
  }

  /** @param {string} baseUrl */
  function init(baseUrl) {
    if (retired) return Promise.reject(new Error('OmniVoice runtime has been disposed.'));
    loading ||= (async () => {
      const adapter = await gpu?.requestAdapter();
      if (!adapter?.features.has('shader-f16')) throw new Error('OmniVoice requires WebGPU with shader-f16 support.');
      /** @param {string} file */
      const json = async (file) => (await fetchModel(`${baseUrl}/${file}`)).json();
      const [config, manifest] = await Promise.all([json('omnivoice-config.json'), json('omnivoice-main-kv-fp16-b1-manifest.json')]);
      if (config.num_audio_codebook !== CODEBOOKS || config.audio_vocab_size !== VOCAB || config.audio_mask_id !== MASK
        || config.sampling_rate !== 24000 || config.frame_rate !== 75
        || !Array.isArray(manifest) || manifest.length !== 1 || manifest[0] !== `${MAIN}_data`) {
        throw new Error('Unsupported OmniVoice model configuration.');
      }
      log('loading', 'Loading OmniVoice on WebGPU…');
      /** @param {string} file */
      const bytes = async (file) => new Uint8Array(await (await fetchModel(`${baseUrl}/${file}`)).arrayBuffer());
      /** @type {(Uint8Array<ArrayBuffer>|null)[]} */
      let [graph, weights, decoderGraph] = await Promise.all([bytes(MAIN), bytes(manifest[0]), bytes(DECODER)]);
      try {
        const correction = await applyOmniVoiceRmsNormCorrection(graph);
        graph = correction.bytes;
        mainGraphCorrection = { version: correction.version, norms: correction.norms,
          originalSha256: correction.originalSha256, modifiedSha256: correction.modifiedSha256 };
        main = await ort.InferenceSession.create(graph, { executionProviders: ['webgpu'],
          externalData: [{ path: manifest[0], data: weights }], maxCachedPlans: 2,
          preferredOutputLocation: 'cpu', logSeverityLevel: 3, releaseHostWeights: true });
        graph = weights = null;
        decoder = await decoderRuntime.InferenceSession.create(decoderGraph, { executionProviders: ['webgpu'], releaseHostWeights: true });
        decoderGraph = null;
      } catch (error) {
        await releaseSessions();
        throw error;
      }
      log('ready', 'OmniVoice ready on WebGPU.');
    })().catch(error => { loading = null; throw error; });
    return loading;
  }

  /** @param {number} current */
  function checkAbort(current) {
    if (retired || generation !== current) throw new DOMException('OmniVoice generation stopped.', 'AbortError');
  }

  /** @param {number[]} prefix @param {BigInt64Array} codes @param {number} frames
   * @param {{codes: BigInt64Array, frames: number}|null} [reference] */
  function createFeeds(prefix, codes, frames, reference = null) {
    const referenceFrames = reference?.frames || 0;
    const length = prefix.length + referenceFrames + frames;
    const ids = new BigInt64Array(CODEBOOKS * length);
    for (let book = 0; book < CODEBOOKS; book += 1) {
      ids.set(BigInt64Array.from(prefix, BigInt), book * length);
      if (reference) ids.set(reference.codes.subarray(book * referenceFrames, (book + 1) * referenceFrames), book * length + prefix.length);
      ids.set(codes.subarray(book * frames, (book + 1) * frames), book * length + prefix.length + referenceFrames);
    }
    const positions = BigInt64Array.from({ length }, (_, index) => BigInt(index));
    const audioMask = new Uint8Array(length);
    audioMask.fill(1, prefix.length);
    /** @type {Record<string, any>} */
    const feeds = {
      input_ids: new ort.Tensor('int64', ids, [1, CODEBOOKS, length]),
      audio_mask: new ort.Tensor('bool', audioMask, [1, length]),
      attention_mask: new ort.Tensor('bool', new Uint8Array(length * length).fill(1), [1, 1, length, length]),
      position_ids: new ort.Tensor('int64', positions, [1, length]),
      // This export also uses target_positions inside attention; retain the complete sequence.
      target_positions: new ort.Tensor('int64', positions, [1, length]),
    };
    // Recompute the full bidirectional sequence; all KV slots are replaced by this pass.
    const emptyCache = new ort.Tensor('float16', new Uint16Array(8 * length * 128), [1, 8, length, 128]);
    for (let layer = 0; layer < LAYERS; layer += 1) {
      feeds[`past_key_${layer}`] = feeds[`past_value_${layer}`] = emptyCache;
    }
    return feeds;
  }

  /** @param {any} feeds @param {number} current */
  async function infer(feeds, current) {
    const result = await main.run(feeds, ['audio_logits']);
    try {
      checkAbort(current);
      const logits = result.audio_logits;
      if (logits.dims.join(',') !== `1,${CODEBOOKS},${feeds.input_ids.dims[2]},${VOCAB}`) throw new Error('Unexpected OmniVoice logits shape.');
      const data = await readLogits(logits);
      checkAbort(current);
      return data;
    } finally {
      disposeTensors(result);
    }
  }

  /** @param {any} request */
  async function generate(request) {
    const { text, lang, instruct, speed, seed, numStep } = request;
    if (typeof text !== 'string' || !text.trim() || typeof lang !== 'string' || getOmniVoiceLanguage(lang)?.code !== lang || typeof instruct !== 'string'
      || !Number.isFinite(speed) || speed < 0.5 || speed > 1.5 || !Number.isInteger(seed)
      || (request.whisper !== undefined && typeof request.whisper !== 'boolean')
      || !Number.isInteger(numStep) || numStep < 1 || numStep > 64) throw new Error('Invalid OmniVoice request.');
    if (!loading) throw new Error('OmniVoice runtime is not initialized.');
    const current = generation;
    await loading;
    checkAbort(current);
    const timings = { inferenceMs: 0, unmaskMs: 0, decoderMs: 0, whisperMs: 0 };
    const spokenText = normalizeSpokenText(text, lang);
    const reference = getSpeaker(request);
    const frames = estimateOmniVoiceFrames(spokenText, speed);
    /** @param {string} value @returns {number[]} */
    const encode = (value) => Array.from(tokenizer.encode(value, { add_special_tokens: false }));
    const prefix = [...encode(`${reference ? '<|denoise|>' : ''}<|lang_start|>${lang}<|lang_end|><|instruct_start|>${instruct || 'None'}<|instruct_end|>`),
      ...encode(`<|text_start|>${reference ? `${reference.text} ` : ''}${spokenText.trim()}<|text_end|>`)];
    const audioOffset = prefix.length + (reference?.frames || 0);
    // shortcut: the reader chunks text; reject oversized sections until long-section GPU tiling is needed.
    if (audioOffset + frames > 2048) throw new Error('OmniVoice section is too long. Split the text into shorter sections.');
    const codes = new BigInt64Array(CODEBOOKS * frames).fill(BigInt(MASK));
    const conditional = createFeeds(prefix, codes, frames, reference);
    const unconditional = createFeeds([], codes, frames);
    const random = randomSource(seed);
    try {
      for (const count of omniVoiceUnmaskSchedule(codes.length, numStep)) {
        checkAbort(current);
        const inferenceStart = performance.now();
        const c = await infer(conditional, current);
        const u = await infer(unconditional, current);
        timings.inferenceMs += performance.now() - inferenceStart;
        const unmaskStart = performance.now();
        unmaskOmniVoiceTokens(c, u, codes, frames, audioOffset, count, random);
        timings.unmaskMs += performance.now() - unmaskStart;
        for (let book = 0; book < CODEBOOKS; book += 1) {
          const offset = book * conditional.input_ids.dims[2] + audioOffset;
          conditional.input_ids.data.set(codes.subarray(book * frames, (book + 1) * frames), offset);
        }
        unconditional.input_ids.data.set(codes);
      }
      checkAbort(current);
      const input = new decoderRuntime.Tensor('int64', codes, [1, CODEBOOKS, frames]);
      let result;
      try {
        const decoderStart = performance.now();
        result = await decoder.run({ audio_codes: input }, ['audio_values']);
        checkAbort(current);
        const output = result.audio_values;
        if (output.type !== 'float32' || output.dims[0] !== 1 || output.dims[1] !== 1 || output.dims.length !== 3) throw new Error('Unexpected OmniVoice audio shape.');
        let pcm = new Float32Array(await output.getData());
        checkAbort(current);
        assertOmniVoiceAudio(pcm, 24000);
        timings.decoderMs = performance.now() - decoderStart;
        const backingPcmSha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', pcm)), value => value.toString(16).padStart(2, '0')).join('');
        checkAbort(current);
        if (request.whisper === true) {
          const whisperStart = performance.now();
          pcm = renderOmniVoiceWhisper(pcm, seed, lang);
          timings.whisperMs = performance.now() - whisperStart;
          checkAbort(current);
          assertOmniVoiceAudio(pcm, 24000);
        }
        // The reference builder runs without a preset; playback never derives identity from document text.
        const anchorHash = reference?.hash || Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', codes)), value => value.toString(16).padStart(2, '0')).join('');
        checkAbort(current);
        return { pcm, sampleRate: 24000, timings, backingPcmSha256, speaker: {
          id: reference?.id || null,
          referenceId: reference?.referenceId || null, referenceLanguage: reference?.lang || null,
          referenceHash: reference?.hash || null, referenceFrames: reference?.frames || 0,
          anchorHash,
        } };
      } finally {
        input.dispose();
        if (result) disposeTensors(result);
      }
    } finally {
      disposeTensors(conditional);
      disposeTensors(unconditional);
    }
  }

  return {
    init,
    getDiagnostics: () => ({ main: main?.getDiagnostics?.(), decoder: decoder?.getDiagnostics?.(), mainGraphCorrection }),
    /** @param {any} request */
    synthesize(request) {
      if (retired) return Promise.reject(new Error('OmniVoice runtime has been disposed.'));
      if (active) return Promise.reject(new Error('OmniVoice generation is already running.'));
      active = generate(request).finally(() => { active = null; });
      return active;
    },
    abortGeneration() { generation += 1; },
    dispose() {
      if (!disposal) {
        retired = true;
        generation += 1;
        disposal = (async () => {
          await loading?.catch(error => log('cleanup', String(error)));
          await active?.catch(error => log('cleanup', String(error)));
          await releaseSessions();
          if (ort === decoderRuntime) await ort.dispose?.();
        })();
      }
      return disposal;
    },
  };
}
