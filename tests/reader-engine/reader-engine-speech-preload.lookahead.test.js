import { expect, it, vi } from 'vitest';
import { createController } from './reader-engine-speech-preload-controller.fixtures.js';

it.each([
  { id: 'omnivoice:en', engine: 'omnivoice', device: 'webgpu' },
  { id: 'af_heart', engine: 'kokoro', device: 'wasm' },
])('fills upcoming $engine chunks serially on $device and reuses them as playback advances', async ({ id, engine, device }) => {
  const voice = { id, engine, detectCode: 'en' };
  const chunks = Array.from({ length: 6 }, (_, index) => ({ speech: `Read section ${index}.` }));
  const releases = [];
  const generate = vi.fn(() => new Promise(resolve => { releases.push(() => resolve({ audio: new Float32Array(120000), sampling_rate: 24000 })); }));
  const controller = createController({ state: { activeChunks: chunks, tts: { generate } },
    getSynthesisBackend: () => device,
    getActiveTtsProfileConfig: () => ({ preloadAhead: 4, progressiveSegments: false, speechPreloadTimeoutMs: 60000 }),
    prepareGeneratedAudioForPlayback: async () => ({ readyState: 3 }),
  });
  const speechPreloads = new Map(), preloadState = {}, queuedHighlightIndices = new Set();
  const fill = currentIndex => controller.ensureSpeechPreloadWindow({
    speechPreloads, preloadState, queuedHighlightIndices, currentIndex, selectedVoice: voice,
  });
  try {
    fill(0); fill(0); fill(0);
    expect(generate).toHaveBeenCalledTimes(1);
    expect([...speechPreloads.keys()]).toEqual([0]);
    for (let index = 0; index < 5; index++) {
      await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(index + 1));
      releases[index]();
      await controller.readPreloadedSpeech(speechPreloads.get(index));
    }
    expect(generate.mock.calls.map(([text]) => text)).toEqual(chunks.slice(0, 5).map(chunk => chunk.speech));
    const cached = speechPreloads.get(1);
    fill(1); fill(1);
    expect(speechPreloads.get(1)).toBe(cached);
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(6));
    releases[5]();
    await controller.readPreloadedSpeech(speechPreloads.get(5));
    expect(generate.mock.calls.map(([text]) => text)).toEqual(chunks.map(chunk => chunk.speech));
    expect(preloadState.inFlightCount).toBeLessThanOrEqual(1);
  } finally { releases.forEach(release => release()); }
});
