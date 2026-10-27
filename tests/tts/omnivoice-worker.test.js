import { afterEach, expect, it, vi } from 'vitest';
import { createOmniVoiceWorker } from '../../src/tts/omnivoice/worker-client.js';

async function setup() {
  const worker = { postMessage: vi.fn(), terminate: vi.fn() };
  const onProgress = vi.fn();
  const engine = await createOmniVoiceWorker({ createWorker: () => worker,
    runtime: { getURL: path => `chrome-extension://test/${path}` }, onProgress });
  const reply = (id, result) => worker.onmessage({ data: { id, result } });
  return { engine, worker, onProgress, reply };
}

afterEach(() => vi.useRealTimers());

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
  await expect(request).rejects.toMatchObject({ name: 'OmniVoiceWorkerError', message: 'OmniVoice worker crashed.' });
  expect(worker.terminate).toHaveBeenCalledOnce();
});

it('keeps a crash message and rejects every outstanding request', async () => {
  const { engine, worker } = await setup();
  const loading = engine.init('model'), synthesis = engine.synthesize({});
  const failed = Promise.all([expect(loading).rejects.toThrow('GPU device lost'), expect(synthesis).rejects.toThrow('GPU device lost')]);
  const preventDefault = vi.fn();
  worker.onerror({ message: 'GPU device lost', preventDefault });
  await failed;
  expect(preventDefault).toHaveBeenCalledOnce();
  expect(worker.terminate).toHaveBeenCalledOnce();
});

it('closes a worker that cannot deserialize its response', async () => {
  const { engine, worker } = await setup();
  const loading = engine.init('model');
  worker.onmessageerror();
  await expect(loading).rejects.toMatchObject({ name: 'OmniVoiceWorkerError' });
  expect(worker.terminate).toHaveBeenCalledOnce();
});

it.each(['init', 'synthesize', 'dispose'])('bounds a hung %s request and clears its timers', async method => {
  vi.useFakeTimers();
  const { engine, worker } = await setup();
  const pending = engine[method]('model');
  const failed = expect(pending).rejects.toMatchObject({ name: 'OmniVoiceWorkerError', message: `OmniVoice ${method} timed out.` });
  await vi.advanceTimersByTimeAsync(method === 'dispose' ? 5_000 : 180_000);
  await failed;
  expect(worker.terminate).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it('terminates synthesis that ignores stop, allowing owner disposal to finish', async () => {
  vi.useFakeTimers();
  const { engine, worker } = await setup();
  const pending = engine.synthesize({});
  const failed = expect(pending).rejects.toThrow('did not stop');
  engine.abortGeneration();
  await vi.advanceTimersByTimeAsync(5_000);
  await failed;
  await engine.dispose();
  expect(worker.terminate).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it('clears the stop watchdog when cancelled synthesis replies normally', async () => {
  vi.useFakeTimers();
  const { engine, worker, reply } = await setup();
  const pending = engine.synthesize({});
  engine.abortGeneration(); reply(1);
  await pending;
  await vi.advanceTimersByTimeAsync(180_000);
  expect(worker.terminate).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it('allows a slow model download to continue while it reports progress', async () => {
  vi.useFakeTimers();
  const { engine, worker, reply } = await setup();
  const pending = engine.init('model');
  await vi.advanceTimersByTimeAsync(179_000);
  worker.onmessage({ data: { progress: { message: 'Downloading model…' } } });
  await vi.advanceTimersByTimeAsync(179_000);
  expect(worker.terminate).not.toHaveBeenCalled();
  reply(1); await pending;
  expect(vi.getTimerCount()).toBe(0);
});

it('terminates a cancelled model initialization without waiting for downloads', async () => {
  const { engine, worker } = await setup();
  const loading = engine.init('model');
  engine.terminate(); engine.terminate();
  await expect(loading).rejects.toMatchObject({ name: 'AbortError' });
  expect(worker.terminate).toHaveBeenCalledTimes(1);
  await engine.dispose();
});
