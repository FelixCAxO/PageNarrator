import { makeLoader } from './voice-model.fixtures.js';
import { describe, expect, it, vi } from "vitest";
import { createVoiceModelLoader } from "../../src/lib/voice-model.js";

describe('voice-model loader', () => {
  it('caches the loaded model and skips re-loading on the next call', async () => {
    const loader = makeLoader(() => ({ tag: 'cached-tts' }));
    const ensure = createVoiceModelLoader({
      navigator: {},
      loadKokoro: loader.fn,
    });

    const first = await ensure();
    const second = await ensure();

    expect(first).toBe(second);
    expect(loader.calls).toHaveLength(1);
  });

  it('shares one in-flight model load across concurrent callers', async () => {
    let resolveModel;
    const modelReady = new Promise((resolve) => {
      resolveModel = resolve;
    });
    const loader = makeLoader(() => modelReady);
    const ensure = createVoiceModelLoader({
      navigator: {},
      loadKokoro: loader.fn,
    });

    const firstLoad = ensure();
    const secondLoad = ensure();
    resolveModel({ tag: 'shared-tts' });

    const [first, second] = await Promise.all([firstLoad, secondLoad]);

    expect(first).toBe(second);
    expect(first).toEqual({ tag: 'shared-tts' });
    expect(loader.calls).toHaveLength(1);
  });

  it('releases a cached model, disposes it, and reloads on the next call', async () => {
    const disposed = [];
    const loader = makeLoader((count) => ({
      tag: `tts-${count}`,
      async dispose() {
        disposed.push(count);
      },
    }));
    const ensure = createVoiceModelLoader({
      navigator: {},
      loadKokoro: loader.fn,
    });

    const first = await ensure();
    const released = await ensure.releaseVoiceModel();
    const second = await ensure();

    expect(released).toBe(true);
    expect(disposed).toEqual([1]);
    expect(second).not.toBe(first);
    expect(second).toEqual({ tag: 'tts-2', dispose: expect.any(Function) });
    expect(loader.calls).toHaveLength(2);
  });

  it('waits for cached-model disposal before loading a replacement', async () => {
    vi.useFakeTimers();
    try {
      let finishRelease;
      const releasing = new Promise((resolve) => { finishRelease = resolve; });
      const firstModel = { dispose: () => releasing };
      const replacementModel = {};
      const loadKokoro = vi.fn(async () => loadKokoro.mock.calls.length === 1 ? firstModel : replacementModel);
      const ensure = createVoiceModelLoader({ navigator: {}, loadKokoro });
      await ensure();
      const release = ensure.releaseVoiceModel();
      const replacement = ensure();

      await vi.advanceTimersByTimeAsync(0);
      const loadsBeforeDisposal = loadKokoro.mock.calls.length;
      finishRelease();

      await expect(release).resolves.toBe(true);
      await expect(replacement).resolves.toBe(replacementModel);
      expect(loadsBeforeDisposal).toBe(1);
      expect(loadKokoro).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not retain an in-flight model when release is requested before load resolves', async () => {
    const disposed = [];
    let resolveFirst;
    const firstLoad = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    const loader = makeLoader((count) => {
      if (count === 1) {
        return firstLoad;
      }
      return {
        tag: `tts-${count}`,
        async dispose() {
          disposed.push(`dispose-${count}`);
        },
      };
    });
    const ensure = createVoiceModelLoader({
      navigator: {},
      loadKokoro: loader.fn,
    });

    const onReady = vi.fn();
    const pending = ensure({ onReady });
    const released = await ensure.releaseVoiceModel();
    resolveFirst({
      tag: 'tts-1',
      async dispose() {
        disposed.push('dispose-1');
      },
    });

    await expect(pending).rejects.toMatchObject({ code: 'voice_model_released' });
    expect(released).toBe(true);
    expect(disposed).toEqual(['dispose-1']);
    expect(onReady).not.toHaveBeenCalled();

    const second = await ensure();
    expect(second).toMatchObject({ tag: 'tts-2' });
    expect(loader.calls).toHaveLength(2);
  });

  it('waits for a retired in-flight load and returns a fresh model to a restarted read', async () => {
    let finishLoad;
    const loading = new Promise((resolve) => { finishLoad = resolve; });
    const dispose = vi.fn();
    const retiredModel = { dispose };
    const restartedModel = {};
    const loadKokoro = vi.fn(async () => loadKokoro.mock.calls.length === 1 ? loading : restartedModel);
    const ensure = createVoiceModelLoader({ navigator: {}, loadKokoro });
    const pending = ensure();
    const retired = expect(pending).rejects.toMatchObject({ code: 'voice_model_released' });
    await ensure.releaseVoiceModel();
    const restarted = ensure();
    finishLoad(retiredModel);

    await retired;
    await expect(restarted).resolves.toBe(restartedModel);
    expect(dispose).toHaveBeenCalledOnce();
    expect(loadKokoro).toHaveBeenCalledTimes(2);
    expect(await ensure()).toBe(restartedModel);
  });

  it('releases nested Transformers model sessions when Kokoro wrapper disposal is a no-op', async () => {
    const calls = [];
    const loader = makeLoader(() => ({
      tag: 'wrapped-kokoro',
      async dispose() {
        calls.push('wrapper-dispose');
      },
      model: {
        sessions: {
          model: {
            handler: {
              async dispose() {
                calls.push('session-handler-dispose');
              },
            },
          },
        },
      },
      tokenizer: {
        async dispose() {
          calls.push('tokenizer-dispose');
        },
      },
    }));
    const ensure = createVoiceModelLoader({
      navigator: {},
      loadKokoro: loader.fn,
    });

    await ensure();
    await expect(ensure.releaseVoiceModel()).resolves.toBe(true);

    expect(calls).toEqual([
      'wrapper-dispose',
      'session-handler-dispose',
      'tokenizer-dispose',
    ]);
  });

  it('releases Map-backed nested model sessions during voice model eviction', async () => {
    const calls = [];
    const loader = makeLoader(() => ({
      tag: 'map-backed-kokoro',
      model: {
        sessions: new Map([
          ['encoder', {
            session: {
              async release() {
                calls.push('encoder-release');
              },
            },
          }],
          ['decoder', {
            async dispose() {
              calls.push('decoder-dispose');
            },
          }],
        ]),
      },
    }));
    const ensure = createVoiceModelLoader({
      navigator: {},
      loadKokoro: loader.fn,
    });

    await ensure();
    await expect(ensure.releaseVoiceModel()).resolves.toBe(true);

    expect(calls).toEqual(['encoder-release', 'decoder-dispose']);
  });

  it('reports a no-op release when no model is cached', async () => {
    const loader = makeLoader(() => ({ tag: 'unused' }));
    const ensure = createVoiceModelLoader({
      navigator: {},
      loadKokoro: loader.fn,
    });

    await expect(ensure.releaseVoiceModel()).resolves.toBe(false);
    expect(loader.calls).toHaveLength(0);
  });
});
