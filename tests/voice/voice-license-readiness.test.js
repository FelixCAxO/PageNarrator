import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('current release voice license readiness', () => {
  it('uses the new licensed OmniVoice bridge and excludes the former vendored executable', () => {
    const adapter = readFileSync(new URL('../../src/tts/omnivoice/tts.js', import.meta.url), 'utf8');
    const worker = readFileSync(new URL('../../src/tts/omnivoice/worker.js', import.meta.url), 'utf8');
    const loader = readFileSync(new URL('../../src/tts/omnivoice/loader.js', import.meta.url), 'utf8');
    const bridge = readFileSync(new URL('../../src/tts/omnivoice/runtime.js', import.meta.url), 'utf8');
    const notices = readFileSync(new URL('../../public/legal/THIRD_PARTY_NOTICES.txt', import.meta.url), 'utf8');
    expect(adapter).toContain("import { createOmniVoiceWorker } from './worker-client.js'");
    expect(worker).toContain("import { loadBundledRuntime } from './loader.js'");
    expect(loader).toContain("import('./runtime.js')");
    expect(existsSync(new URL('../../vendor/omnivoice/runtime.js', import.meta.url))).toBe(false);
    expect(bridge).toContain('Licensed under GPL-3.0-or-later');
    expect(notices).toContain('Copyright 2026 Xiaomi Corp. (Han Zhu)');
    expect(notices).not.toContain('permission unresolved');
    expect(notices).not.toContain('omnivoice-vulkan-bridge');
  });

  it('documents the Kokoro Apache license and release scope', () => {
    const doc = readFileSync(new URL('../../docs/third-party-voice-licenses.md', import.meta.url), 'utf8');
    const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    expect(doc).toContain(`PageNarrator ${version}`);
    expect(doc).toContain('Missing model data downloads from Hugging Face');
    expect(doc).toContain('Apache-2.0');
    expect(doc).toContain('ten English voices');
  });

  it('ships the GPL project license and retains third-party notices', () => {
    const projectLicense = readFileSync(new URL('../../LICENSE', import.meta.url), 'utf8');
    const packagedProjectLicense = readFileSync(new URL('../../public/legal/GPL-3.0.txt', import.meta.url), 'utf8');
    const license = readFileSync(new URL('../../public/legal/Apache-2.0.txt', import.meta.url), 'utf8');
    const notices = readFileSync(new URL('../../public/legal/THIRD_PARTY_NOTICES.txt', import.meta.url), 'utf8');
    const metadata = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    expect(metadata.license).toBe('GPL-3.0-or-later');
    expect(projectLicense).toContain('GNU GENERAL PUBLIC LICENSE');
    expect(projectLicense).toContain('Version 3, 29 June 2007');
    expect(notices).toContain('Copyright (c) 2026 Felix Olsson');
    expect(existsSync(new URL('../../public/legal/MIT.txt', import.meta.url))).toBe(false);
    expect(packagedProjectLicense).toBe(projectLicense);
    expect(license).toContain('Apache License');
    expect(license).toContain('Version 2.0, January 2004');
    expect(notices).toContain('Kokoro-82M');
    expect(notices).toContain('Apache License 2.0');
    expect(notices).not.toContain('@mozilla/readability');
    expect(notices).toContain('CMUdict');
    expect(notices).toContain('GPL-3.0-only');
    expect(notices).toContain('Adobe glyph-name');
    expect(notices).toContain('Unicode 3.2');
    expect(notices).not.toContain('assets/transformers.web.js file is modified from upstream');
    expect(notices).not.toContain('The bundled Tesseract worker');
    expect(notices).not.toContain('Packaged separately under onnx/omnivoice/');
    expect(notices).not.toMatch(/Chatterbox runtime|Swedish Kokoro pronunciation adapter|MOSS-TTS v1.5|Custom voices are supplied/);
  });
});
