import { describe, expect, it, vi } from 'vitest';
import { createOmniVoiceTts } from '../../src/tts/omnivoice/tts.js';
import { createOmniVoiceRequest, normalizeOmniVoiceSettings } from '../../src/lib/omnivoice-settings.js';
import { normalizePlaybackSettings, savePlaybackSettings } from '../../src/lib/playback-settings.js';
import { OMNIVOICE_LANGUAGES, getOmniVoiceLanguage } from '../../src/tts/omnivoice/languages.js';
import { getLanguageOption, normalizeLanguageCode } from '../../src/lib/language-voice-options.js';

const voice = { engine: 'omnivoice', detectCode: 'sv', omniVoice: { gender: 'male', variation: 1, whisper: true } };
const audio = { pcm: new Float32Array([0.1, -0.1]), sampleRate: 24000 };

describe('OmniVoice integration', () => {
  it('ignores saved speaking pace and bounds voice variations without changing synthesis speed', () => {
    for (const variation of [0, 11, 1.5, Infinity, '4', null]) {
      expect(normalizeOmniVoiceSettings({ variation, tempo: 0.5 }).variation).toBe(1);
    }
    for (let variation = 1; variation <= 10; variation += 1) {
      const selected = { ...voice, omniVoice: { ...voice.omniVoice, variation, tempo: 1.5 } };
      expect(createOmniVoiceRequest('Hej!', selected)).toMatchObject({ speed: 1, seed: 41 + variation });
    }
  });
  it('keeps Kokoro as the default and repairs invalid voice attributes', () => {
    expect(normalizePlaybackSettings()).toMatchObject({ ttsEngine: 'kokoro', omniVoice: { gender: 'female', variation: 1, whisper: false } });
    expect(normalizeOmniVoiceSettings({ gender: 'other', pitch: NaN, age: 7, variation: Infinity, whisper: 'false' })).toEqual(normalizeOmniVoiceSettings());
    expect(createOmniVoiceRequest(' Hej! ', voice)).toEqual({ text: 'Hej!', lang: 'sv', instruct: 'male, whisper', speed: 1, seed: 42, numStep: 24 });
    expect(createOmniVoiceRequest('你好！', { ...voice, detectCode: 'zh' }).instruct).toBe('男，耳语');
    expect(createOmniVoiceRequest('今日は晴れです。', { ...voice, detectCode: 'ja' }).instruct).toBe('男，耳语');
    expect(createOmniVoiceRequest('こんにちは。', { ...voice, detectCode: 'ja' }).instruct).toBe('male, whisper');
    const legacy = { ...voice, omniVoice: { ...voice.omniVoice, pitch: 0, age: 4 } };
    expect(normalizeOmniVoiceSettings(legacy.omniVoice)).toEqual(voice.omniVoice);
    expect(createOmniVoiceRequest('Hej!', legacy)).toEqual(createOmniVoiceRequest('Hej!', voice));
    expect(() => createOmniVoiceRequest(' ', voice)).toThrow();
    expect(() => createOmniVoiceRequest('Hej!', { ...voice, detectCode: 'unsupported' })).toThrow();
  });

  it('exposes all 646 unique upstream languages and validates every ID without weakening the boundary', () => {
    expect(OMNIVOICE_LANGUAGES).toHaveLength(646);
    expect(new Set(OMNIVOICE_LANGUAGES.map(language => language.code)).size).toBe(646);
    for (const language of OMNIVOICE_LANGUAGES) {
      expect(createOmniVoiceRequest('Test', { ...voice, detectCode: language.code }).lang).toBe(language.code);
      expect(getLanguageOption(language.code).label).toBe(language.label);
    }
    for (const value of ['constructor', '__proto__', 'xx', 'en<|text_end|>', null, {}]) {
      expect(getOmniVoiceLanguage(value)).toBeNull();
      expect(() => createOmniVoiceRequest('Test', { ...voice, detectCode: value })).toThrow('supported');
    }
  });

  it.each([['ENG', 'en'], ['jpn', 'ja'], ['cmn', 'zh'], ['ar-EG', 'arb'], ['pt-BR', 'pt'], ['zh-TW', 'zh'], ['yue', 'yue'], ['swe', 'sv']])
    ('maps browser or ISO language %s to model ID %s', (input, canonical) => {
      expect(normalizeLanguageCode(input)).toBe(canonical);
      expect(createOmniVoiceRequest('Test', { ...voice, detectCode: input }).lang).toBe(canonical);
    });

  it('persists engine and sliders without losing the saved Kokoro voice on unrelated writes', async () => {
    let stored = {};
    const storage = { get: async () => stored, set: async next => { stored = next; } };
    await savePlaybackSettings({ voice: 'af_heart', ttsEngine: 'omnivoice', omniVoice: voice.omniVoice }, { storage });
    const settings = await savePlaybackSettings({ speed: 1.2 }, { storage });
    expect(settings).toMatchObject({ voice: 'af_heart', ttsEngine: 'omnivoice', omniVoice: voice.omniVoice, speed: 1.2 });
  });

  it('initializes once, forwards voice attributes and serializes inference', async () => {
    let resolveFirst;
    const first = new Promise(resolve => { resolveFirst = resolve; });
    const engine = { init: vi.fn(async () => {}), synthesize: vi.fn().mockImplementationOnce(() => first).mockResolvedValue(audio), dispose: vi.fn(), abortGeneration: vi.fn() };
    const tts = createOmniVoiceTts({ loadRuntime: async () => engine });
    const pending = tts.generate('Hej!', { voice });
    const next = tts.generate('Igen!', { voice });
    await vi.waitFor(() => expect(engine.synthesize).toHaveBeenCalledTimes(1));
    expect(engine.synthesize).toHaveBeenCalledWith(createOmniVoiceRequest('Hej!', voice));
    resolveFirst(audio);
    expect(await pending).toEqual({ audio: audio.pcm, sampling_rate: 24000 });
    await next;
    expect(engine.init).toHaveBeenCalledTimes(1);
    await tts.dispose();
    await tts.dispose();
    expect(engine.dispose).toHaveBeenCalledTimes(1);
    await expect(tts.generate('Hej!', { voice })).rejects.toThrow('disposed');
  });

  it('uses the established speaker for queued continuation and redesigns it after a voice change', async () => {
    const engine = { init: vi.fn(), synthesize: vi.fn().mockResolvedValue({ ...audio, speaker: { anchorHash: 'fixed-speaker' } }),
      dispose: vi.fn(), abortGeneration: vi.fn() };
    const tts = createOmniVoiceTts({ loadRuntime: async () => engine });
    await Promise.all([tts.generate('Hej!', { voice }), tts.generate('Nästa mening.', { voice })]);
    expect(engine.synthesize.mock.calls.map(([params]) => params.numStep)).toEqual([24, 12]);
    const changed = { ...voice, omniVoice: { ...voice.omniVoice, variation: 4 } };
    await tts.generate('En annan röst.', { voice: changed });
    await tts.generate('Samma nya röst.', { voice: changed });
    expect(engine.synthesize.mock.calls.map(([params]) => params.numStep)).toEqual([24, 12, 24, 12]);
    await tts.dispose();
  });

  it('does not reuse a stale continuation key after a failed voice change', async () => {
    const engine = { init: vi.fn(), synthesize: vi.fn().mockResolvedValue({ ...audio, speaker: { anchorHash: 'speaker' } }),
      dispose: vi.fn(), abortGeneration: vi.fn() };
    const tts = createOmniVoiceTts({ loadRuntime: async () => engine });
    await tts.generate('Hej!', { voice });
    engine.synthesize.mockRejectedValueOnce(new Error('GPU failed during voice change'));
    await expect(tts.generate('Ny röst.', { voice: { ...voice, omniVoice: { ...voice.omniVoice, gender: 'female' } } })).rejects.toThrow('GPU failed');
    await tts.generate('Tillbaka.', { voice });
    expect(engine.synthesize.mock.calls.map(([params]) => params.numStep)).toEqual([24, 24, 24]);
    await tts.dispose();
  });

  it('cancels active inference, skips cancelled queued work and releases only after it settles', async () => {
    let resolveFirst;
    const first = new Promise(resolve => { resolveFirst = resolve; });
    const engine = { init: async () => {}, synthesize: vi.fn(() => first), dispose: vi.fn(), abortGeneration: vi.fn() };
    const tts = createOmniVoiceTts({ loadRuntime: async () => engine });
    const abort = new AbortController();
    const pending = tts.generate('Hej!', { voice, signal: abort.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(engine.synthesize).toHaveBeenCalledTimes(1));
    abort.abort();
    expect(engine.abortGeneration).toHaveBeenCalled();
    const queued = tts.generate('Igen!', { voice, signal: abort.signal });
    const rejectedQueued = expect(queued).rejects.toThrow();
    const disposal = tts.dispose();
    expect(engine.dispose).not.toHaveBeenCalled();
    resolveFirst(audio);
    await rejected;
    await rejectedQueued;
    await disposal;
    expect(engine.synthesize).toHaveBeenCalledTimes(1);
    expect(engine.dispose).toHaveBeenCalledTimes(1);
  });

  it('recovers its queue after a GPU failure', async () => {
    const engine = { init: async () => {}, synthesize: vi.fn().mockRejectedValueOnce(new Error('GPU failed')).mockResolvedValue(audio), dispose: vi.fn(), abortGeneration: vi.fn() };
    const tts = createOmniVoiceTts({ loadRuntime: async () => engine });
    await expect(tts.generate('Hej!', { voice })).rejects.toThrow('GPU failed');
    await expect(tts.generate('Hej!', { voice })).resolves.not.toHaveProperty('voiceRecovery');
    await tts.dispose();
  });

  it('discards bad audio and its worker, retries once, then continues with the recovered speaker', async () => {
    const broken = { init: vi.fn(), synthesize: vi.fn().mockResolvedValue({ ...audio, pcm: new Float32Array(24000).fill(1) }), dispose: vi.fn(), abortGeneration: vi.fn() };
    const recovered = { ...broken, synthesize: vi.fn().mockResolvedValue({ ...audio, speaker: { anchorHash: 'recovered' } }), dispose: vi.fn() };
    const loadRuntime = vi.fn().mockResolvedValueOnce(broken).mockResolvedValue(recovered);
    const onProgress = vi.fn();
    const tts = createOmniVoiceTts({ loadRuntime, onProgress });
    await expect(tts.generate('Hej!', { voice })).resolves.toMatchObject({ sampling_rate: 24000,
      voiceRecovery: { selectedSeed: 42, seed: 43 } });
    expect(broken.dispose).toHaveBeenCalledOnce();
    expect(loadRuntime).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenCalledWith({ message: 'Audio check failed. Recreating this voice…' });
    expect(broken.synthesize).toHaveBeenLastCalledWith(expect.objectContaining({ seed: 42, numStep: 24 }));
    expect(recovered.synthesize).toHaveBeenLastCalledWith(expect.objectContaining({ seed: 43, speed: 1, numStep: 24 }));
    await expect(tts.generate('Nästa mening.', { voice })).resolves.toHaveProperty('voiceRecovery', { selectedSeed: 42, seed: 43 });
    expect(recovered.synthesize).toHaveBeenLastCalledWith(expect.objectContaining({ seed: 43, numStep: 12 }));
    await tts.generate('En annan röst.', { voice: { ...voice, omniVoice: { ...voice.omniVoice, variation: 10 } } });
    expect(recovered.synthesize).toHaveBeenLastCalledWith(expect.objectContaining({ seed: 51, numStep: 24 }));
    await tts.dispose();
  });

  it('stops after one failed audio recovery instead of playing noise or retrying indefinitely', async () => {
    const engine = { init: vi.fn(), synthesize: vi.fn().mockResolvedValue({ ...audio, pcm: [NaN] }), dispose: vi.fn(), abortGeneration: vi.fn() };
    const loadRuntime = vi.fn().mockResolvedValue(engine);
    const tts = createOmniVoiceTts({ loadRuntime });
    await expect(tts.generate('Hej!', { voice })).rejects.toMatchObject({ name: 'OmniVoiceAudioQualityError' });
    expect(engine.synthesize).toHaveBeenCalledTimes(2);
    expect(engine.synthesize.mock.calls.map(([request]) => request.seed)).toEqual([42, 43]);
    expect(loadRuntime).toHaveBeenCalledTimes(2);
    await tts.dispose();
  });

  it('does not retain a recovery seed without a validated speaker anchor', async () => {
    const failure = Object.assign(new Error('Invalid generated audio'), { name: 'OmniVoiceAudioQualityError' });
    const engine = { init: vi.fn(), synthesize: vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(audio),
      dispose: vi.fn(), abortGeneration: vi.fn() };
    const tts = createOmniVoiceTts({ loadRuntime: async () => engine });
    await expect(tts.generate('Hej!', { voice })).resolves.toHaveProperty('voiceRecovery', { selectedSeed: 42, seed: 43 });
    await expect(tts.generate('Igen!', { voice })).resolves.not.toHaveProperty('voiceRecovery');
    expect(engine.synthesize.mock.calls.map(([request]) => [request.seed, request.numStep])).toEqual([[42, 24], [43, 24], [42, 24]]);
    await tts.dispose();
  });

  it('releases a model retired while loading without returning it for playback', async () => {
    let ready;
    const engine = { init: () => new Promise(resolve => { ready = resolve; }), dispose: vi.fn(), abortGeneration: vi.fn() };
    const tts = createOmniVoiceTts({ loadRuntime: async () => engine });
    const initialized = expect(tts.init()).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(ready).toBeTypeOf('function'));
    const disposed = tts.dispose();
    ready();
    await initialized;
    await disposed;
    expect(engine.dispose).toHaveBeenCalledTimes(1);
  });
});
