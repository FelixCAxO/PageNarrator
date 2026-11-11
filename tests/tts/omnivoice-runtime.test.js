import { describe, expect, it, vi } from 'vitest';
import { createOmniVoiceRuntime, estimateOmniVoiceFrames, omniVoiceUnmaskSchedule, unmaskOmniVoiceTokens } from '../../src/tts/omnivoice/runtime.js';
import { floatToHalf, halfToFloat } from '../../src/engines/tensor-format.js';
import { prepareOmniVoiceGraph } from '../../src/tts/omnivoice/rmsnorm-correction.js';
import { getOmniVoiceSpeakerReference } from '../../src/tts/omnivoice/speakers.js';
import { createOmniVoiceRequest } from '../../src/lib/omnivoice-settings.js';

vi.mock('../../src/tts/omnivoice/rmsnorm-correction.js', () => ({ prepareOmniVoiceGraph: vi.fn(async bytes => ({
  bytes, version: 'verified-test-graph', norms: 113, originalSha256: 'original', normalizationSha256: 'corrected', modifiedSha256: 'projected',
})) }));

const request = { text: 'Hej!', lang: 'sv', instruct: '女, 青年, 低音调', speed: 1, seed: 42, numStep: 2 };
const reference = getOmniVoiceSpeakerReference(request);
const config = { num_audio_codebook: 8, audio_vocab_size: 1025, audio_mask_id: 1024, sampling_rate: 24000, frame_rate: 75 };

function fixture(options = {}) {
  const tensors = [];
  class Tensor {
    constructor(type, data, dims) {
      Object.assign(this, { type, data, dims, size: dims.reduce((product, value) => product * value, 1), dispose: vi.fn() });
      tensors.push(this);
    }
    async getData() { return this.data; }
  }
  const main = { release: vi.fn(async () => {}), run: vi.fn(async (feeds, outputs) => {
    expect(outputs).toEqual(['audio_logits']);
    const count = feeds.target_positions.dims[1], offset = feeds.input_ids.dims[2] - count;
    expect([...feeds.target_positions.data]).toEqual(Array.from({ length: count }, (_, index) => BigInt(offset + index)));
    expect(feeds.past_key_27.dims).toEqual([1, 8, feeds.input_ids.dims[2], 128]);
    const length = count - Number(feeds.pn_audio_start.data[0]);
    expect(length).toBeGreaterThan(0);
    const logits = new Float32Array(8 * length * 1025).fill(-2);
    for (let row = 0; row < 8 * length; row += 1) logits[row * 1025 + 3] = 8;
    return { audio_logits: new Tensor('float32', logits, [1, 8, length, 1025]) };
  }) };
  const decoder = { release: vi.fn(async () => {}), run: vi.fn(async ({ audio_codes }) => {
    expect(audio_codes.dims.slice(0, 2)).toEqual([1, 8]);
    expect(audio_codes.dims[2]).toBeGreaterThan(0);
    expect([...audio_codes.data].every(token => token === 3n)).toBe(true);
    return { audio_values: new Tensor('float32', new Float32Array([0.2, -0.3, 0.1]), [1, 1, 3]) };
  }) };
  const ort = { Tensor, InferenceSession: { create: vi.fn().mockResolvedValue(main) } };
  const decoderRuntime = { Tensor, InferenceSession: { create: vi.fn().mockResolvedValue(decoder) } };
  const tokenizer = { encode: vi.fn(value => value.startsWith('<|lang_start|>') ? [10, 11] : [20, 21, 22]) };
  const fetchModel = vi.fn(async url => ({
    json: async () => url.includes('manifest') ? ['omnivoice-main-kv-fp16-b1.onnx_data'] : config,
    arrayBuffer: async () => new ArrayBuffer(4),
  }));
  const gpu = { requestAdapter: async () => ({ features: new Set(['shader-f16']) }) };
  const runtime = createOmniVoiceRuntime({ ort, tokenizer, fetch: fetchModel, gpu, decoderRuntime, ...options });
  return { runtime, tensors, main, decoder, ort, tokenizer, fetchModel, gpu, decoderRuntime };
}

describe('PageNarrator OmniVoice inference bridge', () => {
  it('conditions the main graph on a saved personal reference and rejects malformed audio codes', async () => {
    const f = fixture(); await f.runtime.init('https://model.test');
    const personalReference = { id: 'clone:9b2678e3-1f21-4672-ab81-4781f5d51652', name: 'My Swedish voice', lang: 'sv',
      text: 'Här är min röst.', frames: 76, codes: new Array(8 * 76).fill(461), hash: 'a'.repeat(64) };
    const decoded = Float32Array.from({ length: 76 * 960 }, (_, index) => Math.sin(index / 20) * 0.2);
    f.decoder.run.mockResolvedValueOnce({ audio_values: new f.ort.Tensor('float32', decoded, [1, 1, decoded.length]) });
    const params = { ...createOmniVoiceRequest('Hej!', { detectCode: 'sv', personalReference }), numStep: request.numStep };
    const result = await f.runtime.synthesize(params);
    expect(result.speaker).toMatchObject({ id: personalReference.id, referenceHash: personalReference.hash, referenceFrames: 76 });
    expect(f.tokenizer.encode.mock.calls.some(([value]) => value.includes('Här är min röst. Hej!'))).toBe(true);
    const feeds = f.main.run.mock.calls[0][0];
    const start = feeds.audio_mask.data.indexOf(1);
    expect([...feeds.input_ids.data.slice(start, start + 76)]).toEqual(new Array(76).fill(461n));
    await expect(f.runtime.synthesize({ ...params, personalReference: { ...personalReference, codes: [1024] } })).rejects.toThrow(/personal voice reference/i);
    expect(f.main.run).toHaveBeenCalledTimes(2 * request.numStep);
    await f.runtime.dispose();
  });

  it('prepares a saved reference once and conditions each section on its spoken frames', async () => {
    const f = fixture();
    await f.runtime.init('https://model.test');
    const frames = 76;
    const personalReference = { id: 'clone:9b2678e3-1f21-4672-ab81-4781f5d51652', name: 'Swedish voice', lang: 'sv',
      text: 'Här är min röst', frames, codes: Array.from({ length: 8 * frames }, (_, index) => index), hash: 'a'.repeat(64) };
    const decoded = new Float32Array(frames * 960);
    for (let index = 12 * 960; index < 65 * 960; index += 1) decoded[index] = Math.sin(index / 20) * 0.2;
    f.decoder.run.mockResolvedValueOnce({ audio_values: new f.ort.Tensor('float32', decoded, [1, 1, decoded.length]) });
    const params = { ...createOmniVoiceRequest('Hej!', { detectCode: 'sv', personalReference }), numStep: request.numStep };
    for (const text of ['Hej!', 'God morgon!']) {
      const result = await f.runtime.synthesize({ ...params, text, personalReference: structuredClone(personalReference) });
      expect(result.speaker).toMatchObject({ id: personalReference.id, referenceHash: personalReference.hash, referenceFrames: 54 });
    }
    expect(f.decoder.run).toHaveBeenCalledTimes(3);
    expect(f.tokenizer.encode).toHaveBeenCalledWith('<|text_start|>Här är min röst. Hej!<|text_end|>', { add_special_tokens: false });
    const feeds = f.main.run.mock.calls[0][0];
    const start = feeds.audio_mask.data.indexOf(1);
    for (let book = 0; book < 8; book += 1) {
      const offset = book * feeds.input_ids.dims[2] + start;
      expect(feeds.input_ids.data.slice(offset, offset + 54))
        .toEqual(BigInt64Array.from(personalReference.codes.slice(book * frames + 12, book * frames + 66), BigInt));
    }
    await f.runtime.dispose();
  });

  it('reports the actual guidance scale for each synthesis', async () => {
    const f = fixture(); await f.runtime.init('https://model.test');
    for (const [guidanceScale, speed] of [[2, 1], [3, .85]]) {
      const result = await f.runtime.synthesize({ ...request, guidanceScale, speed });
      expect(result.speaker.guidanceScale).toBe(guidanceScale);
      expect(result.speaker.speed).toBe(speed);
    }
    await f.runtime.dispose();
  });
  it('identifies an oversized section before running inference so the adapter can split it', async () => {
    const f = fixture(); await f.runtime.init('https://model.test');
    await expect(f.runtime.synthesize({ ...request, text: '1'.repeat(2000) }))
      .rejects.toMatchObject({ name: 'OmniVoiceSectionLengthError' });
    expect(f.main.run).not.toHaveBeenCalled(); expect(f.decoder.run).not.toHaveBeenCalled();
    await f.runtime.dispose();
  });

  it.each([true, false])('splits only a decoder buffer-limit failure and keeps the runtime usable (buffer=%s)', async buffer => {
    const f = fixture(); await f.runtime.init('https://model.test');
    const failure = new Error(buffer ? 'ONNX FusedZeroInsertConv1d decoder: Tensor exceeds the WebGPU device buffer limit.' : 'Decoder failed.');
    f.decoder.run.mockRejectedValueOnce(failure);
    const failed = f.runtime.synthesize(request);
    if (buffer) await expect(failed).rejects.toMatchObject({ name: 'OmniVoiceSectionLengthError', cause: failure });
    else await expect(failed).rejects.toBe(failure);
    for (const tensor of f.tensors) expect(tensor.dispose).toHaveBeenCalledOnce();
    await expect(f.runtime.synthesize(request)).resolves.toMatchObject({ sampleRate: 24000 });
    expect(f.ort.InferenceSession.create).toHaveBeenCalledOnce();
    expect(f.decoderRuntime.InferenceSession.create).toHaveBeenCalledOnce();
    await f.runtime.dispose();
  });

  it('reports the audio reference language while conditioning on the requested target language', async () => {
    const f = fixture({ getSpeaker: () => ({ ...reference, text: 'A source recording.', referenceLanguage: 'en' }) });
    await f.runtime.init('https://model.test');
    const result = await f.runtime.synthesize(request);
    expect(result.speaker.referenceLanguage).toBe('en');
    expect(f.tokenizer.encode.mock.calls.some(([text]) => text.startsWith('<|denoise|><|lang_start|>sv<|lang_end|>'))).toBe(true);
    await f.runtime.dispose();
  });
  it('keeps complete attention positions while requesting only generated output rows', async () => {
    const f = fixture(); await f.runtime.init('https://model.test');
    await f.runtime.synthesize(request);
    const frames = estimateOmniVoiceFrames(request.text, request.speed, reference);
    const conditional = f.main.run.mock.calls[0][0], unconditional = f.main.run.mock.calls[1][0];
    expect(conditional.pn_audio_start.dims).toEqual([1]);
    expect([...conditional.pn_audio_start.data]).toEqual([BigInt(conditional.input_ids.dims[2] - frames)]);
    expect([...unconditional.pn_audio_start.data]).toEqual([0n]);
    for (const feeds of [conditional, unconditional]) {
      expect(feeds.attention_mask.dims).toEqual([1, 1, 1, 1]);
      expect([...feeds.attention_mask.data]).toEqual([1]);
      expect(feeds.target_positions.dims).toEqual([1, feeds.input_ids.dims[2]]);
      expect([...feeds.target_positions.data]).toEqual(Array.from({ length: feeds.input_ids.dims[2] }, (_, index) => BigInt(index)));
    }
    expect(f.runtime.getDiagnostics().mainGraphCorrection).toMatchObject({ normalizationSha256: 'corrected', modifiedSha256: 'projected' });
    await f.runtime.dispose(); expect(f.tensors.every(tensor => tensor.dispose.mock.calls.length === 1)).toBe(true);
  });

  it.each([Float32Array, Uint16Array])('preserves every 24-step decision and random draw with compact conditional rows (%s)', ArrayType => {
    const frames = 5, prefix = 7, full = new ArrayType(8 * (prefix + frames) * 1025), compact = new ArrayType(8 * frames * 1025);
    const unconditional = new ArrayType(compact.length);
    full.fill(ArrayType === Uint16Array ? 0x7e01 : NaN);
    for (let index = 0; index < compact.length; index++) {
      const c = (index % 127 - 63) / 32, u = (index % 67 - 33) / 16;
      compact[index] = ArrayType === Uint16Array ? floatToHalf(c) : c;
      unconditional[index] = ArrayType === Uint16Array ? floatToHalf(u) : u;
    }
    for (let book = 0; book < 8; book++) full.set(compact.subarray(book * frames * 1025, (book + 1) * frames * 1025), (book * (prefix + frames) + prefix) * 1025);
    const a = new BigInt64Array(8 * frames).fill(1024n), b = a.slice();
    let seedA = 42, seedB = 42, callsA = 0, callsB = 0;
    const randomA = () => { callsA++; seedA = (Math.imul(seedA, 1664525) + 1013904223) >>> 0; return (seedA + .5) / 4294967296; };
    const randomB = () => { callsB++; seedB = (Math.imul(seedB, 1664525) + 1013904223) >>> 0; return (seedB + .5) / 4294967296; };
    for (const count of omniVoiceUnmaskSchedule(a.length, 24)) {
      unmaskOmniVoiceTokens(full, unconditional, a, frames, prefix, count, randomA);
      unmaskOmniVoiceTokens(compact, unconditional, b, frames, 0, count, randomB);
      expect(b).toEqual(a); expect(callsB).toBe(callsA); expect(seedB).toBe(seedA);
    }
    expect([...b].every(value => value !== 1024n)).toBe(true);
  });

  it('reports remaining work without changing decoder tokens or PCM', async () => {
    const f = fixture();
    await f.runtime.init('https://model.test');
    const onProgress = vi.fn();
    const measured = await f.runtime.synthesize(request, { onProgress });
    const plain = await f.runtime.synthesize(request);
    expect(measured.pcm).toEqual(plain.pcm);
    expect(onProgress).toHaveBeenCalledTimes(request.numStep);
    expect(onProgress.mock.calls.every(([progress]) => Number.isFinite(progress.remainingMs) && progress.remainingMs >= 0)).toBe(true);
    expect(onProgress).toHaveBeenLastCalledWith({ remainingMs: 0 });
    await f.runtime.dispose();
  });
  it('rejects an unrecognized graph before creating either inference session', async () => {
    const f = fixture();
    prepareOmniVoiceGraph.mockRejectedValueOnce(new Error('Exact pinned graph required'));
    await expect(f.runtime.init('https://model.test')).rejects.toThrow('Exact pinned graph');
    expect(f.ort.InferenceSession.create).not.toHaveBeenCalled();
    expect(f.decoderRuntime.InferenceSession.create).not.toHaveBeenCalled();
    expect(f.runtime.getDiagnostics().mainGraphCorrection).toBeNull();
    await f.runtime.dispose();
  });
  it('keeps token selection identical when decoding every finite fp16 bit pattern from an offset view', async () => {
    const captured = [];
    for (const type of ['float32', 'float16']) {
      const f = fixture();
      f.main.run.mockImplementation(async feeds => {
        const length = feeds.target_positions.dims[1] - Number(feeds.pn_audio_start.data[0]), size = 8 * length * 1025;
        const storage = new Uint16Array(size + 3), bits = storage.subarray(3);
        for (let index = 0; index < bits.length; index++) {
          const value = index % 65536;
          bits[index] = (value & 0x7c00) === 0x7c00 ? 0 : value;
        }
        return { audio_logits: new f.ort.Tensor(type, type === 'float16' ? bits : Float32Array.from(bits, halfToFloat), [1, 8, length, 1025]) };
      });
      f.decoder.run.mockImplementation(async ({ audio_codes }) => {
        captured.push([...audio_codes.data]);
        return { audio_values: new f.ort.Tensor('float32', Float32Array.of(0.2, -0.3, 0.1), [1, 1, 3]) };
      });
      await f.runtime.init('https://model.test');
      await f.runtime.synthesize(request);
      await f.runtime.dispose();
    }
    expect(captured[1]).toEqual(captured[0]);
  });
  it.each([
    ['Hej!', [49, 24, 16]],
    ['Nu läser PageNarrator svenska med OmniVoice.', [140, 70, 46]],
    ['Hello world!', [72, 36, 24]],
    ['Nice to meet you.', [79, 39, 26]],
    ['A\u030a, 123!', [76, 38, 25]],
    ['你好，世界！', [77, 38, 25]],
    ['こんにちは、世界。', [86, 43, 28]],
    ['مرحبا بالعالم', [86, 43, 28]],
    ['नमस्ते दुनिया', [76, 38, 25]],
    ['안녕하세요 세계', [85, 42, 28]],
    ['สวัสดีชาวโลก', [81, 40, 27]],
    ['မင်္ဂလာပါ', [68, 34, 22]],
    ['ሰላም ዓለም', [86, 43, 28]],
    ['Привет, мир!', [71, 35, 23]],
    ['שלום עולם', [75, 37, 25]],
    ['ᐊᐃᓐᓇᖅ', [56, 28, 18]],
    ['𠮷你好', [68, 34, 22]],
    ['مــــرحبا', [64, 32, 21]],
  ])('matches the licensed reference duration rule for %s with a one-second reference', (text, frames) => {
    expect([0.5, 1, 1.5].map(speed => estimateOmniVoiceFrames(text, speed))).toEqual(frames);
  });

  it('keeps the final German word duration when generated reference frames have already been rounded', () => {
    expect(estimateOmniVoiceFrames('Heute lesen wir eine kurze Geschichte. Das Buch liegt auf dem Tisch.',1)).toBe(103);
  });

  it.each([1, 2, 24, 64])('unmasks every token exactly once in %i steps', steps => {
    const counts = omniVoiceUnmaskSchedule(280, steps);
    expect(counts).toHaveLength(steps);
    expect(counts.every(count => Number.isInteger(count) && count >= 0)).toBe(true);
    expect(counts.reduce((sum, count) => sum + count, 0)).toBe(280);
  });

  it('uses guided normalized confidence, ignores prefix logits and never selects the MASK class', () => {
    const c = new Float32Array(8 * 2 * 1025);
    const u = new Float32Array(8 * 1025);
    const codes = new BigInt64Array(8).fill(1024n);
    codes[7] = 19n;
    for (let book = 0; book < 8; book += 1) {
      c[book * 2 * 1025 + 33] = 100; // Prefix must not influence the predicted audio.
      c[(book * 2 + 1) * 1025 + 2] = 3;
      c[(book * 2 + 1) * 1025 + 7] = 2;
      u[book * 1025 + 2] = 5; // CFG turns the raw conditional winner into a loser.
      c[(book * 2 + 1) * 1025 + 1024] = 10;
    }
    unmaskOmniVoiceTokens(c, u, codes, 1, 1, 1, () => 0.5);
    expect([...codes]).toEqual([7n, 1024n, 1024n, 1024n, 1024n, 1024n, 1024n, 19n]);
    unmaskOmniVoiceTokens(c, u, codes, 1, 1, 7, () => 0.5);
    expect([...codes]).toEqual([7n, 7n, 7n, 7n, 7n, 7n, 7n, 19n]);
  });

  it.each([[false, false], [false, true], [true, false], [true, true]])('matches float32 sampling across all finite half values and 24 steps, cHalf=%s uHalf=%s', (cHalf, uHalf) => {
    const frames = 9, prefix = 5;
    const bits = length => Uint16Array.from({ length }, (_, index) => (index % 65536 & 0x7c00) === 0x7c00 ? 0 : index % 65536);
    const c = bits(8 * (frames + prefix) * 1025), u = bits(8 * frames * 1025);
    const cf = Float32Array.from(c, halfToFloat), uf = Float32Array.from(u, halfToFloat);
    const sample = (conditional, unconditional) => {
      const codes = new BigInt64Array(frames * 8).fill(1024n); codes[13] = 7n;
      let state = 42, calls = 0;
      const rng = () => { calls++; state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return (state + .5) / 4294967296; };
      for (const count of omniVoiceUnmaskSchedule(codes.length - 1, 24)) unmaskOmniVoiceTokens(conditional, unconditional, codes, frames, prefix, count, rng);
      return { codes: [...codes], calls };
    };
    expect(sample(cHalf ? c : cf, uHalf ? u : uf)).toEqual(sample(cf, uf));
  });

  it.each([[true, 0x7e00], [true, 0x7c00], [true, 0xfc00], [false, 0x7e00], [false, 0x7c00], [false, 0xfc00]])('rejects non-finite half logits, conditional=%s bits=%i', (conditional, value) => {
    const c = new Uint16Array(8 * 1025), u = new Uint16Array(c.length), codes = new BigInt64Array(8).fill(1024n);
    (conditional ? c : u)[1024] = value;
    expect(() => unmaskOmniVoiceTokens(c, u, codes, 1, 0, 1, () => .5)).toThrow('non-finite logits');
  });

  it('skips unused non-finite prefix and decided rows in half storage', () => {
    const c = new Uint16Array(8 * 2 * 1025).fill(0x7e00), u = new Uint16Array(8 * 1025).fill(0x7e00);
    c.fill(0, 1025, 2 * 1025); u.fill(0, 0, 1025);
    const codes = new BigInt64Array(8).fill(7n); codes[0] = 1024n;
    const random = vi.fn(() => .5);
    unmaskOmniVoiceTokens(c, u, codes, 1, 1, 1, random);
    expect([...codes]).toEqual([0n, 7n, 7n, 7n, 7n, 7n, 7n, 7n]);
    expect(random).toHaveBeenCalledOnce();
  });

  it('loads only WebGPU sessions, forwards style/text and decodes complete audio tokens', async () => {
    const f = fixture();
    f.main.getDiagnostics = vi.fn(() => ({ hostWeightBytes: 100 }));
    await f.runtime.init('https://model.test');
    expect(f.ort.InferenceSession.create.mock.calls.every(([, options]) => options.executionProviders.join() === 'webgpu')).toBe(true);
    expect(f.ort.InferenceSession.create).toHaveBeenCalledTimes(1);
    expect(f.ort.InferenceSession.create.mock.calls[0][1]).toMatchObject({
      maxCachedPlans: 2, externalData: [{ path: 'omnivoice-main-kv-fp16-b1.onnx_data' }],
    });
    expect(f.decoderRuntime.InferenceSession.create).toHaveBeenCalledTimes(1);
    const result = await f.runtime.synthesize(request);
    expect(f.main.getDiagnostics).not.toHaveBeenCalled();
    expect(f.runtime.getDiagnostics().main).toEqual({ hostWeightBytes: 100 });
    expect(f.tokenizer.encode.mock.calls.map(([text]) => text)).toEqual([
      '<|denoise|><|lang_start|>sv<|lang_end|><|instruct_start|>女, 青年, 低音调<|instruct_end|>', `<|text_start|>${reference.text} Hej!<|text_end|>`,
    ]);
    expect(result).toMatchObject({ pcm: new Float32Array([0.2, -0.3, 0.1]), sampleRate: 24000,
      speaker: { referenceHash: reference.hash, referenceFrames: reference.frames, anchorHash: reference.hash } });
    expect(f.main.run).toHaveBeenCalledTimes(4);
    expect(f.tensors.every(tensor => tensor.dispose.mock.calls.length === 1)).toBe(true);
    await f.runtime.dispose();
    await f.runtime.dispose();
    expect(f.main.release).toHaveBeenCalledTimes(1);
    expect(f.decoder.release).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['𝖧𝖾𝗅𝗅𝗈, 𝖶𝗈𝗋𝗅𝖽!', 'Hello, World!'],
    ['𝛂𝛃𝛄 𝚨𝚩𝚪', 'αβγ ΑΒΓ'],
    ['𝟘𝟙𝟚 𝟿', '012 9'],
    ['𝑨\u030A and e\u0301', 'Å and é'],
    ['x² ① H₂O العربية हिन्दी 日本語 \u{1D800}', 'x² ① H₂O العربية हिन्दी 日本語 \u{1D800}'],
  ])('normalizes only mathematical styling in spoken %s without changing the request', async (text, spoken) => {
    const f = fixture(), input = Object.freeze({ ...request, text });
    f.decoder.run.mockImplementation(async ({ audio_codes }) => {
      expect(audio_codes.dims).toEqual([1, 8, estimateOmniVoiceFrames(spoken, request.speed, reference)]);
      return { audio_values: new f.ort.Tensor('float32', Float32Array.of(0.2, -0.3, 0.1), [1, 1, 3]) };
    });
    await f.runtime.init('https://model.test');
    await f.runtime.synthesize(input);
    expect(f.tokenizer.encode).toHaveBeenCalledWith(`<|text_start|>${reference.text} ${spoken}<|text_end|>`, { add_special_tokens: false });
    expect(input.text).toBe(text);
    for (const speed of [0.5, 1, 1.5]) expect(estimateOmniVoiceFrames(text, speed, reference)).toBe(estimateOmniVoiceFrames(spoken, speed, reference));
    await f.runtime.dispose();
    expect(f.tensors.every(tensor => tensor.dispose.mock.calls.length === 1)).toBe(true);
  });

  it('uses the same normalized speech in the first prompt and later speaker references', async () => {
    const f = fixture();
    f.decoder.run.mockImplementation(async () => ({ audio_values: new f.ort.Tensor('float32', Float32Array.of(0.2, -0.3, 0.1), [1, 1, 3]) }));
    const firstRequest = Object.freeze({ ...request, text: '  𝖧𝖾𝗅𝗅𝗈 𝛂 𝟚!  ' });
    const secondRequest = Object.freeze({ ...request, text: '𝖶𝗈𝗋𝗅𝖽 𝛃 𝟛.' });
    await f.runtime.init('https://model.test');
    const first = await f.runtime.synthesize(firstRequest);
    const second = await f.runtime.synthesize(secondRequest);
    expect(f.tokenizer.encode).toHaveBeenCalledWith(`<|text_start|>${reference.text} Hello α 2!<|text_end|>`, { add_special_tokens: false });
    expect(f.tokenizer.encode).toHaveBeenCalledWith(`<|text_start|>${reference.text} World β 3.<|text_end|>`, { add_special_tokens: false });
    expect(second.speaker.referenceHash).toBe(first.speaker.anchorHash);
    expect(firstRequest.text).toBe('  𝖧𝖾𝗅𝗅𝗈 𝛂 𝟚!  ');
    expect(secondRequest.text).toBe('𝖶𝗈𝗋𝗅𝖽 𝛃 𝟛.');
    await f.runtime.dispose();
    expect(f.tensors.every(tensor => tensor.dispose.mock.calls.length === 1)).toBe(true);
  });

  it('preserves Turkish Bugün pronunciation without changing document text or other languages', async () => {
    const f = fixture(), text = 'Bugün kısa bir hikâye okuyoruz. Bugünkü kitap burada.';
    f.decoder.run.mockImplementation(async () => ({ audio_values: new f.ort.Tensor('float32', Float32Array.of(0.2, -0.3, 0.1), [1, 1, 3]) }));
    await f.runtime.init('https://model.test');
    for (const lang of ['tr', 'en']) {
      const input = Object.freeze({ ...request, lang, text });
      await f.runtime.synthesize(input);
      const speaker = getOmniVoiceSpeakerReference(input);
      expect(f.tokenizer.encode).toHaveBeenLastCalledWith(`<|text_start|>${speaker.text} ${lang === 'tr' ? 'bugün kısa bir hikâye okuyoruz. bugünkü kitap burada.' : text}<|text_end|>`, { add_special_tokens: false });
      expect(input.text).toBe(text);
    }
    await f.runtime.dispose();
  });

  it('applies measured Cantonese spelling only when requested and retains the original document text', async () => {
    const f = fixture(), text = '您好，您嘅書喺枱面。';
    f.decoder.run.mockImplementation(async () => ({ audio_values: new f.ort.Tensor('float32', Float32Array.of(.2, -.3, .1), [1, 1, 3]) }));
    await f.runtime.init('https://model.test');
    for (const [lang, pronunciationVariant, spoken] of [['yue', null, text], ['yue', 'yue-nei5', '你好，你嘅書喺枱面。'], ['zh', null, text]]) {
      const input = Object.freeze({ ...request, text, lang, pronunciationVariant });
      const result = await f.runtime.synthesize(input), reference = getOmniVoiceSpeakerReference(input);
      expect(f.tokenizer.encode).toHaveBeenLastCalledWith(`<|text_start|>${reference.text} ${spoken}<|text_end|>`, { add_special_tokens: false });
      expect(result.speaker.pronunciationVariant).toBe(pronunciationVariant); expect(input.text).toBe(text);
      expect(estimateOmniVoiceFrames(text, 1, reference)).toBe(estimateOmniVoiceFrames(spoken, 1, reference));
    }
    await f.runtime.dispose();
  });

  it('renders whisper from the same decoded speaker and keeps its backing speech reproducible', async () => {
    const f = fixture();
    const audio = Float32Array.from({ length: 12000 }, (_, i) => 0.12 * Math.sin(2 * Math.PI * 150 * i / 24000));
    f.decoder.run.mockImplementation(async () => ({ audio_values: new f.ort.Tensor('float32', audio, [1, 1, audio.length]) }));
    await f.runtime.init('https://model.test');
    const normal = await f.runtime.synthesize(request);
    const whisper = await f.runtime.synthesize({ ...request, whisper: true });
    expect(whisper.speaker).toEqual(normal.speaker);
    expect(whisper.backingPcmSha256).toBe(normal.backingPcmSha256);
    expect(whisper.pcm).not.toEqual(normal.pcm);
    expect(whisper.pcm).toHaveLength(normal.pcm.length);
    expect(normal.pcm).toEqual(audio);
    expect((await f.runtime.synthesize({ ...request, whisper: true })).pcm).toEqual(whisper.pcm);
    await f.runtime.dispose();
  });

  it('conditions every later sentence on the first speaker and resets when voice attributes change', async () => {
    const f = fixture(), feeds = [];
    const run = f.main.run.getMockImplementation();
    f.main.run.mockImplementation(async (input, outputs) => {
      feeds.push({ ids: input.input_ids.data.slice(), mask: input.audio_mask.data.slice(), length: input.input_ids.dims[2],
        positions: input.position_ids.data.slice() });
      return run(input, outputs);
    });
    await f.runtime.init('https://model.test');
    const first = await f.runtime.synthesize(request);
    const second = await f.runtime.synthesize({ ...request, text: 'Hey!' });
    const third = await f.runtime.synthesize({ ...request, text: 'Hey!' });
    expect(second.speaker.referenceHash).toBe(first.speaker.anchorHash);
    expect(third.speaker.referenceHash).toBe(first.speaker.anchorHash);
    expect(f.tokenizer.encode).toHaveBeenCalledWith(`<|text_start|>${reference.text} Hey!<|text_end|>`, { add_special_tokens: false });
    expect(f.tokenizer.encode).toHaveBeenCalledWith(expect.stringMatching(/^<\|denoise\|>/), { add_special_tokens: false });
    const conditioned = feeds[4];
    const frames = estimateOmniVoiceFrames('Hey!', request.speed, reference);
    expect(conditioned.length).toBe(6 + reference.frames + frames);
    expect([...conditioned.mask]).toEqual([...Array(6).fill(0), ...Array(reference.frames + frames).fill(1)]);
    expect([...conditioned.positions]).toEqual(Array.from({ length: conditioned.length }, (_, i) => BigInt(i)));
    for (let book = 0; book < 8; book += 1) {
      expect([...conditioned.ids.slice(book * conditioned.length + 6, book * conditioned.length + 6 + reference.frames)])
        .toEqual([...reference.codes.slice(book * reference.frames, (book + 1) * reference.frames)]);
      expect([...conditioned.ids.slice(book * conditioned.length + 6 + reference.frames, (book + 1) * conditioned.length)]).toEqual(Array(frames).fill(1024n));
    }
    const changed = await f.runtime.synthesize({ ...request, instruct: '男, 青年, 低音调' });
    expect(changed.speaker.id).toBe('male-1');
    expect(changed.speaker.referenceHash).not.toBe(reference.hash);
    await f.runtime.dispose();
    expect(f.tensors.every(tensor => tensor.dispose.mock.calls.length === 1)).toBe(true);
  });

  it.each([Uint16Array, Int16Array])('reads two-byte float16 views including negative values (%s)', async View => {
    const f = fixture();
    f.main.run.mockImplementation(async feeds => {
      const length = feeds.target_positions.dims[1] - Number(feeds.pn_audio_start.data[0]);
      const data = new View(8 * length * 1025).fill(0xc000); // -2
      for (let row = 0; row < 8 * length; row += 1) data[row * 1025 + 3] = 0x4800; // 8
      return { audio_logits: new f.ort.Tensor('float16', data, [1, 8, length, 1025]) };
    });
    await f.runtime.init('https://model.test');
    await expect(f.runtime.synthesize(request)).resolves.toHaveProperty('sampleRate', 24000);
    await f.runtime.dispose();
  });

  it.each(['de', 'es', 'ru', 'zh', 'ja', 'arb', 'hi', 'yue', 'kbt'])('forwards the canonical %s language tag to inference', async lang => {
    const f = fixture();
    await f.runtime.init('https://model.test');
    await f.runtime.synthesize({ ...request, lang });
    expect(f.tokenizer.encode.mock.calls[0][0]).toContain(`<|lang_start|>${lang}<|lang_end|>`);
    await f.runtime.dispose();
  });

  it('refuses unsupported hardware before downloading any model', async () => {
    const f = fixture();
    const runtime = createOmniVoiceRuntime({ ort: f.ort, tokenizer: f.tokenizer, fetch: f.fetchModel, gpu: { requestAdapter: async () => null } });
    await expect(runtime.init('https://model.test')).rejects.toThrow('shader-f16');
    expect(f.fetchModel).not.toHaveBeenCalled();
    await runtime.dispose();
  });

  it('validates model metadata before creating sessions', async () => {
    const f = fixture();
    f.fetchModel.mockResolvedValue({ json: async () => ({ ...config, sampling_rate: 16000 }) });
    await expect(f.runtime.init('https://model.test')).rejects.toThrow('configuration');
    expect(f.ort.InferenceSession.create).not.toHaveBeenCalled();
    await f.runtime.dispose();
  });

  it('releases a partial load and can initialize again after a decoder load failure', async () => {
    const f = fixture();
    f.decoderRuntime.InferenceSession.create.mockRejectedValueOnce(new Error('Decoder load failed'));
    await expect(f.runtime.init('https://model.test')).rejects.toThrow('Decoder load failed');
    expect(f.main.release).toHaveBeenCalledTimes(1);
    await f.runtime.init('https://model.test');
    await f.runtime.dispose();
    expect(f.main.release).toHaveBeenCalledTimes(2);
  });

  it('waits for active inference before releasing sessions, rejects overlap and skips decoding after abort', async () => {
    const f = fixture();
    await f.runtime.init('https://model.test');
    let finish;
    f.main.run.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const result = f.runtime.synthesize(request);
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    await expect(f.runtime.synthesize(request)).rejects.toThrow('already running');
    const disposed = f.runtime.dispose();
    expect(f.main.release).not.toHaveBeenCalled();
    finish({ audio_logits: new f.ort.Tensor('float32', new Float32Array(0), [0]) });
    await rejected;
    await disposed;
    expect(f.decoder.run).not.toHaveBeenCalled();
    expect(f.tensors.every(tensor => tensor.dispose.mock.calls.length === 1)).toBe(true);
    expect(f.main.release).toHaveBeenCalledTimes(1);
    await expect(f.runtime.synthesize(request)).rejects.toThrow('disposed');
  });

  it('releases tensors on inference failure and recovers on the next request', async () => {
    const f = fixture();
    await f.runtime.init('https://model.test');
    f.main.run.mockRejectedValueOnce(new Error('GPU failed'));
    await expect(f.runtime.synthesize(request)).rejects.toThrow('GPU failed');
    expect(f.tensors.every(tensor => tensor.dispose.mock.calls.length === 1)).toBe(true);
    await expect(f.runtime.synthesize(request)).resolves.toHaveProperty('sampleRate', 24000);
    await f.runtime.dispose();
  });

  it('rejects non-finite logits before decoding and releases every tensor', async () => {
    const f = fixture();
    await f.runtime.init('https://model.test');
    f.main.run.mockImplementationOnce(async feeds => {
      const length = feeds.target_positions.dims[1] - Number(feeds.pn_audio_start.data[0]);
      return { audio_logits: new f.ort.Tensor('float32', new Float32Array(8 * length * 1025).fill(NaN), [1, 8, length, 1025]) };
    });
    await expect(f.runtime.synthesize(request)).rejects.toThrow('non-finite');
    expect(f.decoder.run).not.toHaveBeenCalled();
    expect(f.tensors.every(tensor => tensor.dispose.mock.calls.length === 1)).toBe(true);
    await f.runtime.dispose();
  });

  it('rejects static before retaining it as a speaker reference', async () => {
    const f = fixture();
    await f.runtime.init('https://model.test');
    f.decoder.run.mockResolvedValueOnce({ audio_values: new f.ort.Tensor('float32', new Float32Array(24000).fill(1), [1, 1, 24000]) });
    await expect(f.runtime.synthesize(request)).rejects.toMatchObject({ name: 'OmniVoiceAudioQualityError' });
    const recovered = await f.runtime.synthesize(request);
    expect(recovered.speaker.referenceHash).toBe(reference.hash);
    expect(recovered.speaker.anchorHash).toBeTruthy();
    await f.runtime.dispose();
    expect(f.tensors.every(tensor => tensor.dispose.mock.calls.length === 1)).toBe(true);
  });

  it.each([{ ...request, guidanceScale: -1 }, { ...request, guidanceScale: 5 }, { ...request, guidanceScale: NaN }, { ...request, guidanceScale: null }, { ...request, guidanceScale: '3' }, { ...request, speed: NaN }, { ...request, numStep: 0 }, { ...request, whisper: 'true' }, { ...request, lang: 'unsupported' }, { ...request, lang: undefined }, { ...request, lang: 'ar' }, { ...request, text: '' },
    { ...request, text: 'abc '.repeat(2000) }, { ...request, pronunciationVariant: true },
    { ...request, pronunciationVariant: 'unknown' }, { ...request, pronunciationVariant: 'yue-nei5' },
    { ...request, lang: 'zh', pronunciationVariant: 'yue-nei5' }])('rejects invalid or oversized requests without inference', async bad => {
    const f = fixture();
    await f.runtime.init('https://model.test');
    await expect(f.runtime.synthesize(bad)).rejects.toThrow();
    expect(f.main.run).not.toHaveBeenCalled();
    await f.runtime.dispose();
  });
});
