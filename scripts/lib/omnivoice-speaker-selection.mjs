import assert from 'node:assert/strict';
import { getOmniVoiceLanguage } from '../../src/tts/omnivoice/languages.js';

// Keep acoustic quality close to the best remaining reference before comparing identities.
const QUALITY_BAND = 0.25;

export function getOmniVoicePlaybackSeed(speaker) {
  const seed = speaker.playbackSeed ?? 41 + speaker.variation;
  assert.ok(Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff, 'Invalid OmniVoice playback seed');
  return seed;
}

export function getOmniVoicePlaybackNumStep(speaker) {
  const steps = speaker.playbackNumStep ?? (speaker.lang === 'tr' ? 32 : 24);
  assert.ok(Number.isInteger(steps) && steps >= 1 && steps <= 64, 'Invalid OmniVoice playback step count');
  return steps;
}

export function getOmniVoicePlaybackGenderCue(speaker) {
  const enabled = speaker.playbackGenderCue ?? true;
  assert.equal(typeof enabled, 'boolean', 'Invalid OmniVoice playback gender cue');
  return enabled;
}

export function getOmniVoicePlaybackGuidanceScale(speaker) {
  const scale = speaker.playbackGuidanceScale ?? 2;
  assert.ok(Number.isFinite(scale) && scale >= 0 && scale <= 4, 'Invalid OmniVoice playback guidance scale');
  return scale;
}

export function getOmniVoicePlaybackSpeed(speaker) {
  const speed = speaker.playbackSpeed ?? 1;
  assert.ok(Number.isFinite(speed) && speed >= 0.5 && speed <= 1.5, 'Invalid OmniVoice playback speed');
  return speed;
}

export function getOmniVoicePlaybackPronunciationVariant(speaker) {
  const variant = speaker.playbackPronunciationVariant ?? null;
  assert.ok(variant === null || variant === 'yue-nei5' && (speaker.lang ?? speaker.id?.split('-')[0]) === 'yue',
    'Invalid OmniVoice playback pronunciation variant');
  return variant;
}

export function toOmniVoiceCatalogEntry(speaker) {
  const { id, lang, text, gender, variation, seed, frames, codes, hash } = speaker;
  const entry = { id, lang, text, gender, variation, seed, frames, codes, hash };
  if (speaker.playbackSeed !== undefined) entry.playbackSeed = getOmniVoicePlaybackSeed(speaker);
  if (speaker.playbackNumStep !== undefined) entry.playbackNumStep = getOmniVoicePlaybackNumStep(speaker);
  if (speaker.playbackGenderCue !== undefined) entry.playbackGenderCue = getOmniVoicePlaybackGenderCue(speaker);
  if (speaker.playbackGuidanceScale !== undefined) entry.playbackGuidanceScale = getOmniVoicePlaybackGuidanceScale(speaker);
  if (speaker.playbackSpeed !== undefined) entry.playbackSpeed = getOmniVoicePlaybackSpeed(speaker);
  if (speaker.playbackPronunciationVariant !== undefined) entry.playbackPronunciationVariant = getOmniVoicePlaybackPronunciationVariant(speaker);
  if (speaker.referenceLanguage !== undefined) {
    assert.equal(getOmniVoiceLanguage(speaker.referenceLanguage)?.code, speaker.referenceLanguage, 'Invalid reference language');
    entry.referenceLanguage = speaker.referenceLanguage;
  }
  if (['recording', 'recording-derived'].includes(speaker.durationSource)) {
    const source = speaker.source;
    assert.ok(source?.kind === speaker.durationSource && typeof source.dataset === 'string' && source.dataset
      && ['CC-BY-4.0', 'CC-BY-SA-4.0', 'CC0-1.0'].includes(source.license) && typeof source.attribution === 'string' && source.attribution
      && typeof source.url === 'string' && source.url.startsWith('https://')
      && /^[a-f0-9]{64}$/u.test(source.audioSha256) && /^[a-f0-9]{64}$/u.test(source.encoderSha256)
      && (speaker.durationSource !== 'recording-derived' || /^[a-f0-9]{64}$/u.test(source.parentReferenceHash)),
    'Recorded references require source attribution and audio/encoder hashes');
    if (source.rmsNormalization !== undefined) {
      const level = source.rmsNormalization;
      assert.ok(level && level.targetRms === 0.1 && Number.isFinite(level.inputRms) && level.inputRms > 0
        && Number.isFinite(level.gain) && Math.abs(level.gain - Math.max(1, 0.1 / level.inputRms)) < 1e-10
        && Number.isFinite(level.outputRms) && Math.abs(level.outputRms - Math.max(0.1, level.inputRms)) < 1e-6
        && Number.isFinite(level.peak) && level.peak > 0 && level.peak <= 1
        && /^[a-f0-9]{64}$/u.test(source.encoderInputSha256) && /^[a-f0-9]{64}$/u.test(source.referencePreparationSha256),
      'Invalid reference normalization metadata');
    }
    const referenceLanguage = speaker.referenceLanguage ?? lang;
    assert.ok(typeof source.language === 'string' && getOmniVoiceLanguage(source.language)?.code === source.language,
      'Missing recording source language');
    assert.equal(referenceLanguage, speaker.durationSource === 'recording' ? source.language : source.generation?.lang,
      'Reference language differs from the recorded or generated audio');
    return { ...entry, durationSource: speaker.durationSource, source };
  }
  return entry;
}

export function selectOmniVoiceSpeakers(entries, count = 10) {
  const vectors = new Map(entries.map(entry => {
    const vector = entry.result.embedding;
    assert.ok(Array.isArray(vector) && vector.length && vector.every(Number.isFinite), 'Missing speaker embedding');
    assert.ok(Number.isFinite(entry.result.signal.dnsmos.overall), 'Missing acoustic score');
    const norm = Math.hypot(...vector);
    assert.ok(Number.isFinite(norm) && norm > 0, 'Invalid speaker embedding magnitude');
    return [entry, vector.map(value => value / norm)];
  }));
  const dimensions = vectors.values().next().value?.length;
  assert.ok([...vectors.values()].every(vector => vector.length === dimensions), 'Speaker embedding dimensions differ');
  const chosen = [];
  while (chosen.length < count) {
    const remaining = entries.filter(entry => !chosen.some(other => other.speaker.hash === entry.speaker.hash
      || (entry.speaker.source?.readerId && entry.speaker.source.dataset === other.speaker.source?.dataset
        && entry.speaker.source.readerId === other.speaker.source?.readerId)));
    assert.ok(remaining.length, 'Not enough distinct speaker references');
    // A transcript failure never displaces a fully passing candidate.
    const passing = remaining.filter(entry => !entry.reasons.length);
    const eligible = passing.length ? passing : remaining;
    const best = Math.max(...eligible.map(entry => entry.result.signal.dnsmos.overall));
    const candidates = eligible.filter(entry => entry.result.signal.dnsmos.overall >= best - QUALITY_BAND);
    const distance = entry => chosen.length ? Math.min(...chosen.map(other =>
      1 - vectors.get(entry).reduce((sum, value, index) => sum + value * vectors.get(other)[index], 0))) : 0;
    candidates.sort((a, b) => distance(b) - distance(a)
      || b.result.signal.dnsmos.overall - a.result.signal.dnsmos.overall
      || a.speaker.id.localeCompare(b.speaker.id));
    chosen.push(candidates[0]);
  }
  return chosen;
}
