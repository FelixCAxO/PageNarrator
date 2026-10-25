import { describe, expect, it, vi } from 'vitest';
import { cacheKokoroVoiceStyle, getVoiceById } from '../../src/lib/voice-registry.js';

// Small deterministic fixture manifest; exercise the actual SHA-verifying loader.
vi.mock('../../src/tts/kokoro/model-data.js', async () => {
  const { createHash } = await import('node:crypto');
  return { KOKORO_DATA: { modelId: 'onnx-community/Kokoro-82M-v1.0-ONNX', revision: '1939ad2a8e416c0acfeecc08a694d14ef25f2231',
    files: ['am_michael', 'af_heart', 'bf_emma'].map(id => {
      const bytes = new Float32Array(510 * 256).fill(id === 'af_heart' ? 2 : 1);
      return { path: `voices/${id}.bin`, bytes: bytes.byteLength, sha256: createHash('sha256').update(new Uint8Array(bytes.buffer)).digest('hex') };
    }) } };
});

export function createMemoryCacheStorage() {
  const store = new Map();
  return {
    async open() {
      return { async match(url) { return store.get(url)?.clone(); },
        async put(url, response) { store.set(url, response.clone()); }, async delete(url) { return store.delete(url); } };
    },
    async firstValue(url) {
      const response = store.get(url)?.clone(); return response ? new Float32Array(await response.arrayBuffer())[0] : null;
    },
  };
}
const voiceResponse = (value = 1) => new Response(new Float32Array(510 * 256).fill(value));
const voice = getVoiceById('am_michael');

describe('hash-pinned on-demand Kokoro voice styles', () => {
  it('downloads only the selected immutable style, with no unversioned alias', async () => {
    const cacheStorage = createMemoryCacheStorage(), fetcher = vi.fn(async () => voiceResponse());
    await cacheKokoroVoiceStyle(voice, { cacheStorage, fetcher });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(voice.kokoroVoiceDownloadUrl, expect.objectContaining({ credentials: 'omit', signal: expect.any(AbortSignal) }));
    expect(voice.kokoroVoiceUrl).toBe(voice.kokoroVoiceDownloadUrl);
    expect(await cacheStorage.firstValue(voice.kokoroVoiceUrl)).toBe(1);
    expect(await cacheStorage.firstValue(voice.kokoroVoiceUrl.replace(/resolve\/[^/]+\//, 'resolve/main/'))).toBeNull();
  });
  it('ignores a poisoned legacy unversioned entry', async () => {
    const cacheStorage = createMemoryCacheStorage();
    const legacy = voice.kokoroVoiceUrl.replace(/resolve\/[^/]+\//, 'resolve/main/');
    await (await cacheStorage.open()).put(legacy, voiceResponse(9));
    await cacheKokoroVoiceStyle(voice, { cacheStorage, fetcher: async () => voiceResponse() });
    expect(await cacheStorage.firstValue(voice.kokoroVoiceUrl)).toBe(1);
    expect(await cacheStorage.firstValue(legacy)).toBe(9);
  });
  it('verifies persistent bytes again and works offline', async () => {
    const cacheStorage = createMemoryCacheStorage();
    await cacheKokoroVoiceStyle(voice, { cacheStorage, fetcher: async () => voiceResponse() });
    const fetcher = vi.fn(async () => { throw new TypeError('Offline'); });
    await cacheKokoroVoiceStyle(voice, { cacheStorage, fetcher }); expect(fetcher).not.toHaveBeenCalled();
  });
  it('keeps distinct pinned voices separate', async () => {
    const cacheStorage = createMemoryCacheStorage(), heart = getVoiceById('af_heart');
    await cacheKokoroVoiceStyle(heart, { cacheStorage, fetcher: async () => voiceResponse(2) });
    await cacheKokoroVoiceStyle(voice, { cacheStorage, fetcher: async () => voiceResponse() });
    expect(await cacheStorage.firstValue(heart.kokoroVoiceUrl)).toBe(2);
    expect(await cacheStorage.firstValue(voice.kokoroVoiceUrl)).toBe(1);
  });
  it('coalesces simultaneous preparation and reuses only reverified cache data later', async () => {
    const cacheStorage = createMemoryCacheStorage(), fetcher = vi.fn(async () => voiceResponse());
    await Promise.all([1, 2, 3].map(() => cacheKokoroVoiceStyle(voice, { cacheStorage, fetcher })));
    await cacheKokoroVoiceStyle(voice, { cacheStorage, fetcher }); expect(fetcher).toHaveBeenCalledTimes(1);
    await (await cacheStorage.open()).put(voice.kokoroVoiceUrl, voiceResponse(9));
    await cacheKokoroVoiceStyle(voice, { cacheStorage, fetcher }); expect(fetcher).toHaveBeenCalledTimes(2);
    expect(await cacheStorage.firstValue(voice.kokoroVoiceUrl)).toBe(1);
  });
  it('coalesces a new pinned download after eviction', async () => {
    const cacheStorage = createMemoryCacheStorage(), fetcher = vi.fn(async () => voiceResponse());
    await cacheKokoroVoiceStyle(voice, { cacheStorage, fetcher });
    await (await cacheStorage.open()).delete(voice.kokoroVoiceUrl);
    await Promise.all([1, 2, 3].map(() => cacheKokoroVoiceStyle(voice, { cacheStorage, fetcher })));
    expect(fetcher).toHaveBeenCalledTimes(2); expect(await cacheStorage.firstValue(voice.kokoroVoiceUrl)).toBe(1);
  });
  it('does not coalesce different browser stores', async () => {
    const fetcher = vi.fn(async () => voiceResponse());
    await Promise.all([createMemoryCacheStorage(), createMemoryCacheStorage()].map(cacheStorage => cacheKokoroVoiceStyle(voice, { cacheStorage, fetcher })));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it.each(['offline', 'http', 'partial', 'non-finite', 'finite-bit-flip', 'interrupted'])('rejects a %s download and permits a pinned retry', async failure => {
    const cacheStorage = createMemoryCacheStorage();
    const fetcher = async () => {
      if (failure === 'offline') throw new TypeError('Offline');
      if (failure === 'http') return new Response('Unavailable', { status: 503 });
      if (failure === 'partial') return new Response(new Uint8Array([1, 2, 3]));
      if (failure === 'non-finite') return voiceResponse(NaN);
      if (failure === 'finite-bit-flip') return voiceResponse(9);
      return { ok: true, arrayBuffer: async () => { throw new Error('Connection interrupted'); } };
    };
    await expect(cacheKokoroVoiceStyle(voice, { cacheStorage, fetcher })).rejects.toMatchObject({ code: 'voice_style_download_failed' });
    expect(await cacheStorage.firstValue(voice.kokoroVoiceUrl)).toBeNull();
    await cacheKokoroVoiceStyle(voice, { cacheStorage, fetcher: async () => voiceResponse() });
    expect(await cacheStorage.firstValue(voice.kokoroVoiceUrl)).toBe(1);
  });
  it('evicts corrupt pinned data offline and repairs it on retry', async () => {
    const cacheStorage = createMemoryCacheStorage();
    await (await cacheStorage.open()).put(voice.kokoroVoiceUrl, voiceResponse(9));
    await expect(cacheKokoroVoiceStyle(voice, { cacheStorage, fetcher: async () => { throw new TypeError('Offline'); } })).rejects.toMatchObject({ code: 'voice_style_download_failed' });
    expect(await cacheStorage.firstValue(voice.kokoroVoiceUrl)).toBeNull();
    await cacheKokoroVoiceStyle(voice, { cacheStorage, fetcher: async () => voiceResponse() });
    expect(await cacheStorage.firstValue(voice.kokoroVoiceUrl)).toBe(1);
  });
  it('does not report preparation success when browser storage is full', async () => {
    const cache = { match: async () => undefined, put: async () => { throw new Error('Quota exceeded'); } };
    await expect(cacheKokoroVoiceStyle(voice, { cacheStorage: { open: async () => cache }, fetcher: async () => voiceResponse() })).rejects.toMatchObject({
      code: 'voice_style_download_failed', cause: { message: 'Quota exceeded' },
    });
  });
});
