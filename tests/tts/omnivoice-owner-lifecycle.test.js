import { describe, expect, it, vi } from 'vitest';
import { createOmniVoiceTts } from '../../src/tts/omnivoice/tts.js';
import { createOmniVoiceWorker } from '../../src/tts/omnivoice/worker-client.js';

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

function setup({ runtimeReady = null, holdInit = false, holdDispose = false } = {}) {
  const initPosted = deferred(), disposePosted = deferred();
  const reply = (message) => worker.onmessage({ data: { id: message.id } });
  const worker = {
    postMessage: vi.fn(message => {
      if (message.method === 'init') {
        initPosted.resolve(message);
        if (!holdInit) queueMicrotask(() => reply(message));
      } else if (message.method === 'dispose') {
        disposePosted.resolve(message);
        if (!holdDispose) queueMicrotask(() => reply(message));
      }
    }),
    terminate: vi.fn(),
  };
  const createWorker = vi.fn(() => worker);
  const loadRuntime = vi.fn(async () => {
    if (runtimeReady) await runtimeReady;
    return createOmniVoiceWorker({ createWorker,
      runtime: { getURL: path => `chrome-extension://test/${path}` } });
  });
  const tts = createOmniVoiceTts({ loadRuntime });
  const methods = () => worker.postMessage.mock.calls.map(([message]) => message.method);
  return { tts, worker, createWorker, loadRuntime, initPosted, disposePosted, reply, methods };
}

describe('OmniVoice retired owner', () => {
  it('rejects init after disposal before the first worker can be constructed', async () => {
    const { tts, worker, createWorker, loadRuntime } = setup();
    await tts.dispose();
    await expect(tts.init()).rejects.toMatchObject({ name: 'AbortError', message: 'OmniVoice was released.' });
    await tts.dispose();
    expect(loadRuntime).not.toHaveBeenCalled();
    expect(createWorker).not.toHaveBeenCalled();
    expect(worker.postMessage).not.toHaveBeenCalled();
    expect(worker.terminate).not.toHaveBeenCalled();
  });

  it('rejects a cached init after the initialized worker has been closed once', async () => {
    const { tts, worker, createWorker, loadRuntime, methods } = setup();
    await tts.init();
    await tts.dispose();
    await expect(tts.init()).rejects.toMatchObject({ name: 'AbortError', message: 'OmniVoice was released.' });
    await tts.dispose();
    expect(loadRuntime).toHaveBeenCalledOnce();
    expect(createWorker).toHaveBeenCalledOnce();
    expect(methods()).toEqual(['init', 'abort', 'dispose']);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('closes a late worker without starting its cancelled model download', async () => {
    const runtimeReady = deferred();
    const { tts, worker, createWorker, loadRuntime, methods } = setup({
      runtimeReady: runtimeReady.promise, holdInit: true, holdDispose: true,
    });
    const initialized = tts.init();
    expect(tts.init()).toBe(initialized);
    const initialization = initialized.then(() => ({ resolved: true }), error => ({ error }));
    const disposed = tts.dispose();
    expect(tts.dispose()).toBe(disposed);
    let lateRejected = false;
    const late = tts.init().then(() => ({ resolved: true }), error => { lateRejected = true; return { error }; });
    await Promise.resolve();
    const rejectedBeforeRuntimeReady = lateRejected;
    expect(createWorker).not.toHaveBeenCalled();
    expect(worker.postMessage).not.toHaveBeenCalled();
    expect(worker.terminate).not.toHaveBeenCalled();

    runtimeReady.resolve();
    await disposed;
    expect((await initialization).error).toMatchObject({ name: 'AbortError' });
    expect((await late).error).toMatchObject({ name: 'AbortError' });
    expect(rejectedBeforeRuntimeReady).toBe(true);
    expect(loadRuntime).toHaveBeenCalledOnce();
    expect(createWorker).toHaveBeenCalledOnce();
    expect(worker.terminate).toHaveBeenCalledOnce();
    await tts.dispose();
    expect(methods()).toEqual([]);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
});
