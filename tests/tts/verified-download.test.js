import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { loadVerifiedFile } from '../../src/tts/verified-download.js';

const data = Uint8Array.from({ length: 8 }, (_, index) => index);
const file = { path: 'weights.bin', bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
afterEach(() => vi.useRealTimers());

/** Streams `pieces` with `gapMs` between them, then stops sending (without closing) when `stall` is set. */
function streamingFetch(pieces, { gapMs, stall = false }) {
  return async (_url, { signal }) => new Response(new ReadableStream({
    async start(controller) {
      for (const piece of pieces) {
        await delay(gapMs);
        if (signal.aborted) return;
        controller.enqueue(piece);
      }
      if (!stall) controller.close();
    },
  }));
}

it('finishes a download that runs longer than the stall timeout while bytes keep arriving', async () => {
  vi.useFakeTimers();
  const pieces = [data.slice(0, 2), data.slice(2, 4), data.slice(4, 6), data.slice(6)];
  const fetcher = streamingFetch(pieces, { gapMs: 15 });
  const loading = loadVerifiedFile('https://example.test/weights.bin', file, { label: 'Test', fetcher, stallMs: 40 });
  await vi.advanceTimersByTimeAsync(60);
  await expect(loading).resolves.toEqual(data);
});

it('cancels a download when no bytes arrive within the stall timeout', async () => {
  vi.useFakeTimers();
  const fetcher = streamingFetch([data.slice(0, 4)], { gapMs: 5, stall: true });
  const result = expect(loadVerifiedFile('https://example.test/weights.bin', file, { label: 'Test', fetcher, stallMs: 40 }))
    .rejects.toMatchObject({ name: 'TimeoutError', message: 'Test download stalled: weights.bin.' });
  await vi.advanceTimersByTimeAsync(45);
  await result;
});

it('cancels a partial body without caching it, then retries from verified bytes', async () => {
  const controller = new AbortController(), cancel = vi.fn();
  const cache = { match: vi.fn(async () => null), put: vi.fn(async () => {}) };
  const onProgress = vi.fn(), fetcher = vi.fn(async () => new Response(new ReadableStream({
    start(stream) { stream.enqueue(data.slice(0, 4)); }, cancel,
  })));
  const loading = loadVerifiedFile('https://example.test/weights.bin', file, { label: 'Test', cache, fetcher, onProgress, signal: controller.signal });
  await vi.waitFor(() => expect(onProgress).toHaveBeenCalledWith(4, 8));
  controller.abort();
  await expect(loading).rejects.toMatchObject({ name: 'AbortError' });
  expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
  expect(cancel).toHaveBeenCalledOnce();
  expect(cache.put).not.toHaveBeenCalled();
  await expect(loadVerifiedFile('https://example.test/weights.bin', file, { label: 'Test', cache, fetcher: async () => new Response(data) })).resolves.toEqual(data);
  expect(cache.put).toHaveBeenCalledOnce();
});

it('does not fetch for an already cancelled caller', async () => {
  const controller = new AbortController(), fetcher = vi.fn();
  controller.abort();
  await expect(loadVerifiedFile('https://example.test/weights.bin', file, { label: 'Test', fetcher, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  expect(fetcher).not.toHaveBeenCalled();
});

it('preserves a verified cached file when its caller cancels during cache reading', async () => {
  const controller = new AbortController();
  const cache = { match: async () => ({ ok: true, arrayBuffer: async () => { controller.abort(); return data.buffer; } }), delete: vi.fn() };
  const fetcher = vi.fn();
  await expect(loadVerifiedFile('https://example.test/weights.bin', file, { label: 'Test', cache, fetcher, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  expect(cache.delete).not.toHaveBeenCalled();
  expect(fetcher).not.toHaveBeenCalled();
});

it('rejects a body larger than the pinned size before it fills memory', async () => {
  const fetcher = async () => new Response(new Uint8Array(data.length + 1));
  await expect(loadVerifiedFile('https://example.test/weights.bin', file, { label: 'Test', fetcher })).rejects.toThrow('Invalid Test data size');
});

it('streams only verified bytes into the cache in bounded chunks', async () => {
  const data = new Uint8Array(2 * 1024 * 1024 + 17).fill(7);
  const file = { path: 'large.bin', bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
  const chunks = [];
  const cache = { match: async () => null, put: async (_url, response) => {
    const reader = response.body.getReader();
    for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); }
  } };
  const result = await loadVerifiedFile('https://example.test/large.bin', file, { label: 'Test', cache, fetcher: async () => new Response(data) });
  expect(Buffer.compare(result, data)).toBe(0); expect(chunks.map(c => c.length)).toEqual([1024 * 1024, 1024 * 1024, 17]);
  expect(createHash('sha256').update(Buffer.concat(chunks)).digest('hex')).toBe(file.sha256);
});
