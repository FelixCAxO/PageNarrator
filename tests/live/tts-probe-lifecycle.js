import { captureProbePdfOcr } from './tts-probe-document-targets.js';
import { summarizeProbePdfOcr } from './tts-probe-ocr.js';
import { setTimeout as delay } from 'node:timers/promises';

import { LIFECYCLE_BOUNDS } from './live-tts-hardware-profiles.js';
import { EXTENDED_TTS_PROBE_DOCUMENT_TYPES } from './live-tts-hardware-probe-documents.js';
import { expectValidProbeOutput } from './live-tts-hardware-probe-assertions.js';

import { MODEL_CACHE_EXPRESSION, READER_ENGINE_OBSERVATION_EXPRESSION, classifyProbeOutcome, deriveRepeatedReadResult, evaluateLaneExpectations, createSoakRecorder, resolveExecutionBackend, statusForError, summarizeModelCache, summarizeWorkerThreads } from './tts-probe-observations.js';
import { PROBE_WORKLOADS, TRANSCRIPT_EXPRESSION, scoreWorkloadContent, selectScoredContent } from './tts-probe-workloads.js';
import { getResumePositionStorageKey } from '../../src/lib/storage-keys.js';
import { MODEL_ID, MODEL_REVISION } from '../../src/lib/voice-model.js';
import { RUN_STATUS } from '../../scripts/weak-hardware/evidence-contract.mjs';

import { readCpuTicks } from '../../scripts/weak-hardware/host-load.mjs';

import { sha256 } from '../../scripts/weak-hardware/run-provenance.mjs';
import { seedProbeDocumentTarget, queueProbeReadAction, waitForProbeReadCleanup, clickProbePopupControl } from './tts-probe-controls.js';
import { evaluateExpression, PAGE_EVALUATE_TIMEOUT_MS } from './tts-probe-cdp.js';
import { waitFor, getProbeSpeed, PROBE_TIMEOUT_MS, ProbeCrashError } from './tts-probe-settings.js';
import { finalizeAttempt } from './tts-probe-results.js';

/**
 * A further user read in the same toolbar-player page with observed cached
 * model bytes. The product may reload its engine; that cost remains measured.
 */
export async function runRepeatedRead({
  cdp,
  browser,
  profile,
  attempt,
  readerEngineSessionId,
  popupSessionId,
  requiredSections,
  crashedSessions,
  hostLoadBefore,
  previousPlan,
  hardware,
  workers,
  serviceWorkerSessionId,
  documentTarget,
  previousReadId,
}) {
  // Like-for-like warm sample: same start position as the first read, with
  // the saved resume position from that read removed.
  await clearResumePosition(cdp, serviceWorkerSessionId, documentTarget);
  // Reading starts from the viewport; the first read's highlighting scrolled it.
  await scrollDocumentToTop(cdp, documentTarget);
  await seedProbeDocumentTarget(cdp, serviceWorkerSessionId, documentTarget);
  const cacheVerificationStartedAtEpochMs = Date.now();
  attempt.modelCache = { ...summarizeModelCache((await evaluateExpression(cdp, serviceWorkerSessionId, MODEL_CACHE_EXPRESSION)).result?.value),
    verificationStartedAtEpochMs: cacheVerificationStartedAtEpochMs, verifiedAtEpochMs: Date.now() };
  attempt.readLifecycle = { phase: 'warm', pageSessionId: readerEngineSessionId, previousReadId };
  const startedAtMs = Date.now();
  const ticksBefore = readCpuTicks();
  const enforcementBefore = await browser.queryEnforcement();
  const gpuBefore = await browser.gpuSample();
  const ocrBefore = await captureProbePdfOcr(cdp, documentTarget);
  const assertionFailures = [];
  let page = null;
  let output = null;
  let timedOut = false;
  attempt.hardware = hardware;
  try {
    // The page's narration and transcript recorders keep the fullest text per
    // page; start them empty so this read is scored on its own text.
    await evaluateExpression(cdp, readerEngineSessionId, RESET_CONTENT_RECORDERS_EXPRESSION);
    const sinceMs = (await evaluateExpression(cdp, readerEngineSessionId, 'performance.now()')).result.value;
    attempt.readClick = await queueProbeReadAction(cdp, popupSessionId);
    attempt.clickEpochMs = attempt.readClick.clickedAtEpochMs;
    attempt.readLifecycle.cacheVerificationToClickMs = attempt.clickEpochMs - attempt.modelCache.verifiedAtEpochMs;
    let lastState = null;
    const derived = await waitFor(async () => {
      assertNotCrashed(readerEngineSessionId, crashedSessions);
      const result = await evaluateExpression(cdp, readerEngineSessionId, `(() => ({
        events: window.__pagenarratorTtsProbe?.events || [],
        audio: globalThis.__pnProbeAudio || null,
        errorVisible: Boolean(document.getElementById('error-notice') && !document.getElementById('error-notice').hidden),
        readIdle: Boolean(document.getElementById('stop-btn')?.hidden) && !document.getElementById('read-btn')?.disabled,
      }))()`);
      const value = result.result.value;
      const tts = deriveRepeatedReadResult(value.events, {
        sinceMs,
        clickEpochMs: attempt.clickEpochMs,
        audio: value.audio,
        previousPlan,
        speed: getProbeSpeed(profile),
      });
      lastState = { sections: tts.flow.sectionCount, audioEnds: tts.audioEndCount, errorVisible: value.errorVisible };
      if (value.errorVisible && value.readIdle) return tts;
      return tts.flow.sectionCount >= requiredSections && tts.audioEndCount >= requiredSections ? tts : null;
    }, () => `Repeated read ${attempt.readIndex} did not complete for ${profile.name}: ${JSON.stringify(lastState)}`, PROBE_TIMEOUT_MS);
    page = (await evaluateExpression(cdp, readerEngineSessionId, READER_ENGINE_OBSERVATION_EXPRESSION)).result?.value || null;
    output = { ...attempt, ...hardware, tts: derived };
    attempt.modelResidency = derived.modelResidency;
    if (profile.expected) {
      assertionFailures.push(...evaluateLaneExpectations(profile, {
        ...attempt,
        tts: derived,
        page,
        execution: resolveExecutionBackend(derived),
        outcome: classifyProbeOutcome({ tts: derived, page }),
        workers: summarizeWorkerThreads(workers),
      }));
    } else if (!page?.errorNotice?.visible) {
      try {
        expectValidProbeOutput(output, { minSections: requiredSections });
      } catch (error) {
        assertionFailures.push(error.message);
      }
    }
    await waitForProbeReadCleanup(cdp, readerEngineSessionId, popupSessionId);
  } catch (error) {
    attempt.error = error.message;
    attempt.status = statusForError(error);
    timedOut = error?.name === 'ProbeTimeoutError' || error?.name === 'CdpTimeoutError';
    if (error?.name === 'CdpTimeoutError' && error.sessionId === readerEngineSessionId) attempt.crash = 'renderer-unresponsive';
    if (crashedSessions.has(readerEngineSessionId)) {
      attempt.status = RUN_STATUS.CRASHED;
      attempt.crash = 'renderer';
    }
  }
  const enforcementAfter = await browser.queryEnforcement();
  const gpuAfter = await browser.gpuSample();
  attempt.ocr = summarizeProbePdfOcr({ documentType: attempt.documentType, profile, before: ocrBefore, after: await captureProbePdfOcr(cdp, documentTarget) });
  const pageUsable = attempt.status !== RUN_STATUS.CRASHED && attempt.crash !== 'renderer-unresponsive';
  if (pageUsable) {
    attempt.content = await captureWorkloadContent(cdp, readerEngineSessionId, attempt.documentType);
    assertionFailures.push(...contentAssertionFailures(attempt, attempt.documentType, { tts: output?.tts, page }));
  }
  finalizeAttempt({
    attempt,
    profile,
    probe: null,
    page,
    output,
    assertionFailures,
    timedOut,
    enforcementBefore,
    enforcementAfter,
    gpuBefore,
    gpuAfter,
    heap: pageUsable
      ? await cdp.send('Runtime.getHeapUsage', {}, readerEngineSessionId, { timeoutMs: PAGE_EVALUATE_TIMEOUT_MS }).catch(() => null)
      : null,
    ticksBefore,
    ticksAfter: readCpuTicks(),
    startedAtMs,
    hostLoadBefore,
    browser,
    workers,
  });
}

export const AUDIO_STATE_EXPRESSION = `(() => {
  const audio = globalThis.__pnProbeAudio || {};
  return {
    playingNow: Boolean(audio.playingNow),
    audibleNow: Boolean(audio.audibleNow),
    lastNonSilentEpochMs: audio.lastNonSilentEpochMs ?? null,
    lastTickEpochMs: audio.lastTickEpochMs ?? null,
    readIdle: Boolean(document.getElementById('stop-btn')?.hidden) && !document.getElementById('read-btn')?.disabled,
    events: (window.__pagenarratorTtsProbe?.events || []).filter((event) => event.type === 'section-audio-end').length,
  };
})()`;

export async function readAudioState(cdp, sessionId) {
  return (await evaluateExpression(cdp, sessionId, AUDIO_STATE_EXPRESSION)).result.value;
}

// Polls the audio tap; a tick newer than the action proves the new state was observed.
export async function waitForAudioState(cdp, sessionId, predicate, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const state = await readAudioState(cdp, sessionId);
    if (predicate(state)) return { at: Date.now(), state };
    await delay(25);
  }
  return null;
}

// Performs a user action while speech plays and measures its audible effect
// on the page's media output (bounds: LIFECYCLE_BOUNDS).
export async function runLifecycleAction({ cdp, action, readerEngineSessionId, readerEngineTargetId, popupSessionId }) {
  const source = 'in-page media-element capture (not output loopback)';
  if (action === 'stop') {
    const click = await clickProbePopupControl(cdp, popupSessionId, 'popup-stop');
    const silent = await waitForAudioState(cdp, readerEngineSessionId, (state) => (
      !state.playingNow && !state.audibleNow && state.lastTickEpochMs > click.clickedAtEpochMs
    ), 5_000);
    await delay(LIFECYCLE_BOUNDS.staleSpeechWindowMs);
    const after = await readAudioState(cdp, readerEngineSessionId);
    const idle = await waitForAudioState(cdp, readerEngineSessionId, (state) => state.readIdle, 10_000);
    return {
      action,
      source,
      stopToSilenceMs: silent ? silent.at - click.clickedAtEpochMs : null,
      staleSpeech: Boolean(silent) && Number(after.lastNonSilentEpochMs) > silent.at,
      readIdle: Boolean(idle),
    };
  }
  if (action === 'pause-resume') {
    const pause = await clickProbePopupControl(cdp, popupSessionId, 'popup-toggle');
    const silent = await waitForAudioState(cdp, readerEngineSessionId, (state) => (
      !state.playingNow && !state.audibleNow && state.lastTickEpochMs > pause.clickedAtEpochMs
    ), 5_000);
    await delay(LIFECYCLE_BOUNDS.pauseHoldMs);
    const held = await readAudioState(cdp, readerEngineSessionId);
    const resume = await clickProbePopupControl(cdp, popupSessionId, 'popup-toggle');
    const sound = await waitForAudioState(cdp, readerEngineSessionId, (state) => (
      state.audibleNow && state.lastTickEpochMs > resume.clickedAtEpochMs
    ), 10_000);
    return {
      action,
      source,
      pauseToSilenceMs: silent ? silent.at - pause.clickedAtEpochMs : null,
      heldSilent: Boolean(silent) && !(Number(held.lastNonSilentEpochMs) > silent.at),
      resumeToSoundMs: sound ? sound.at - resume.clickedAtEpochMs : null,
    };
  }
  if (action === 'minimize') {
    const { windowId } = await cdp.send('Browser.getWindowForTarget', { targetId: readerEngineTargetId });
    const before = await readAudioState(cdp, readerEngineSessionId);
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
    const { bounds } = await cdp.send('Browser.getWindowBounds', { windowId });
    await delay(LIFECYCLE_BOUNDS.minimizedObservationMs);
    const after = await readAudioState(cdp, readerEngineSessionId);
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    return {
      action,
      source: 'toolbar-player recorder events (timers may be throttled while minimized)',
      minimized: bounds?.windowState === 'minimized',
      observationMs: LIFECYCLE_BOUNDS.minimizedObservationMs,
      sectionsEndedWhileMinimized: after.events - before.events,
    };
  }
  return { action, error: 'unknown lifecycle action' };
}

// Samples resources while a long read continues (bounds: SOAK_BOUNDS). The
// record is attached to the attempt before the first sample, so a browser
// crash part-way through keeps what was sampled.
export async function runSoakObservation({ cdp, browser, readerEngineSessionId, durationMs, bounds, attempt }) {
  const startedAt = Date.now();
  const soak = createSoakRecorder({ targetMs: bounds.targetMs, configuredMs: durationMs, warmupSamples: bounds.warmupSamples, startedAt });
  attempt.soak = soak.record;
  let finishedDocument = false;
  while (Date.now() - startedAt < durationMs) {
    await delay(Math.min(bounds.sampleEveryMs, Math.max(0, durationMs - (Date.now() - startedAt))));
    const enforcement = await browser.queryEnforcement();
    const heap = await cdp.send('Runtime.getHeapUsage', {}, readerEngineSessionId, { timeoutMs: PAGE_EVALUATE_TIMEOUT_MS }).catch(() => null);
    const audio = await readAudioState(cdp, readerEngineSessionId);
    soak.addSample({
      privateBytes: enforcement?.totals?.privateBytes ?? null,
      workingSetBytes: enforcement?.totals?.workingSetBytes ?? null,
      peakJobCommitBytes: enforcement?.totals?.peakJobCommitBytes ?? null,
      jsHeapUsedBytes: heap?.usedSize ?? null,
      sectionsEnded: audio.events,
      readIdle: audio.readIdle,
    }, Date.now());
    if (audio.readIdle) {
      finishedDocument = true;
      break;
    }
  }
  return soak.finish({ finishedDocument, now: Date.now() });
}

export const RESET_CONTENT_RECORDERS_EXPRESSION = `(() => {
  const narration = globalThis.__pnProbeNarration;
  if (narration) {
    narration.chunks = [];
    narration.broadcasts = 0;
  }
  const transcript = globalThis.__pnProbeTranscript;
  if (transcript) {
    transcript.title = '';
    transcript.paragraphs = [];
    transcript.countLabel = '';
    transcript.textLength = 0;
  }
  return true;
})()`;

export async function scrollDocumentToTop(cdp, documentTarget) {
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: documentTarget.targetId, flatten: true });
  try {
    await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        for (const element of [document.scrollingElement, ...document.querySelectorAll('[data-pagenarrator-scroll-root], #viewer, #pdf-container')]) element?.scrollTo?.(0, 0);
        return window.scrollY;
      })()`,
      returnByValue: true,
    }, sessionId, { timeoutMs: PAGE_EVALUATE_TIMEOUT_MS });
  } finally {
    await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => null);
  }
}

export async function clearResumePosition(cdp, serviceWorkerSessionId, documentTarget) {
  await evaluateExpression(cdp, serviceWorkerSessionId,
    `chrome.storage.local.remove(${JSON.stringify(getResumePositionStorageKey(documentTarget.sourceUrl || documentTarget.url))}).then(() => true)`);
}

// Extraction correctness against the workload's authored reference.
export const CONTENT_EXCERPT_CHARS = 400;

export async function captureWorkloadContent(cdp, sessionId, documentType) {
  const workload = PROBE_WORKLOADS[documentType];
  const transcript = (await evaluateExpression(cdp, sessionId, TRANSCRIPT_EXPRESSION).catch(() => null))?.result?.value;
  if (!workload || !transcript) return { available: false, reason: 'transcript unavailable' };
  const scored = selectScoredContent(transcript);
  const { text } = scored;
  const transcriptScore = scoreWorkloadContent(scored.transcriptText, workload.reference, { truncated: transcript.truncated });
  return {
    available: true,
    source: scored.source,
    queuedChunks: scored.queuedChunks,
    narrationErrors: transcript.narration?.errors || [],
    textSha256: sha256(text),
    textLength: text.length,
    // Enough to diagnose a failed score without storing whole documents.
    excerpt: { start: text.slice(0, CONTENT_EXCERPT_CHARS), end: text.length > CONTENT_EXCERPT_CHARS ? text.slice(-CONTENT_EXCERPT_CHARS) : '' },
    ...scoreWorkloadContent(text, workload.reference, { truncated: scored.truncated }),
    // The transcript card is reported, not gated: it is a UI surface, not narration.
    transcript: {
      source: transcript.source || null,
      paragraphs: transcript.paragraphs.length,
      countLabel: transcript.countLabel,
      textLength: scored.transcriptText.length,
      checkpoints: transcriptScore.checkpoints,
      wordRecall: transcriptScore.wordRecall,
      passes: transcriptScore.passes,
    },
  };
}

// New workloads must narrate their authored content; the legacy article and
// PDF only record the score so existing gates keep their meaning.
export function contentAssertionFailures(attempt, documentType, { tts, page }) {
  if (!EXTENDED_TTS_PROBE_DOCUMENT_TYPES.includes(documentType)) return [];
  if (!attempt.content?.available) return ['extracted content was not observable'];
  const outcome = classifyProbeOutcome({ tts, page });
  if (outcome === 'explicit-error') return [];
  return attempt.content.failures.map((failure) => `content: ${failure}`);
}

// Confirms the offline condition reached the context that downloads models.
export async function verifyOfflineEmulation(cdp, sessionId) {
  const result = await evaluateExpression(cdp, sessionId, `fetch(${JSON.stringify(`https://huggingface.co/${MODEL_ID}/resolve/${MODEL_REVISION}/config.json`)}, { cache: 'no-store', credentials: 'omit' })
    .then((response) => 'reachable:' + response.status)
    .catch((error) => 'blocked:' + (error?.message || error))`);
  const value = String(result.result?.value || '');
  return { mode: 'offline', method: 'CDP Network.emulateNetworkConditions on the toolbar-player page', verifiedBlocked: value.startsWith('blocked:'), probe: value };
}

export function recordConsole(consoleBySession, sessionId, level, text) {
  if (!sessionId) return;
  if (!consoleBySession.has(sessionId)) consoleBySession.set(sessionId, []);
  const entries = consoleBySession.get(sessionId);
  entries.push({ level, text: String(text).slice(0, 500), at: new Date().toISOString() });
  if (entries.length > 40) entries.shift();
}

export function assertNotCrashed(sessionId, crashedSessions) {
  if (crashedSessions.has(sessionId)) throw new ProbeCrashError('The toolbar-player renderer crashed.', 'renderer');
}
