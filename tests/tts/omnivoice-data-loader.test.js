import { expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createOmniVoiceDataFetch } from '../../src/tts/omnivoice/data-loader.js';
import { OMNIVOICE_DATA } from '../../src/tts/omnivoice/model-data.js';
import pinned from '../fixtures/browser-speech-models.json';

const data = new TextEncoder().encode('{"ok":1}');
const manifest = { modelId: 'fixture', revision: 'pinned', files: [{ path: 'weights.bin', bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') }] };
const url = 'https://huggingface.co/fixture/resolve/pinned/weights.bin';

it('keeps production model bytes identical to the frozen independent evaluation fixture', () => {
  expect(OMNIVOICE_DATA.files).toEqual(pinned.files);
  expect(OMNIVOICE_DATA.revision).toBe(pinned.revision);
});

it('rejects executable or unpinned URLs before network and coalesces concurrent data requests', async () => {
  const fetcher = vi.fn(async () => new Response(data));
  const load = createOmniVoiceDataFetch({ manifest, fetcher, cacheStorage: null });
  await expect(load(url.replace('weights.bin', 'runtime.js'))).rejects.toThrow(/Unexpected/);
  const [first, second] = await Promise.all([load(url), load(url)]);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(await first.arrayBuffer()).toBe(await second.arrayBuffer());
  expect(await first.json()).toEqual({ ok: 1 });
});

it('deletes a corrupt cached payload and verifies its single replacement before caching it', async () => {
  const corrupt = Uint8Array.from(data, byte => byte ^ 1), cache = { match: vi.fn(async () => new Response(corrupt)), delete: vi.fn(async () => true), put: vi.fn(async () => {}) };
  const fetcher = vi.fn(async () => new Response(data));
  const load = createOmniVoiceDataFetch({ manifest, fetcher, cacheStorage: { open: async () => cache } });
  expect(new Uint8Array(await (await load(url)).arrayBuffer())).toEqual(data);
  expect(cache.delete).toHaveBeenCalledWith(url); expect(cache.put).toHaveBeenCalledTimes(1);
});

it('uses verified cached data offline and retries a failed download instead of caching corruption', async () => {
  const cached = createOmniVoiceDataFetch({ manifest, fetcher: null, cacheStorage: { open: async () => ({ match: async () => new Response(data) }) } });
  expect(await (await cached(url)).json()).toEqual({ ok: 1 });
  const put = vi.fn(async () => {}), fetcher = vi.fn().mockResolvedValueOnce(new Response(new Uint8Array(data.length))).mockResolvedValueOnce(new Response(data));
  const load = createOmniVoiceDataFetch({ manifest, fetcher, cacheStorage: { open: async () => ({ match: async () => null, put }) } });
  await expect(load(url)).rejects.toThrow(/hash mismatch/); expect(put).not.toHaveBeenCalled();
  expect(await (await load(url)).json()).toEqual({ ok: 1 }); expect(fetcher).toHaveBeenCalledTimes(2);
});
