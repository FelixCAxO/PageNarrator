import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  getVoiceOptions,
  prepareKokoroModelLoad,
} from '../../src/lib/voice-registry.js';

const ROOT_DIR = fileURLToPath(new URL('../..', import.meta.url));

describe('voice registry consolidation', () => {
  it('exports defaults and lifecycle helpers from the voice registry boundary', async () => {
    const registry = await import('../../src/lib/voice-registry.js');

    for (const exportName of [
      'configureOnnxRuntime',
      'createVoiceModelBackendPlan',
      'ensureVoiceModel',
      'releaseVoiceModel',
      'VOICE_MODEL_IDLE_RELEASE_DELAY_MS',
      'createInFlightActivityTracker',
      'createVoiceModelIdleReleaseController',
      'prepareKokoroModelLoad',
    ]) {
      expect(registry[exportName], exportName).toBeTypeOf(exportName === 'VOICE_MODEL_IDLE_RELEASE_DELAY_MS' ? 'number' : 'function');
    }
  });

  it('prepares only the pinned model and leaves tokenizer ownership to its worker', async () => {
    await expect(prepareKokoroModelLoad('onnx-community/Kokoro-82M-v1.0-ONNX')).resolves.toBeUndefined();
    await expect(prepareKokoroModelLoad('unknown/model')).rejects.toThrow('Unsupported Kokoro model');
  });

  it('removes the split voice defaults and lifecycle modules from src/lib', () => {
    for (const legacyFile of [
      'src/lib/voice-model-defaults.js',
      'src/lib/voice-model-lifecycle.js',
    ]) {
      expect(existsSync(join(ROOT_DIR, legacyFile)), legacyFile).toBe(false);
    }
  });

  it('keeps Kokoro as the only voice engine', () => {
    expect(getVoiceOptions()).toHaveLength(10);
    expect(getVoiceOptions().every((voice) => voice.engine === 'kokoro')).toBe(true);
  });
});
