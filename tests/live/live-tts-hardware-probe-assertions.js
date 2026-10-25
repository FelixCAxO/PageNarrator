import { expect } from 'vitest';
import { getTtsProbeColdStartBudget } from './live-tts-hardware-profiles.js';

export function expectValidProbeOutput(output, { minSections = 1 } = {}) {
  expect(output.chrome.deviceMemory === null || output.chrome.deviceMemory > 0).toBe(true);
  expect(output.chrome.hardwareConcurrency === null || output.chrome.hardwareConcurrency > 0).toBe(true);
  expect(output.tts.selectedBackendPlan).toMatchObject({
    device: expect.stringMatching(/^(webgpu|wasm)$/),
    dtype: expect.any(String),
    reason: expect.any(String),
  });
  expect(output.tts.modelLoadMs === null || output.tts.modelLoadMs >= 0).toBe(true);

  const browserFallbackOccurred = output.tts.fallbacks.some((fallback) => fallback.type === 'browser-voice');
  if (output.profile?.expectBrowserFallback) {
    expect(output.tts.fallbackOccurred).toBe(true);
    expect(browserFallbackOccurred).toBe(true);
  } else {
    expect(browserFallbackOccurred).toBe(false);
    expect(Number.isFinite(output.tts.firstSynthesisMs)).toBe(true);
    expect(output.tts.audioDurationSeconds).toBeGreaterThan(0);
    expect(output.tts.realTimeFactor).toBeGreaterThanOrEqual(0);
  }

  if (!output.tts.fallbackOccurred && minSections > 1) {
    expect(output.tts.sections.length).toBeGreaterThanOrEqual(minSections);
    expect(output.tts.flow.sectionCount).toBeGreaterThanOrEqual(minSections);
    expect(output.tts.flow.loadTransitionCount).toBeGreaterThanOrEqual(minSections - 1);
    expect(output.tts.flow.maxNextSectionReadyGapMs === null || output.tts.flow.maxNextSectionReadyGapMs >= 0).toBe(true);
    expect(output.tts.flow.maxInterSectionGapMs === null || output.tts.flow.maxInterSectionGapMs >= 0).toBe(true);
    expect(output.tts.flow.pauseCount).toBeGreaterThanOrEqual(0);
  }

  const coldStartBudget = getTtsProbeColdStartBudget(output.profile);
  if (coldStartBudget) {
    expect(output.tts.preTtsLatency.panelReadyMs).toBeLessThanOrEqual(coldStartBudget.panelReadyMs);
    expect(output.tts.preTtsLatency.extractionMs).toBeLessThanOrEqual(coldStartBudget.extractionMs);
    expect(output.tts.preTtsLatency.firstAudibleMs).toBeLessThanOrEqual(coldStartBudget.firstAudibleMs);
  }
}

export function isProbeResultReady(tts = {}, {
  requiredSections = 1, profile = null, condition = {}, audio = null, readIdle = false,
} = {}) {
  if (!tts?.selectedBackendPlan) return false;
  if (tts.fallbacks?.some?.((fallback) => fallback.type === 'browser-voice')) return true;

  const hasFirstSynthesis = Number.isFinite(tts.firstSynthesisMs);
  const hasFlow = (tts.flow?.sectionCount || 0) >= requiredSections
    && (requiredSections <= 1 || (tts.flow?.loadTransitionCount || 0) >= requiredSections - 1);
  const hasPlaybackObservation = Boolean(tts.flow?.audioPlaybackObserved);
  const hasMeasuredPlaybackFlow = requiredSections <= 1
    || (tts.flow?.measuredTransitionCount || 0) >= requiredSections - 1;
  const ready = hasFirstSynthesis && hasFlow && hasPlaybackObservation && hasMeasuredPlaybackFlow;
  const waitForAudio = profile && !profile.lifecycle && !profile.soak && !profile.faults?.length
    && !condition.fault && !condition.evictCacheBefore && condition.network !== 'offline';
  const finishedSections = tts.sections?.filter?.((section) => Number.isFinite(section.audioEndAtMs)).length || 0;
  // A handoff is not complete when the next section merely starts playing.
  if (ready && waitForAudio && requiredSections > 1 && finishedSections < requiredSections) return false;
  if (!ready || !waitForAudio || readIdle || !audio?.available || audio.errors?.length) return ready;
  // Playback-start telemetry can precede a real sample from the media tap.
  return finishedSections >= requiredSections || Number.isFinite(audio.readFirstNonSilentEpochMs);
}
export function getProbeCleanupFailures(attempts = []) {
  return attempts.filter((attempt) => attempt?.browser?.launch && (
    attempt.cleanup?.verified !== true
    || !Array.isArray(attempt.cleanup.sessions) || !attempt.cleanup.sessions.length
    || attempt.cleanup.sessions.some((session) => session?.verified !== true || session.remaining !== 0)
  )).map((attempt) => `${attempt.attemptId || 'unknown attempt'}: browser cleanup is missing or unverified`);
}
