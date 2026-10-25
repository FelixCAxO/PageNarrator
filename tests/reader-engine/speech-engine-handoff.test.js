import { expect, it, vi } from 'vitest';
import { createSpeechEngineHandoff } from '../../src/lib/speech-engine-handoff.js';

const settle = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture() {
  let index = 0;
  const model = { tts: {}, dispose: vi.fn(async () => {}) };
  const ready = deferred();
  const createPreload = vi.fn(() => Object.assign(Promise.resolve({ result: { preparedAudio: { cleanup: vi.fn() } } }), { cancel: vi.fn() }));
  const deps = { getCurrentIndex: () => index, getChunk: i => i < 10 ? { text: `Sentence ${i}` } : null,
    prepareModel: vi.fn(async () => model), prepareChunks: vi.fn(async () => {}), createPreload, readPreload: vi.fn(() => ready.promise),
    onError: vi.fn(), record: vi.fn() };
  return { ...deps, model, ready, controller: createSpeechEngineHandoff(deps), advance: n => { index = n; } };
}
const voice = { engine: 'omnivoice', id: 'female-en' };

it('warms one model and transfers only decoded audio for the exact unspoken boundary', async () => {
  const f = fixture(); f.controller.request(voice); f.controller.request(voice); await settle();
  expect(f.prepareModel).toHaveBeenCalledTimes(1);
  expect(f.createPreload.mock.calls[0][2]).toMatchObject({ sectionIndex: 2, tts: f.model.tts, forceComplete: true });
  expect(f.controller.take(2)).toBeNull();
  f.ready.resolve(); await settle();
  expect(f.controller.take(1)).toBeNull();
  expect(f.controller.take(2)).toMatchObject({ voice, model: f.model, index: 2 });
  expect(f.controller.take(2)).toBeNull();
  await f.controller.dispose(); expect(f.model.dispose).not.toHaveBeenCalled();
});

it('discards missed-boundary audio and primes a new future chunk without replaying text', async () => {
  const f = fixture(); f.controller.request(voice); await settle(); f.ready.resolve(); await settle();
  const old = f.createPreload.mock.results[0].value;
  f.advance(3); expect(f.controller.take(3)).toBeNull(); await settle();
  expect(old.cancel).toHaveBeenCalled();
  expect(f.createPreload.mock.calls[2][2].sectionIndex).toBe(5);
  expect(f.controller.take(3)).toBeNull(); expect(f.controller.take(5)?.index).toBe(5);
  await f.controller.dispose();
});

it('cancels setup and waits for its disposal before allocating a replacement', async () => {
  const f = fixture(), loading = deferred(); f.prepareModel.mockReturnValueOnce(loading.promise);
  f.controller.request(voice); await settle();
  f.controller.request({ ...voice, id: 'male-en' }); await settle();
  expect(f.prepareModel).toHaveBeenCalledTimes(1);
  loading.resolve(f.model); await settle();
  expect(f.model.dispose).toHaveBeenCalledTimes(1); expect(f.prepareModel).toHaveBeenCalledTimes(2);
  f.ready.resolve(); await f.controller.dispose();
});

it('reports initialization failure without taking the active engine or waiting forever', async () => {
  const f = fixture(), error = new Error('No GPU memory'); f.prepareModel.mockRejectedValueOnce(error);
  f.controller.request(voice); await settle();
  expect(f.onError).toHaveBeenCalledWith(error, voice); expect(f.controller.take(2)).toBeNull();
  await f.controller.dispose();
});

it('stop releases the incoming audio and model exactly once', async () => {
  const f = fixture(); f.controller.request(voice); await settle();
  f.ready.resolve(); await settle(); await f.controller.dispose(); await f.controller.dispose();
  expect(f.model.dispose).toHaveBeenCalledTimes(1);
  expect(f.createPreload.mock.results[0].value.cancel).toHaveBeenCalledTimes(1);
  expect(f.createPreload.mock.results[1].value.cancel).toHaveBeenCalledTimes(1);
});

it('keeps the old engine until the chunk after a short incoming chunk is also decoded', async () => {
  const f = fixture(), following = deferred();
  f.readPreload.mockReturnValueOnce(f.ready.promise).mockReturnValueOnce(following.promise);
  f.controller.request(voice); await settle();
  f.ready.resolve(); await settle();
  expect(f.controller.take(2)).toBeNull();
  following.resolve(); await settle();
  expect([...f.controller.take(2).preloads.keys()]).toEqual([2, 3]);
  await f.controller.dispose();
});

it('loads following streamed text before preparing the bounded incoming pair', async () => {
  let loaded = 2;
  const ready = deferred(), model = { tts: {}, dispose: vi.fn() }, createPreload = vi.fn(() => Promise.resolve({ result: {} }));
  const controller = createSpeechEngineHandoff({ getCurrentIndex: () => 0, getChunk: i => i <= loaded ? { text: `Sentence ${i}` } : null,
    prepareModel: async () => model, prepareChunks: async index => { await ready.promise; loaded = index; },
    createPreload, readPreload: preload => preload });
  controller.request(voice); await settle();
  expect(createPreload).not.toHaveBeenCalled(); expect(controller.take(2)).toBeNull();
  ready.resolve(); await settle();
  expect(createPreload.mock.calls.map(call => call[2].sectionIndex)).toEqual([2, 3]);
  expect(controller.take(2)?.preloads.size).toBe(2); await controller.dispose();
});

it('cancels an incoming model promptly while a shared text pull finishes without losing its chunk', async () => {
  const f = fixture(), text = deferred(), chunks = [];
  f.prepareChunks.mockReturnValueOnce(text.promise.then(chunk => { chunks.push(chunk); }));
  f.controller.request(voice); await settle();
  f.controller.request({ ...voice, id: 'male-en' }); await settle(); await settle();
  expect(f.model.dispose).toHaveBeenCalledTimes(1);
  expect(f.prepareModel).toHaveBeenCalledTimes(2);
  text.resolve('still-unspoken shared text'); f.ready.resolve(); await settle();
  expect(chunks).toEqual(['still-unspoken shared text']);
  await f.controller.dispose();
});
