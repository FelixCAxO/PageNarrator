import { describe, expect, it } from 'vitest';
import { REQUIRED_RELEASE_FILES } from '../../scripts/assert-release-package.mjs';
import { KOKORO_MODEL_REVISION, getVoiceOptions } from '../../src/lib/voice-registry.js';

describe('on-demand built-in voice data', () => {
  it('keeps all ten Kokoro voices selectable with revision-pinned data URLs', () => {
    const voices = getVoiceOptions();
    expect(voices).toHaveLength(10);
    expect(KOKORO_MODEL_REVISION).toMatch(/^[a-f0-9]{40}$/);
    for (const voice of voices) {
      expect(voice).toMatchObject({ engine: 'kokoro', status: 'on-demand' });
      expect(voice.kokoroVoiceDownloadUrl).toBe(`https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/${KOKORO_MODEL_REVISION}/voices/${voice.id}.bin`);
      expect(voice.localKokoroVoicePath).toBeUndefined();
    }
  });

  it('requires only voice catalog metadata and local runtimes in the release', () => {
    expect(REQUIRED_RELEASE_FILES.filter((path) => path.startsWith('voice-packs/')))
      .toEqual(['voice-packs/selected-manifest.json']);
    expect(REQUIRED_RELEASE_FILES).toContain('native/kokoro-engine.wasm');
    expect(REQUIRED_RELEASE_FILES).toContain('assets/phonemizer/english.wasm');
    expect(REQUIRED_RELEASE_FILES.some(path => path.startsWith('onnx/'))).toBe(false);
    expect(REQUIRED_RELEASE_FILES.some((path) => /piper/i.test(path))).toBe(false);
  });
});
