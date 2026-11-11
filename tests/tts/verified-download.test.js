import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { loadVerifiedFile } from '../../src/tts/verified-download.js';

const data = Uint8Array.from({ length: 8 }, (_, index) => index);
const file = { path: 'weights.bin', bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

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
  const cache = { match: async () => new Response(new ReadableStream({
    pull(stream) { controller.abort(); stream.enqueue(data); stream.close(); },
  }, { highWaterMark: 0 })), delete: vi.fn() };
  const fetcher = vi.fn();
  await expect(loadVerifiedFile('https://example.test/weights.bin', file, { label: 'Test', cache, fetcher, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  expect(cache.delete).not.toHaveBeenCalled();
  expect(fetcher).not.toHaveBeenCalled();
});

it('preserves cached data across a transient offline read stall', async () => {
  vi.useFakeTimers();
  const cache = { match: vi.fn().mockResolvedValueOnce(new Response(new ReadableStream({
    start(stream) { stream.enqueue(data.subarray(0, 4)); },
  }))).mockImplementation(async () => new Response(data)), delete: vi.fn(async () => true) };
  const read = () => loadVerifiedFile('https://example.test/weights.bin', file, { label: 'Test', cache, stallMs: 40 });
  const stalled = read().catch(error => error);
  await vi.advanceTimersByTimeAsync(40);
  expect(cache.delete).not.toHaveBeenCalled();
  expect(await stalled).toMatchObject({ name: 'TimeoutError' });
  await expect(read()).resolves.toEqual(data);
});

it('falls back to a verified network response after a cache read error without evicting the old entry', async () => {
  const error = new Error('Cache read failed');
  const cache = { match: async () => new Response(new ReadableStream({ start(stream) { stream.error(error); } })),
    delete: vi.fn(async () => true), put: vi.fn(async () => {}) };
  const onCacheError = vi.fn(), onCacheInvalid = vi.fn();
  await expect(loadVerifiedFile('https://example.test/weights.bin', file, { label: 'Test', cache,
    fetcher: async () => new Response(data), onCacheError, onCacheInvalid })).resolves.toEqual(data);
  expect(onCacheError).toHaveBeenCalledWith(error);
  expect(onCacheInvalid).not.toHaveBeenCalled();
  expect(cache.delete).not.toHaveBeenCalled();
  expect(cache.put).toHaveBeenCalledOnce();
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

const verificationChunks = { ...file, chunkBytes: 3, hashes: [data.subarray(0, 3), data.subarray(3, 6), data.subarray(6)]
  .map(part => createHash('sha256').update(part).digest('hex')) };

it('streams cached bytes into one buffer and checks every ordered chunk, including the partial tail', async () => {
  const digest = vi.spyOn(crypto.subtle, 'digest');
  const response = new Response(data), arrayBuffer = vi.spyOn(response, 'arrayBuffer');
  const cache = { match: async () => response };
  const result = await loadVerifiedFile('https://example.test/weights.bin', file, { label: 'Test', cache, verificationChunks });
  expect(result).toEqual(data); expect(arrayBuffer).not.toHaveBeenCalled();
  expect(digest.mock.calls.map(([, part]) => part.byteLength)).toEqual([3, 3, 2]);
  expect(digest.mock.calls.every(([, part]) => part.buffer === result.buffer)).toBe(true);
});

it.each([0, 2, 3, 5, 6, 7])('rejects corruption at byte %i before caching chunk-verified downloads', async index => {
  const corrupt = data.slice(); corrupt[index] ^= 1;
  const cache = { match: async () => null, put: vi.fn() };
  await expect(loadVerifiedFile('https://example.test/weights.bin', file, { label: 'Test', cache, verificationChunks,
    fetcher: async () => new Response(corrupt) })).rejects.toThrow('Test data hash mismatch');
  expect(cache.put).not.toHaveBeenCalled();
});

it('rejects reordered chunks and a missing partial tail', async () => {
  for (const bytes of [Uint8Array.from([...data.subarray(3, 6), ...data.subarray(0, 3), ...data.subarray(6)]), data.subarray(0, 6)]) {
    await expect(loadVerifiedFile('https://example.test/weights.bin', file, { label: 'Test', verificationChunks,
      fetcher: async () => new Response(bytes) })).rejects.toThrow(/data (hash mismatch|size)/);
  }
});

it.each([
  { path: 'different.bin' }, { bytes: 9 }, { sha256: '0'.repeat(64) }, { chunkBytes: 0 }, { chunkBytes: -1 },
  { chunkBytes: 1.5 }, { chunkBytes: NaN }, { hashes: [] }, { hashes: null }, { hashes: ['0'.repeat(64)] },
  { hashes: [...verificationChunks.hashes, file.sha256] }, { hashes: ['invalid', ...verificationChunks.hashes.slice(1)] },
])('rejects invalid chunk metadata before touching cached or network bytes: %j', async override => {
  const cache = { match: vi.fn() }, fetcher = vi.fn();
  await expect(loadVerifiedFile('https://example.test/weights.bin', file, { label: 'Test', cache, fetcher,
    verificationChunks: { ...verificationChunks, ...override } })).rejects.toThrow('Invalid Test verification chunks');
  expect(cache.match).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
});

it('replaces chunk-corrupt cached data with verified downloaded bytes', async () => {
  const corrupt = data.slice(); corrupt[3] ^= 1;
  const cache = { match: async () => new Response(corrupt), delete: vi.fn(async () => true), put: vi.fn(async () => {}) };
  await expect(loadVerifiedFile('https://example.test/weights.bin', file, { label: 'Test', cache, verificationChunks,
    fetcher: async () => new Response(data) })).resolves.toEqual(data);
  expect(cache.delete).toHaveBeenCalledOnce(); expect(cache.put).toHaveBeenCalledOnce();
});

it('honors cancellation between digest calls without evicting cached data', async () => {
  const controller = new AbortController(), originalDigest = crypto.subtle.digest.bind(crypto.subtle);
  const digest = vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (...args) => {
    const result = await originalDigest(...args); controller.abort(); return result;
  });
  const cache = { match: async () => new Response(data), delete: vi.fn(), put: vi.fn() };
  await expect(loadVerifiedFile('https://example.test/weights.bin', file, { label: 'Test', cache, verificationChunks,
    signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  expect(digest).toHaveBeenCalledOnce(); expect(cache.delete).not.toHaveBeenCalled(); expect(cache.put).not.toHaveBeenCalled();
});
