import { expect, it, vi } from 'vitest';
import { createOmniVoiceWorker } from '../../src/tts/omnivoice/worker-client.js';

async function setup() {
  const worker = { postMessage: vi.fn(), terminate: vi.fn() };
  const onProgress = vi.fn();
  const engine = await createOmniVoiceWorker({ createWorker: () => worker,
    runtime: { getURL: path => `chrome-extension://test/${path}` }, onProgress });
  const reply = (id, result) => worker.onmessage({ data: { id, result } });
  return { engine, worker, onProgress, reply };
}

it('routes progress, initialization and transferred PCM results by request ID', async () => {
  const { engine, worker, onProgress, reply } = await setup();
  const ready = engine.init('model');
  expect(worker.postMessage).toHaveBeenLastCalledWith({ id: 1, method: 'init', baseUrl: 'model', runtimeRoot: 'chrome-extension://test/' });
  worker.onmessage({ data: { progress: { message: 'Loading' } } });
  expect(onProgress).toHaveBeenCalledWith({ message: 'Loading' });
  reply(1);
  await ready;
  const request = { text: 'こんにちは', lang: 'ja', speed: 0.8 };
  const synthesized = engine.synthesize(request);
  expect(worker.postMessage).toHaveBeenLastCalledWith({ id: 2, method: 'synthesize', request });
  const result = { pcm: new Float32Array([0.1]), sampleRate: 24000 };
  reply(2, result);
  expect(await synthesized).toBe(result);
});

it('forwards runtime errors without losing their message', async () => {
  const { engine, worker } = await setup();
  const request = engine.synthesize({});
  worker.onmessage({ data: { id: 1, error: { name: 'RangeError', message: 'Invalid language' } } });
  await expect(request).rejects.toMatchObject({ name: 'RangeError', message: 'Invalid language' });
});

it('aborts generation and terminates the worker after session disposal', async () => {
  const { engine, worker, reply } = await setup();
  engine.abortGeneration();
  expect(worker.postMessage).toHaveBeenLastCalledWith({ method: 'abort' });
  const stopped = engine.dispose();
  expect(worker.terminate).not.toHaveBeenCalled();
  reply(1);
  await stopped;
  expect(worker.terminate).toHaveBeenCalledOnce();
  await engine.dispose();
  await expect(engine.synthesize({})).rejects.toThrow('closed');
});

it('rejects pending work and frees the worker when it crashes', async () => {
  const { engine, worker } = await setup();
  const request = engine.synthesize({});
  worker.onerror();
  await expect(request).rejects.toMatchObject({ name: 'AbortError' });
  expect(worker.terminate).toHaveBeenCalledOnce();
});

it('terminates a cancelled model initialization without waiting for downloads', async () => {
  const { engine, worker } = await setup();
  const loading = engine.init('model');
  engine.terminate(); engine.terminate();
  await expect(loading).rejects.toMatchObject({ name: 'AbortError' });
  expect(worker.terminate).toHaveBeenCalledTimes(1);
  await engine.dispose();
});
