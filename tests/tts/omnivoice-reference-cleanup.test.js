import { afterEach, expect, it, vi } from 'vitest';
import { cleanOmniVoiceSample } from '../../src/tts/omnivoice/reference-cleanup.js';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function startCleanup() {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
    const timeout = new AbortController();
    setTimeout(() => timeout.abort(new DOMException('Timed out.', 'TimeoutError')), ms);
    return timeout.signal;
  });
  vi.stubGlobal('OfflineAudioContext', class {
    constructor(_channels, length) { this.length = length; }
    createBuffer() { return { copyToChannel() {} }; }
    createBufferSource() { return { connect() {}, start() {} }; }
    async startRendering() { return { getChannelData: () => new Float32Array(this.length).fill(0.1) }; }
  });
  const worker = { postMessage: vi.fn(), terminate: vi.fn() };
  vi.stubGlobal('Worker', class { constructor() { return worker; } });
  const controller = new AbortController();
  const result = cleanOmniVoiceSample(new Float32Array(72_000).fill(0.1), {
    signal: controller.signal, onProgress: vi.fn(), onProcessing: vi.fn(),
  }).then(pcm => ({ pcm }), error => ({ error }));
  const reply = data => worker.onmessage({ data });
  return { worker, controller, result, reply };
}

it('keeps cleaning when download progress spans more than three minutes', async () => {
  const { worker, result, reply } = startCleanup();
  for (let loaded = 1; loaded <= 8; loaded++) {
    await vi.advanceTimersByTimeAsync(25_000);
    reply({ progress: { loaded, total: 8 } });
  }
  reply({ processing: true });
  reply({ pcm: new Float32Array(72_000).fill(0.1) });
  expect((await result).pcm).toHaveLength(72_000);
  expect(worker.terminate).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it('bounds a stalled processing phase and terminates its worker', async () => {
  const { worker, result, reply } = startCleanup();
  await vi.advanceTimersByTimeAsync(60_000);
  reply({ processing: true });
  await vi.advanceTimersByTimeAsync(120_000);
  expect(worker.terminate).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(60_000);
  expect((await result).error).toMatchObject({ name: 'TimeoutError' });
  expect(worker.terminate).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it('clears the watchdog and terminates the worker when cleanup is cancelled', async () => {
  const { worker, controller, result } = startCleanup();
  await vi.advanceTimersByTimeAsync(0);
  controller.abort();
  expect((await result).error).toMatchObject({ name: 'AbortError' });
  expect(worker.terminate).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
