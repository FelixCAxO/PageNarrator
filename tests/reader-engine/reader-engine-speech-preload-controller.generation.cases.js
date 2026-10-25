import { createController } from './reader-engine-speech-preload-controller.fixtures.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { clearSpeechPreloadState } from '../../src/lib/reader-engine-read-lifecycle.js';

describe('readerEngine speech preload controller', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('passes the complete OmniVoice design into generation and prepares its PCM for playback', async () => {
    const voice = { engine: 'omnivoice', id: 'omnivoice:sv:low', detectCode: 'sv',
      omniVoice: { gender: 'male', variation: 7, whisper: true } };
    const generate = vi.fn(async () => ({ audio: new Float32Array(2400).fill(0.1), sampling_rate: 24000 }));
    const controller = createController({ state: { tts: { generate } }, resolveSelectedVoice: () => voice });
    const entry = await controller.createSpeechPreloadForVoice(voice, { speech: 'Hej världen.' });
    expect(entry.error).toBeUndefined();
    expect(entry.engine).toBe('omnivoice');
    expect(entry.voiceId).toBe(voice.id);
    expect(entry.result.result.blob).toBeInstanceOf(Blob);
    expect(generate).toHaveBeenCalledExactlyOnceWith('Hej världen.', { voice, signal: expect.any(AbortSignal) });
  });

  it('keeps warmup reuse out of fresh hardware throughput calibration', async () => {
    const recordFirstSynthesis = vi.fn();
    const controller = createController({ state: {
      tts: { generate: async () => ({ audio: new Float32Array(24000), sampling_rate: 24000, fromWarmup: true }) },
      ttsPerformanceGovernor: { recordFirstSynthesis },
    } });
    const entry = await controller.createSpeechPreloadForVoice({ engine: 'kokoro', id: 'af_heart' }, { speech: 'Hello.' });
    expect(entry.error).toBeUndefined();
    expect(entry.result.result.fromWarmup).toBe(true);
    expect(recordFirstSynthesis).not.toHaveBeenCalled();
  });

  it.each(['discard', 'abort'])('releases a pending audio decode immediately on %s', async (reason) => {
    vi.useFakeTimers();
    const instances = [];
    class PendingAudio extends EventTarget {
      readyState = 0;
      pause = vi.fn();
      load = vi.fn();
      constructor(src) { super(); this.src = src; instances.push(this); }
      removeAttribute() { this.src = ''; }
    }
    const revoke = vi.fn();
    vi.stubGlobal('Audio', PendingAudio);
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:pending-decode', revokeObjectURL: revoke });
    const signal = new AbortController();
    const controller = createController({ state: { testSilentTtsEnabled: true } });
    const preload = controller.createSpeechPreloadForVoice(
      { engine: 'kokoro', id: 'af_heart' }, { speech: 'hello' }, { signal: signal.signal },
    );
    const entry = await preload;
    const speech = entry.result.result;
    expect(instances).toHaveLength(1);
    if (reason === 'abort') signal.abort();
    else clearSpeechPreloadState({ speechPreloads: new Map([[0, preload]]) });
    await Promise.resolve();
    await Promise.resolve();
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:pending-decode');
    expect(instances[0].src).toBe('');
    expect(vi.getTimerCount()).toBe(0);
    // A late browser readiness event must not restore the discarded resource.
    instances[0].dispatchEvent(new Event('canplay'));
    await speech.audioReady;
    expect(speech.preparedAudio).toBeUndefined();
    expect(revoke).toHaveBeenCalledTimes(1);
  });

  it('revokes the audio URL if constructing the decoder fails', async () => {
    const revoke = vi.fn();
    vi.stubGlobal('Audio', class { constructor() { throw new Error('decoder unavailable'); } });
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:failed-decoder', revokeObjectURL: revoke });
    const controller = createController({ state: { testSilentTtsEnabled: true } });
    const entry = await controller.createSpeechPreloadForVoice(
      { engine: 'kokoro', id: 'af_heart' }, { speech: 'hello' },
    );
    await expect(entry.result.result.audioReady).rejects.toThrow('decoder unavailable');
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:failed-decoder');
  });

  it('detaches the read abort listener when a preload fails', async () => {
    const run = new AbortController();
    const removeListener = vi.spyOn(run.signal, 'removeEventListener');
    const controller = createController({ state: { tts: { generate: async () => { throw new Error('inference failed'); } } } });
    const entry = await controller.createSpeechPreloadForVoice(
      { engine: 'kokoro', id: 'af_heart' }, { speech: 'hello' }, { signal: run.signal },
    );
    expect(entry.error.message).toBe('inference failed');
    expect(run.signal.aborted).toBe(false);
    expect(removeListener).toHaveBeenCalledExactlyOnceWith('abort', expect.any(Function));
  });

  it('uses the normalized selected Kokoro ID for English synthesis preloads', async () => {
    const calls = [];
    const controller = createController({
      state: {
        tts: {
          async generate(text, options) {
            calls.push({ text, options });
            return {
              audio: new Float32Array(2400),
              sampling_rate: 24000,
            };
          },
        },
        getSelectedVoiceId: () => 'kokoro-af-heart',
      },
      resolveSelectedVoice: () => ({ engine: 'kokoro', id: 'af_heart', detectCode: 'en' }),
    });

    const entry = await controller.createSpeechPreloadForVoice(
      { engine: 'kokoro', id: 'af_heart', detectCode: 'en' },
      { speech: 'English voice loading should use the normalized ID.' },
      { sectionIndex: 3 },
    );

    expect(entry.result.result.blob).toBeInstanceOf(Blob);
    expect(calls).toEqual([{
      text: 'English voice loading should use the normalized ID.',
      options: { voice: 'af_heart', signal: expect.any(AbortSignal) },
    }]);
  });

  it('uses the Kokoro voice passed to the preload window instead of re-resolving the default', async () => {
    const calls = [];
    const controller = createController({
      state: {
        tts: {
          async generate(text, options) {
            calls.push({ text, options });
            return {
              audio: new Float32Array(2400),
              sampling_rate: 24000,
            };
          },
        },
        getSelectedVoiceId: () => 'af_heart',
      },
      resolveSelectedVoice: () => ({ engine: 'kokoro', id: 'af_heart', detectCode: 'en' }),
    });

    const entry = await controller.createSpeechPreloadForVoice(
      { engine: 'kokoro', id: 'am_michael', detectCode: 'en' },
      { speech: 'The selected voice must survive the preload handoff.' },
      { sectionIndex: 4 },
    );

    expect(entry.result.result.blob).toBeInstanceOf(Blob);
    expect(calls).toEqual([{
      text: 'The selected voice must survive the preload handoff.',
      options: { voice: 'am_michael', signal: expect.any(AbortSignal) },
    }]);
  });

  it('uses direct generation for complete Kokoro chunks instead of probing the stream path', async () => {
    const generate = vi.fn(async () => ({
      audio: new Float32Array(120000),
      sampling_rate: 24000,
    }));
    const stream = vi.fn();
    const controller = createController({
      state: {
        tts: {
          stream,
          generate,
        },
        getSelectedVoiceId: () => 'af_heart',
      },
      getActiveTtsProfileConfig: () => ({
        profile: 'balanced',
        preloadAhead: 1,
        progressiveSegments: false,
        speechPreloadTimeoutMs: 60_000,
      }),
      resolveSelectedVoice: () => ({ engine: 'kokoro', id: 'af_heart', detectCode: 'en' }),
    });

    const preload = controller.createSpeechPreloadForVoice(
      { engine: 'kokoro', id: 'af_heart', detectCode: 'en' },
      { speech: 'Complete chunks should go straight to Kokoro generation.' },
    );

    await preload;
    expect(stream).not.toHaveBeenCalled();
    expect(generate).toHaveBeenCalledTimes(1);
    expect(await preload).toMatchObject({
      result: expect.objectContaining({
        kind: 'chunk',
      }),
    });
  });
});
