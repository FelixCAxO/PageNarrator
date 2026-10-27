import { describe, expect, it, vi } from 'vitest';
import { createOmniVoiceRuntime, estimateOmniVoiceFrames, omniVoiceUnmaskSchedule, unmaskOmniVoiceTokens } from '../../src/tts/omnivoice/runtime.js';
import { halfToFloat } from '../../src/engines/tensor-format.js';
import { applyOmniVoiceRmsNormCorrection } from '../../src/tts/omnivoice/rmsnorm-correction.js';
import { getOmniVoiceSpeakerReference } from '../../src/tts/omnivoice/speakers.js';

vi.mock('../../src/tts/omnivoice/rmsnorm-correction.js', () => ({ applyOmniVoiceRmsNormCorrection: vi.fn(async bytes => ({
  bytes, version: 'verified-test-graph', norms: 113, originalSha256: 'original', modifiedSha256: 'corrected',
})) }));

const request = { text: 'Hej!', lang: 'sv', instruct: '女, 青年, 低音调', speed: 1, seed: 42, numStep: 2 };
const reference = getOmniVoiceSpeakerReference(request);
const config = { num_audio_codebook: 8, audio_vocab_size: 1025, audio_mask_id: 1024, sampling_rate: 24000, frame_rate: 75 };

function fixture() {
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
    const length = feeds.target_positions.dims[1];
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
  const runtime = createOmniVoiceRuntime({ ort, tokenizer, fetch: fetchModel, gpu, decoderRuntime });
  return { runtime, tensors, main, decoder, ort, tokenizer, fetchModel, gpu, decoderRuntime };
}

describe('PageNarrator OmniVoice inference bridge', () => {
  it('rejects an unrecognized graph before creating either inference session', async () => {
    const f = fixture();
    applyOmniVoiceRmsNormCorrection.mockRejectedValueOnce(new Error('Exact pinned graph required'));
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
        const length = feeds.target_positions.dims[1], size = 8 * length * 1025;
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
      expect(audio_codes.dims).toEqual([1, 8, estimateOmniVoiceFrames(spoken, request.speed)]);
      return { audio_values: new f.ort.Tensor('float32', Float32Array.of(0.2, -0.3, 0.1), [1, 1, 3]) };
    });
    await f.runtime.init('https://model.test');
    await f.runtime.synthesize(input);
    expect(f.tokenizer.encode).toHaveBeenCalledWith(`<|text_start|>${reference.text} ${spoken}<|text_end|>`, { add_special_tokens: false });
    expect(input.text).toBe(text);
    for (const speed of [0.5, 1, 1.5]) expect(estimateOmniVoiceFrames(text, speed)).toBe(estimateOmniVoiceFrames(spoken, speed));
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
    expect(conditioned.length).toBe(6 + reference.frames + 24);
    expect([...conditioned.mask]).toEqual([...Array(6).fill(0), ...Array(reference.frames + 24).fill(1)]);
    expect([...conditioned.positions]).toEqual(Array.from({ length: conditioned.length }, (_, i) => BigInt(i)));
    for (let book = 0; book < 8; book += 1) {
      expect([...conditioned.ids.slice(book * conditioned.length + 6, book * conditioned.length + 6 + reference.frames)])
        .toEqual([...reference.codes.slice(book * reference.frames, (book + 1) * reference.frames)]);
      expect([...conditioned.ids.slice(book * conditioned.length + 6 + reference.frames, (book + 1) * conditioned.length)]).toEqual(Array(24).fill(1024n));
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
      const length = feeds.target_positions.dims[1];
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
    f.main.run.mockImplementationOnce(async feeds => ({ audio_logits: new f.ort.Tensor('float32',
      new Float32Array(8 * feeds.target_positions.dims[1] * 1025).fill(NaN), [1, 8, feeds.target_positions.dims[1], 1025]) }));
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

  it.each([{ ...request, speed: NaN }, { ...request, numStep: 0 }, { ...request, whisper: 'true' }, { ...request, lang: 'unsupported' }, { ...request, lang: undefined }, { ...request, lang: 'ar' }, { ...request, text: '' },
    { ...request, text: 'abc '.repeat(2000) }])('rejects invalid or oversized requests without inference', async bad => {
    const f = fixture();
    await f.runtime.init('https://model.test');
    await expect(f.runtime.synthesize(bad)).rejects.toThrow();
    expect(f.main.run).not.toHaveBeenCalled();
    await f.runtime.dispose();
  });
});
