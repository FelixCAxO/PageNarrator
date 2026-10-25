import { expect, it, vi } from 'vitest';
import { configureOnnxRuntime, ensureVoiceModel, releaseVoiceModel } from '../../src/lib/voice-registry.js';
import { createKokoroWorkerBackend } from '../../src/tts/kokoro/worker-client.js';

vi.mock('../../src/tts/kokoro/worker-client.js', () => ({ createKokoroWorkerBackend: vi.fn() }));

it('loads the original phase-corrected worker through the real registry and preserves reusable app disposal', async () => {
  const base = { prepareVoice: vi.fn(async () => {}), generate: vi.fn(async () => ({ audio: Float32Array.of(.1), sampling_rate: 24000 })),
    modelInfo: { version: 'kokoro-exact-zero-phase-v2' }, dispose: vi.fn() };
  createKokoroWorkerBackend.mockResolvedValue(base);
  await configureOnnxRuntime();
  expect(createKokoroWorkerBackend).not.toHaveBeenCalled();
  const tts = await ensureVoiceModel({ backendPlan: { device: 'wasm', dtype: 'q8' } });
  expect(createKokoroWorkerBackend).toHaveBeenCalledExactlyOnceWith('onnx-community/Kokoro-82M-v1.0-ONNX',
    expect.objectContaining({ device: 'wasm', dtype: 'q8', phaseCorrection: true }));
  expect(tts.modelInfo.version).toBe('kokoro-exact-zero-phase-v2');
  await tts.generate('Hello.', { voice: 'af_heart' });
  expect(base.prepareVoice).toHaveBeenCalledWith('af_heart');
  expect(await ensureVoiceModel()).toBe(tts);
  expect(await releaseVoiceModel()).toBe(true);
  expect(await releaseVoiceModel()).toBe(false); expect(base.dispose).toHaveBeenCalledOnce();
});
