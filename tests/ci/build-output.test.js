import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EXPECTED_RUNTIME_ASSET_PATHS } from '../../build/runtime-assets.js';
import { KOKORO_NON_CC_VOICE_IDS } from '../../src/lib/voice-registry.js';

describe('Kokoro-only build output', () => {
  it('requires original engine artifacts and excludes retired voice runtimes', () => {
    expect(EXPECTED_RUNTIME_ASSET_PATHS.some((path) => /piper/i.test(path))).toBe(false);
    expect(existsSync(new URL('../../public/voice-packs/piper', import.meta.url))).toBe(false);
    expect(EXPECTED_RUNTIME_ASSET_PATHS.some(path => path.startsWith('onnx/'))).toBe(false);
    expect(EXPECTED_RUNTIME_ASSET_PATHS).toContain('native/kokoro-engine.wasm');
  });

  it('keeps extension pages isolated for browser compute', () => {
    const manifest = JSON.parse(readFileSync(new URL('../../manifest.json', import.meta.url), 'utf8'));
    expect(manifest.cross_origin_embedder_policy).toEqual({ value: 'credentialless' });
    expect(manifest.cross_origin_opener_policy).toEqual({ value: 'same-origin' });
  });

  it('publishes exactly the selected Kokoro catalog', () => {
    const manifest = JSON.parse(readFileSync(new URL('../../public/voice-packs/selected-manifest.json', import.meta.url), 'utf8'));
    expect(manifest.models.map((model) => model.id)).toEqual([...KOKORO_NON_CC_VOICE_IDS]);
    expect(JSON.stringify(manifest)).not.toMatch(/piper|browser|custom-voice/i);
  });
});
