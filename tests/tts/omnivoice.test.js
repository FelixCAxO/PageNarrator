import { describe, expect, it, vi } from 'vitest';
import { createOmniVoiceTts } from '../../src/tts/omnivoice/tts.js';
import { createOmniVoiceRequest, normalizeOmniVoiceSettings, hasOmniVoiceWhisperWordLossRisk } from '../../src/lib/omnivoice-settings.js';
import { normalizePlaybackSettings, savePlaybackSettings } from '../../src/lib/playback-settings.js';
import { OMNIVOICE_LANGUAGES, getOmniVoiceLanguage, getOmniVoiceLanguageOptions } from '../../src/tts/omnivoice/languages.js';
import { getLanguageOption, normalizeLanguageCode } from '../../src/lib/language-voice-options.js';

const voice = { engine: 'omnivoice', detectCode: 'sv', omniVoice: { gender: 'male', variation: 1, whisper: true } };
const audio = { pcm: new Float32Array([0.1, -0.1]), sampleRate: 24000 };

describe('OmniVoice integration', () => {
  it('offers a short language list while preserving an existing uncommon selection', () => {
    const options = getOmniVoiceLanguageOptions();
    expect(options).toHaveLength(32);
    expect(new Set(options.map(({ code }) => code)).size).toBe(32);
    expect(options.map(({ code }) => code)).toEqual(expect.arrayContaining(['en', 'sv', 'arb', 'zh', 'yue']));
    expect(options.map(({ code }) => code)).not.toContain('sol');
    expect(getOmniVoiceLanguageOptions('swe')).toBe(options);
    expect(getOmniVoiceLanguageOptions('invalid')).toBe(options);
    expect(getOmniVoiceLanguageOptions('sol')).toEqual([...options, getOmniVoiceLanguage('sol')]);
  });

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
    expect(createOmniVoiceRequest(' Hej! ', voice)).toEqual({ text: 'Hej!', lang: 'sv', instruct: 'male', speed: 1, speakerId:'male-1', seed: 42, numStep: 24, whisper:true });
    expect(createOmniVoiceRequest('你好！', { ...voice, detectCode: 'zh' }).instruct).toBe('男');
    expect(createOmniVoiceRequest('今日は晴れです。', { ...voice, detectCode: 'ja' }).instruct).toBe('男');
    expect(createOmniVoiceRequest('こんにちは。', { ...voice, detectCode: 'ja' }).instruct).toBe('male');
    expect(createOmniVoiceRequest('Bugün kısa bir hikâye okuyoruz.', { ...voice, detectCode: 'tr' }).numStep).toBe(32);
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
      expect(createOmniVoiceRequest('Test', { ...voice, detectCode: language.code, omniVoice:{...voice.omniVoice,whisper:false} }).lang).toBe(language.code);
      expect(getLanguageOption(language.code).label).toBe(language.label);
    }
    for (const value of ['constructor', '__proto__', 'xx', 'en<|text_end|>', null, {}]) {
      expect(getOmniVoiceLanguage(value)).toBeNull();
      expect(() => createOmniVoiceRequest('Test', { ...voice, detectCode: value })).toThrow('supported');
    }
  });

  it.each(['yue','th'])('retains selectable %s whispering and saved preferences with a word-loss warning', language=>{
    expect(createOmniVoiceRequest('Test', {...voice,detectCode:language})).toMatchObject({lang:language,whisper:true,speakerId:'male-1',seed:42});
    expect(hasOmniVoiceWhisperWordLossRisk(language)).toBe(true);
    expect(createOmniVoiceRequest('Test',{...voice,detectCode:language,omniVoice:{...voice.omniVoice,whisper:false}}).lang).toBe(language);
    expect(normalizePlaybackSettings({language,omniVoice:voice.omniVoice}).omniVoice.whisper).toBe(true);
    expect(normalizePlaybackSettings({language:'sv',omniVoice:voice.omniVoice}).omniVoice.whisper).toBe(true);
    expect(hasOmniVoiceWhisperWordLossRisk('sv')).toBe(false);
  });

  it.each([['ENG', 'en'], ['jpn', 'ja'], ['cmn', 'zh'], ['ar-EG', 'arb'], ['pt-BR', 'pt'], ['zh-TW', 'zh'], ['yue', 'yue'], ['swe', 'sv']])
    ('maps browser or ISO language %s to model ID %s', (input, canonical) => {
      expect(normalizeLanguageCode(input)).toBe(canonical);
      expect(createOmniVoiceRequest('Test', { ...voice, detectCode: input, omniVoice:{...voice.omniVoice,whisper:false} }).lang).toBe(canonical);
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
    expect(engine.synthesize.mock.calls.map(([params]) => params.numStep)).toEqual([24, 24]);
    const changed = { ...voice, omniVoice: { ...voice.omniVoice, variation: 4 } };
    await tts.generate('En annan röst.', { voice: changed });
    await tts.generate('Samma nya röst.', { voice: changed });
    expect(engine.synthesize.mock.calls.map(([params]) => params.numStep)).toEqual([24, 24, 24, 24]);
    await tts.dispose();
  });

  it('restarts after a failed voice change while retaining the requested voice', async () => {
    const engine = { init: vi.fn(), synthesize: vi.fn().mockResolvedValue({ ...audio, speaker: { anchorHash: 'speaker' } }),
      dispose: vi.fn(), abortGeneration: vi.fn() };
    const tts = createOmniVoiceTts({ loadRuntime: async () => engine });
    await tts.generate('Hej!', { voice });
    engine.synthesize.mockRejectedValueOnce(new Error('GPU failed during voice change'));
    await expect(tts.generate('Ny röst.', { voice: { ...voice, omniVoice: { ...voice.omniVoice, gender: 'female' } } })).resolves.toHaveProperty('sampling_rate', 24000);
    await tts.generate('Tillbaka.', { voice });
    expect(engine.synthesize.mock.calls.map(([params]) => params.numStep)).toEqual([24, 24, 24, 24]);
    expect(engine.synthesize.mock.calls.slice(1, 3).map(([params]) => params.speakerId)).toEqual(['female-1', 'female-1']);
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

  it('automatically retries the interrupted chunk on a fresh runtime after a GPU failure', async () => {
    const engine = { init: async () => {}, synthesize: vi.fn().mockRejectedValueOnce(new Error('GPU failed')).mockResolvedValue(audio), dispose: vi.fn(), abortGeneration: vi.fn() };
    const loadRuntime = vi.fn(async () => engine);
    const tts = createOmniVoiceTts({ loadRuntime });
    await expect(tts.generate('Hej!', { voice })).resolves.not.toHaveProperty('voiceRecovery');
    expect(loadRuntime).toHaveBeenCalledTimes(2);
    expect(engine.dispose).toHaveBeenCalledOnce();
    expect(engine.synthesize.mock.calls[0][0]).toEqual(engine.synthesize.mock.calls[1][0]);
    await expect(tts.generate('Hej!', { voice })).resolves.not.toHaveProperty('voiceRecovery');
    await tts.dispose();
  });

  it('clears failed initialization so preparation can be retried without reloading the extension', async () => {
    const broken = { init: vi.fn().mockRejectedValue(new Error('GPU unavailable')), terminate: vi.fn(), dispose: vi.fn() };
    const fresh = { init: vi.fn(), synthesize: vi.fn().mockResolvedValue(audio), dispose: vi.fn(), abortGeneration: vi.fn() };
    const loadRuntime = vi.fn().mockResolvedValueOnce(broken).mockResolvedValue(fresh);
    const tts = createOmniVoiceTts({ loadRuntime });
    await expect(tts.init()).rejects.toThrow('GPU unavailable');
    expect(broken.terminate).toHaveBeenCalledOnce();
    expect(broken.dispose).toHaveBeenCalledOnce();
    await expect(tts.init()).resolves.toBe(tts);
    await expect(tts.generate('Hej!', { voice })).resolves.toHaveProperty('sampling_rate', 24000);
    expect(loadRuntime).toHaveBeenCalledTimes(2);
    await tts.dispose();
  });

  it('recovers a runtime AbortError when the user has not cancelled', async () => {
    const engine = { init: vi.fn(), synthesize: vi.fn().mockRejectedValueOnce(new DOMException('GPU operation aborted', 'AbortError')).mockResolvedValue(audio),
      terminate: vi.fn(), dispose: vi.fn(), abortGeneration: vi.fn() };
    const loadRuntime = vi.fn(async () => engine);
    const tts = createOmniVoiceTts({ loadRuntime });
    await expect(tts.generate('Hej!', { voice })).resolves.toHaveProperty('sampling_rate', 24000);
    expect(loadRuntime).toHaveBeenCalledTimes(2);
    await tts.dispose();
  });

  it('stops after one crash recovery and leaves a fresh path for the next read', async () => {
    const broken = { init: vi.fn(), synthesize: vi.fn().mockRejectedValue(new Error('Device lost')), terminate: vi.fn(), dispose: vi.fn(), abortGeneration: vi.fn() };
    const fresh = { ...broken, synthesize: vi.fn().mockResolvedValue(audio) };
    const loadRuntime = vi.fn().mockResolvedValueOnce(broken).mockResolvedValueOnce(broken).mockResolvedValue(fresh);
    const tts = createOmniVoiceTts({ loadRuntime });
    await expect(tts.generate('Hej!', { voice })).rejects.toThrow('Device lost');
    expect(broken.synthesize).toHaveBeenCalledTimes(2);
    await expect(tts.generate('Nästa försök.', { voice })).resolves.toHaveProperty('sampling_rate', 24000);
    expect(loadRuntime).toHaveBeenCalledTimes(3);
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
    expect(onProgress).toHaveBeenCalledWith({ message: 'Audio check failed. Retrying with the same voice…' });
    expect(broken.synthesize).toHaveBeenLastCalledWith(expect.objectContaining({ seed: 42, numStep: 24 }));
    expect(recovered.synthesize).toHaveBeenLastCalledWith(expect.objectContaining({ seed: 43, speed: 1, numStep: 24 }));
    expect(recovered.synthesize).toHaveBeenLastCalledWith(expect.objectContaining({ speakerId:'male-1' }));
    await expect(tts.generate('Nästa mening.', { voice })).resolves.not.toHaveProperty('voiceRecovery');
    expect(recovered.synthesize).toHaveBeenLastCalledWith(expect.objectContaining({ seed: 42, numStep: 24, speakerId:'male-1' }));
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
