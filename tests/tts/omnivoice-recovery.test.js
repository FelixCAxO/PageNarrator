import { afterEach, expect, it, vi } from 'vitest';
import { createOmniVoiceTts } from '../../src/tts/omnivoice/tts.js';
import { createOmniVoiceWorker } from '../../src/tts/omnivoice/worker-client.js';

const voice = { detectCode: 'sv', omniVoice: { gender: 'female', variation: 4 } };
const audio = { pcm: Float32Array.of(.1, -.1), sampleRate: 24000 };
afterEach(() => vi.useRealTimers());

function setup({ crashInit = false, hang = false } = {}) {
  const workers = [];
  const loadRuntime = () => createOmniVoiceWorker({ runtime: { getURL: path => `chrome-extension://test/${path}` },
    createWorker() {
      const number = workers.length;
      const worker = { terminate: vi.fn(), postMessage: vi.fn(message => {
        queueMicrotask(() => {
          if (message.method === 'abort') return;
          if (message.method === 'synthesize' && hang) return;
          if (number === 0 && message.method === (crashInit ? 'init' : 'synthesize')) {
            worker.onerror({ message: 'GPU device lost', preventDefault: vi.fn() }); return;
          }
          worker.onmessage({ data: { id: message.id, result: message.method === 'synthesize' ? audio : undefined } });
        });
      }) };
      workers.push(worker); return worker;
    },
  });
  return { workers, tts: createOmniVoiceTts({ loadRuntime }) };
}

it.each([false, true])('recovers an actual worker error during init=%s with a new worker and the same Swedish request', async crashInit => {
  const { tts, workers } = setup({ crashInit });
  await expect(tts.generate('Nu läser vi på svenska.', { voice })).resolves.toMatchObject({ sampling_rate: 24000 });
  expect(workers).toHaveLength(2);
  expect(workers[0].terminate).toHaveBeenCalledOnce();
  const calls = workers.flatMap(worker => worker.postMessage.mock.calls.map(([message]) => message)).filter(message => message.method === 'synthesize');
  expect(calls).toHaveLength(crashInit ? 1 : 2);
  for (const call of calls) expect(call.request).toMatchObject({ lang: 'sv', seed: 45, speakerId: 'female-4' });
  await tts.dispose();
  expect(workers[1].terminate).toHaveBeenCalledOnce();
});

it('can stop and dispose a worker that ignores cancellation without starting another worker', async () => {
  vi.useFakeTimers();
  const { tts, workers } = setup({ hang: true });
  const controller = new AbortController();
  const pending = tts.generate('Nu läser vi på svenska.', { voice, signal: controller.signal });
  const stopped = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await vi.advanceTimersByTimeAsync(0);
  expect(workers[0].postMessage.mock.calls.some(([message]) => message.method === 'synthesize')).toBe(true);
  controller.abort();
  const disposal = tts.dispose();
  await vi.advanceTimersByTimeAsync(5_000);
  await stopped; await disposal;
  expect(workers).toHaveLength(1);
  expect(workers[0].terminate).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
