import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import omniVoiceCatalog from '../../src/tts/omnivoice/speaker-data.js';

describe('current release voice license readiness', () => {
  it('retains the license and attribution for recorded OmniVoice references', () => {
    const license = readFileSync(new URL('../../public/legal/CC-BY-4.0.txt', import.meta.url), 'utf8');
    const notice = readFileSync(new URL('../../public/legal/LibriTTS-R-NOTICE.txt', import.meta.url), 'utf8');
    const notices = readFileSync(new URL('../../public/legal/THIRD_PARTY_NOTICES.txt', import.meta.url), 'utf8');
    expect(license).toContain('Attribution 4.0 International');
    expect(notice).toContain('made available by Google LLC');
    expect(notice).toContain('Miipher');
    expect(notices).toContain('LibriTTS-R-NOTICE.txt');
    const fleursNotice = readFileSync(new URL('../../public/legal/FLEURS-NOTICE.txt', import.meta.url), 'utf8');
    expect(fleursNotice).toContain('Conneau');
    expect(fleursNotice).toContain('CC BY 4.0');
    const shareAlike = readFileSync(new URL('../../public/legal/CC-BY-SA-4.0.txt', import.meta.url), 'utf8');
    const jvnvNotice = readFileSync(new URL('../../public/legal/JVNV-NOTICE.txt', import.meta.url), 'utf8');
    const spiceNotice = readFileSync(new URL('../../public/legal/SpiCE-NOTICE.txt', import.meta.url), 'utf8');
    expect(shareAlike).toContain('Attribution-ShareAlike 4.0 International');
    expect(jvnvNotice).toContain('Detai Xin');
    expect(jvnvNotice).toContain('CC BY-SA 4.0');
    expect(spiceNotice).toContain('Khia A. Johnson');
    expect(spiceNotice).toContain('10.5683/SP2/MJOXP3');
    expect(notices).toContain('JVNV-NOTICE.txt');
    expect(notices).toContain('SpiCE-NOTICE.txt');
    for (const speaker of omniVoiceCatalog.speakers.filter(speaker => speaker.durationSource)) {
      expect(['LibriTTS-R', 'google/fleurs', 'SpiCE', 'JVNV']).toContain(speaker.source.dataset);
      expect(speaker.source.license).toBe(speaker.source.dataset === 'JVNV' ? 'CC-BY-SA-4.0' : 'CC-BY-4.0');
      if (speaker.source.dataset === 'LibriTTS-R') {
        expect(speaker.source.readerId).toBeTruthy();
        expect(speaker.source.recordingId).toBeTruthy();
        expect(speaker.source.url).toBe('https://www.openslr.org/141/');
      } else if (speaker.source.dataset === 'google/fleurs') {
        expect(speaker.source.revision).toBe('70bb2e84b976b7e960aa89f1c648e09c59f894dd');
        expect(speaker.source.config).toBeTruthy();
        expect(['dev', 'train', 'test']).toContain(speaker.source.split);
        expect(speaker.source.originalFile).toMatch(/^\d+\.wav$/u);
        expect(speaker.source.metadataSha256).toMatch(/^[a-f0-9]{64}$/u);
        expect(speaker.source.archiveSha256).toMatch(/^[a-f0-9]{64}$/u);
        expect(speaker.source.url).toBe('https://huggingface.co/datasets/google/fleurs');
      } else if (speaker.source.dataset === 'SpiCE') {
        expect(speaker.source.readerId).toBeTruthy();
        expect(speaker.source.revision).toBe('1.0');
        expect(speaker.source.url).toBe('https://doi.org/10.5683/SP2/MJOXP3');
        expect(speaker.source.originalAudioSha256).toMatch(/^[a-f0-9]{64}$/u);
        expect(speaker.source.annotationSha256).toMatch(/^[a-f0-9]{64}$/u);
        expect(speaker.source.endSample).toBeGreaterThan(speaker.source.startSample);
      } else if (speaker.source.dataset === 'JVNV') {
        expect(speaker.source.readerId).toMatch(/^[FM][12]$/u);
        expect(speaker.source.language).toBe('ja');
        expect(speaker.source.url).toBe('https://sites.google.com/site/shinnosuketakamichi/research-topics/jvnv_corpus');
        expect(speaker.source.archiveUrl).toBe('https://ss-takashi.sakura.ne.jp/corpus/jvnv/jvnv_ver1.zip');
        expect(speaker.source.archiveMember).toMatch(/^jvnv_v1\/.+\.wav$/u);
        expect(speaker.source.archiveMemberCrc32).toMatch(/^[a-f0-9]{8}$/u);
        for (const key of ['archiveIndexSha256', 'transcriptSha256', 'officialPageSha256']) expect(speaker.source[key]).toMatch(/^[a-f0-9]{64}$/u);
      }
      expect(speaker.source.audioSha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(speaker.source.encoderSha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(speaker.source.preprocessing).toBeTruthy();
    }
  });

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
