import { expect, it } from 'vitest';
import { getOmniVoicePlaybackSeed, getOmniVoicePlaybackNumStep, getOmniVoicePlaybackGenderCue, getOmniVoicePlaybackGuidanceScale, getOmniVoicePlaybackSpeed, getOmniVoicePlaybackPronunciationVariant, selectOmniVoiceSpeakers, toOmniVoiceCatalogEntry } from '../../tooling/scripts/lib/omnivoice-speaker-selection.mjs';

const entry = (id, overall, embedding, reasons = []) => ({
  speaker: { id, hash: id }, reasons, result: { signal: { dnsmos: { overall } }, embedding },
});

it('starts with the highest acoustic score, then spreads identities within the acoustic band', () => {
  const best = entry('a', 3.7, [1, 0]);
  const duplicate = entry('b', 3.69, [1, 0.01]);
  const different = entry('c', 3.5, [0, 2]);
  const poor = entry('d', 2.6, [-1, 0]);
  expect(selectOmniVoiceSpeakers([poor, different, duplicate, best], 3)).toEqual([best, different, duplicate]);
});

it('keeps transcript failures behind passing references and rejects duplicate hashes', () => {
  const best = entry('a', 3.4, [1, 0]);
  const other = entry('b', 3.3, [0, 1]);
  const failed = entry('c', 3.8, [-1, 0], ['transcript']);
  expect(selectOmniVoiceSpeakers([failed, other, best], 3)).toEqual([best, other, failed]);
  expect(() => selectOmniVoiceSpeakers([best, { ...other, speaker: best.speaker }], 2)).toThrow('distinct');
});

it('does not count two recordings of one published reader as different voices', () => {
  const first = entry('a', 3.7, [1, 0]);
  const anotherRecording = entry('b', 3.6, [-1, 0]);
  const anotherReader = entry('c', 3.5, [0, 1]);
  first.speaker.source = anotherRecording.speaker.source = { dataset: 'LibriTTS-R', readerId: '123' };
  anotherReader.speaker.source = { dataset: 'LibriTTS-R', readerId: '456' };
  expect(selectOmniVoiceSpeakers([first, anotherRecording, anotherReader], 2)).toEqual([first, anotherReader]);
  expect(() => selectOmniVoiceSpeakers([first, anotherRecording], 2)).toThrow('distinct');
});

it.each([[0, 0], [NaN, 1], [Infinity, 1], []])('rejects invalid embeddings %j', embedding => {
  expect(() => selectOmniVoiceSpeakers([entry('a', 3.4, embedding)], 1)).toThrow('embedding');
});

it('rejects incompatible embedding dimensions', () => {
  expect(() => selectOmniVoiceSpeakers([entry('a', 3.4, [1]), entry('b', 3.3, [0, 1])], 1)).toThrow('dimensions');
});

const speaker = { id: 'en-female-1', lang: 'en', text: 'A reference sentence.', gender: 'female', variation: 1,
  seed: 42, frames: 1, codes: [0, 1, 2, 3, 4, 5, 6, 7], hash: 'a'.repeat(64) };
const source = { kind: 'recording', dataset: 'LibriTTS-R', readerId: '123', license: 'CC-BY-4.0',
  language: 'en', attribution: 'LibriTTS-R contributors', url: 'https://www.openslr.org/141/', audioSha256: 'b'.repeat(64), encoderSha256: 'c'.repeat(64) };

it('preserves measured playback pace and rejects speeds outside the runtime range', () => {
  expect(getOmniVoicePlaybackSpeed(speaker)).toBe(1);
  for (const playbackSpeed of [.5, .85, 1, 1.15, 1.5]) expect(toOmniVoiceCatalogEntry({ ...speaker, playbackSpeed }).playbackSpeed).toBe(playbackSpeed);
  for (const playbackSpeed of [0, .49, 1.51, NaN, Infinity, '0.85']) expect(() => toOmniVoiceCatalogEntry({ ...speaker, playbackSpeed })).toThrow('playback speed');
});

it('preserves a measured Cantonese pronunciation variant without accepting it for other languages', () => {
  expect(getOmniVoicePlaybackPronunciationVariant(speaker)).toBeNull();
  const measured = { ...speaker, id: 'yue-female-1', lang: 'yue', playbackPronunciationVariant: 'yue-nei5' };
  expect(toOmniVoiceCatalogEntry(measured)).toEqual(measured);
  expect(getOmniVoicePlaybackPronunciationVariant({ id: measured.id, playbackPronunciationVariant: 'yue-nei5' })).toBe('yue-nei5');
  for (const playbackPronunciationVariant of [true, false, '', 'unknown'])
    expect(() => toOmniVoiceCatalogEntry({ ...measured, playbackPronunciationVariant })).toThrow('pronunciation variant');
  expect(() => toOmniVoiceCatalogEntry({ ...speaker, playbackPronunciationVariant: 'yue-nei5' })).toThrow('pronunciation variant');
});

it('retains measured guidance independently of the reference and rejects invalid scales', () => {
  expect(getOmniVoicePlaybackGuidanceScale(speaker)).toBe(2);
  for (const playbackGuidanceScale of [0, 1, 2, 2.5, 3, 4]) expect(toOmniVoiceCatalogEntry({ ...speaker, playbackGuidanceScale }).playbackGuidanceScale).toBe(playbackGuidanceScale);
  for (const playbackGuidanceScale of [-1, 5, NaN, Infinity, '3']) expect(() => toOmniVoiceCatalogEntry({ ...speaker, playbackGuidanceScale })).toThrow('guidance scale');
});

it('preserves measured refinement steps and rejects unsupported step counts', () => {
  expect(toOmniVoiceCatalogEntry({ ...speaker, playbackNumStep: 48 }).playbackNumStep).toBe(48);
  expect(getOmniVoicePlaybackNumStep(speaker)).toBe(24);
  expect(getOmniVoicePlaybackNumStep({ ...speaker, lang: 'tr' })).toBe(32);
  for (const playbackNumStep of [0, 65, 1.5, NaN, '32']) {
    expect(() => toOmniVoiceCatalogEntry({ ...speaker, playbackNumStep })).toThrow('step count');
  }
});

it('preserves reference-only conditioning and rejects non-boolean cue settings', () => {
  expect(toOmniVoiceCatalogEntry({ ...speaker, playbackGenderCue: false }).playbackGenderCue).toBe(false);
  expect(getOmniVoicePlaybackGenderCue(speaker)).toBe(true);
  for (const playbackGenderCue of [0, 1, 'false']) expect(() => toOmniVoiceCatalogEntry({ ...speaker, playbackGenderCue })).toThrow('gender cue');
});

it('retains recorded pace, source attribution and verified input hashes in the shipped entry', () => {
  expect(toOmniVoiceCatalogEntry({ ...speaker, durationSource: 'recording', source, elapsedMs: 100 }))
    .toEqual({ ...speaker, durationSource: 'recording', source });
});

it('retains measured input normalization without replacing the original recording hash', () => {
  const normalized = { ...source, rmsNormalization: { targetRms: .1, inputRms: .02, gain: 5, outputRms: .1, peak: .75 },
    encoderInputSha256: 'd'.repeat(64), referencePreparationSha256: 'e'.repeat(64) };
  expect(toOmniVoiceCatalogEntry({ ...speaker, durationSource: 'recording', source: normalized }).source).toEqual(normalized);
  for (const changed of [{ targetRms: .2 }, { inputRms: 0 }, { gain: 4 }, { outputRms: .09 }, { peak: 1.1 }])
    expect(() => toOmniVoiceCatalogEntry({ ...speaker, durationSource: 'recording',
      source: { ...normalized, rmsNormalization: { ...normalized.rmsNormalization, ...changed } } })).toThrow('normalization metadata');
  expect(() => toOmniVoiceCatalogEntry({ ...speaker, durationSource: 'recording',
    source: { ...normalized, encoderInputSha256: '' } })).toThrow('normalization metadata');
});

it('preserves the share-alike license on recorded references and rejects restricted licenses', () => {
  const attributed = { ...source, dataset: 'JVNV', license: 'CC-BY-SA-4.0' };
  expect(toOmniVoiceCatalogEntry({ ...speaker, durationSource: 'recording', source: attributed }).source).toEqual(attributed);
  expect(() => toOmniVoiceCatalogEntry({ ...speaker, durationSource: 'recording',
    source: { ...source, license: 'CC-BY-NC-ND-4.0' } })).toThrow('attribution');
});

it('keeps the existing generated-reference format', () => {
  expect(toOmniVoiceCatalogEntry({ ...speaker, elapsedMs: 100 })).toEqual(speaker);
});

it('retains a measured playback seed independently of the reference generation seed and slot', () => {
  expect(toOmniVoiceCatalogEntry({ ...speaker, playbackSeed: 73 })).toEqual({ ...speaker, playbackSeed: 73 });
  expect(getOmniVoicePlaybackSeed({ variation: 8, playbackSeed: 73 })).toBe(73);
  expect(getOmniVoicePlaybackSeed({ variation: 8 })).toBe(49);
  for (const playbackSeed of [-1, 1.5, NaN, 2 ** 32]) expect(() => toOmniVoiceCatalogEntry({ ...speaker, playbackSeed })).toThrow('playback seed');
});

it('retains the recording origin when a cloned output becomes a reference', () => {
  const origin = { ...source, kind: 'recording-derived', parentReferenceHash: 'd'.repeat(64), generation: { lang: 'en' } };
  expect(toOmniVoiceCatalogEntry({ ...speaker, durationSource: 'recording-derived', source: origin }))
    .toEqual({ ...speaker, durationSource: 'recording-derived', source: origin });
  expect(() => toOmniVoiceCatalogEntry({ ...speaker, durationSource: 'recording-derived', source }))
    .toThrow('attribution');
});

it('records the actual source language for a reference selected in another language', () => {
  const selected = { ...speaker, id: 'sv-female-1', lang: 'sv', referenceLanguage: 'en', durationSource: 'recording', source };
  expect(toOmniVoiceCatalogEntry(selected)).toEqual(selected);
  expect(() => toOmniVoiceCatalogEntry({ ...selected, referenceLanguage: 'sv' })).toThrow('Reference language');
  expect(() => toOmniVoiceCatalogEntry({ ...selected, referenceLanguage: 'en<|text_end|>' })).toThrow('Invalid reference language');
  expect(() => toOmniVoiceCatalogEntry({ ...selected, source: { ...source, language: undefined } })).toThrow('source language');
});

it('rejects an unattributed recorded reference before writing the catalog', () => {
  expect(() => toOmniVoiceCatalogEntry({ ...speaker, durationSource: 'recording' })).toThrow('attribution');
  expect(() => toOmniVoiceCatalogEntry({ ...speaker, durationSource: 'recording', source: { ...source, audioSha256: '' } })).toThrow('hashes');
});
