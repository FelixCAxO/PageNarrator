import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OMNIVOICE_DATA } from '../../src/tts/omnivoice/model-data.js';
import { OMNIVOICE_ENCODER_DATA } from '../../src/tts/omnivoice/reference-encoder.js';
import omniVoiceCatalog from '../../src/tts/omnivoice/speaker-data.js';
import { getOmniVoiceVoiceId } from '../../src/tts/omnivoice/voice-id.js';
import voiceScores from '../../tooling/config/omnivoice-voice-scores.json';

describe('current release voice license readiness', () => {
  it('attributes the pinned OmniVoice export and states the upstream weight terms', () => {
    const notices = readFileSync(new URL('../../extension/public/legal/THIRD_PARTY_NOTICES.txt', import.meta.url), 'utf8');
    const modelNotice = notices.split('On-demand voice models')[1].split('Kokoro-82M')[0];
    expect(modelNotice).toContain(`https://huggingface.co/${OMNIVOICE_DATA.modelId}`);
    expect(modelNotice).toContain(OMNIVOICE_DATA.revision);
    expect(modelNotice).toContain('https://huggingface.co/k2-fsa/OmniVoice#license');
    expect(modelNotice).toMatch(/Pretrained weights: CC BY-NC/u);
    expect(modelNotice).toContain('Built with Higgs Materials licensed from Boson AI USA, Inc.');
    expect(readFileSync(new URL('../../extension/public/legal/Boson-Higgs-Audio-2-LICENSE.txt', import.meta.url), 'utf8'))
      .toContain('BOSON HIGGS AUDIO 2 COMMUNITY LICENSE AGREEMENT');
    expect(readFileSync(new URL('../../extension/public/legal/Meta-Llama-3-LICENSE.txt', import.meta.url), 'utf8'))
      .toContain('META LLAMA 3 COMMUNITY LICENSE AGREEMENT');
  });

  it('keeps attribution and generation details for every OmniVoice card', () => {
    const hash = expect.stringMatching(/^[a-f0-9]{64}$/u);
    expect(omniVoiceCatalog.speakers).toHaveLength(831);
    for (const speaker of omniVoiceCatalog.speakers) {
      expect(speaker.source, speaker.id).toMatchObject({
        kind: 'recording-derived',
        dataset: expect.any(String),
        license: expect.stringMatching(/^(?:CC0-1\.0|CC-BY-4\.0|CC-BY-SA-4\.0|Apache-2\.0)$/u),
        attribution: expect.any(String),
        url: expect.stringMatching(/^https:\/\//u),
        audioSha256: hash,
        encoderSha256: OMNIVOICE_ENCODER_DATA.sha256,
        parentReferenceHash: hash,
        parentStableVoiceId: getOmniVoiceVoiceId(speaker),
        generation: {
          modelRevision: OMNIVOICE_DATA.revision,
          lang: speaker.lang,
          nativeGeneratedCodes: true,
          generatedAudioSha256: hash,
        },
      });
    }
  });

  it('binds every voice score to the shipped card', () => {
    expect(Object.keys(voiceScores.voices)).toHaveLength(831);
    for (const speaker of omniVoiceCatalog.speakers) {
      const score = voiceScores.voices[getOmniVoiceVoiceId(speaker)];
      expect(score.hash).toBe(speaker.hash);
      expect(score.similarity).toBeGreaterThanOrEqual(-1);
      expect(score.similarity).toBeLessThanOrEqual(1);
      for (const quality of [score.originalQuality, score.newQuality]) {
        expect(Number.isFinite(quality)).toBe(true);
        expect(quality).toBeGreaterThan(0);
        expect(quality).toBeLessThanOrEqual(5);
      }
      expect(Array.isArray(score.reviewFlags)).toBe(true);
    }
  });

  it('pins the restored Common Voice references to the archived 17.0 distribution', () => {
    const references = omniVoiceCatalog.speakers.filter(speaker => speaker.source?.dataset === 'mozilla/common_voice_17_0');
    expect(references).toHaveLength(490);
    for (const speaker of references) {
      expect(speaker.source, speaker.id).toMatchObject({
        revision: '8262c16bf297c87a9cd88c51997c4758ed7a8ba2',
        license: 'CC0-1.0',
      });
    }
    const notice = readFileSync(new URL('../../extension/public/legal/CommonVoice-NOTICE.txt', import.meta.url), 'utf8');
    expect(notice).toContain('Mozilla Common Voice Corpus 17.0');
    expect(notice).toContain('8262c16bf297c87a9cd88c51997c4758ed7a8ba2');
  });

  it('uses the new licensed OmniVoice bridge and excludes the former vendored executable', () => {
    const adapter = readFileSync(new URL('../../src/tts/omnivoice/tts.js', import.meta.url), 'utf8');
    const worker = readFileSync(new URL('../../src/tts/omnivoice/worker.js', import.meta.url), 'utf8');
    const loader = readFileSync(new URL('../../src/tts/omnivoice/loader.js', import.meta.url), 'utf8');
    const bridge = readFileSync(new URL('../../src/tts/omnivoice/runtime.js', import.meta.url), 'utf8');
    const notices = readFileSync(new URL('../../extension/public/legal/THIRD_PARTY_NOTICES.txt', import.meta.url), 'utf8');
    expect(adapter).toContain("import { createOmniVoiceWorker } from './worker-client.js'");
    expect(worker).toContain("import { loadBundledRuntime } from './loader.js'");
    expect(loader).toContain("import('./runtime.js')");
    expect(existsSync(new URL('../../engines/vendor/omnivoice/runtime.js', import.meta.url))).toBe(false);
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
    const packagedProjectLicense = readFileSync(new URL('../../extension/public/legal/GPL-3.0.txt', import.meta.url), 'utf8');
    const license = readFileSync(new URL('../../extension/public/legal/Apache-2.0.txt', import.meta.url), 'utf8');
    const notices = readFileSync(new URL('../../extension/public/legal/THIRD_PARTY_NOTICES.txt', import.meta.url), 'utf8');
    const metadata = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    expect(metadata.license).toBe('GPL-3.0-or-later');
    expect(projectLicense).toContain('GNU GENERAL PUBLIC LICENSE');
    expect(projectLicense).toContain('Version 3, 29 June 2007');
    expect(notices).toContain('Copyright (c) 2026 Felix Olsson');
    expect(existsSync(new URL('../../extension/public/legal/MIT.txt', import.meta.url))).toBe(false);
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
