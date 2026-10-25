import { captureProbePdfOcr } from './tts-probe-document-targets.js';
import { summarizeProbePdfOcr } from './tts-probe-ocr.js';
import { expect } from 'vitest';
import { LIFECYCLE_BOUNDS } from './live-tts-hardware-profiles.js';
import { READ_TO_END_TTS_PROBE_DOCUMENT_TYPES } from './live-tts-hardware-probe-documents.js';
import {
  expectValidProbeOutput,
  isProbeResultReady,
} from './live-tts-hardware-probe-assertions.js';

import { createRunFaults } from './tts-probe-run-faults.js';

import { MODEL_CACHE_EXPRESSION, READER_ENGINE_OBSERVATION_EXPRESSION, classifyProbeOutcome, createBusyPageWait, evaluateLaneExpectations, evaluateLifecycleResult, evaluateSoakResult, resolveExecutionBackend, statusForError, summarizeAudioTap, summarizePageBlocking, summarizeModelCache, summarizeWorkerThreads } from './tts-probe-observations.js';

import { RUN_STATUS } from '../../scripts/weak-hardware/evidence-contract.mjs';

import { readCpuTicks } from '../../scripts/weak-hardware/host-load.mjs';

import { startLoadGenerator } from '../../scripts/weak-hardware/load-generator.mjs';

import { resetColdStartCaches } from './tts-probe-browser-session.js';
import { evaluateExpression, BUSY_PAGE_WAITS, closeTargetBestEffort, PAGE_EVALUATE_TIMEOUT_MS } from './tts-probe-cdp.js';
import { configureProbeRead, openReaderEngineTargetForProfile, seedProbeDocumentTarget, openProbePopup, queueProbeReadAction, expectRuntimeControlsHidden, waitForProbeReadCleanup } from './tts-probe-controls.js';
import { PROBE_TIMEOUT_MS, waitFor, getSoakDurationMs } from './tts-probe-settings.js';
import { collectHardwareSnapshot } from './tts-probe-environment.js';
import { verifyOfflineEmulation, assertNotCrashed, runSoakObservation, runLifecycleAction, runRepeatedRead, captureWorkloadContent, contentAssertionFailures } from './tts-probe-lifecycle.js';
import { expectExpectedBackendReason, finalizeAttempt } from './tts-probe-results.js';

export async function runProbeAttempt({
  cdp,
  browser,
  profile,
  documentTarget,
  extensionId,
  serviceWorkerSessionId,
  requiredSections,
  attempt,
  condition = { network: 'online' },
  hostLoadBefore,
  workersBySession,
  crashedSessions,
  consoleBySession,
  serviceWorkerSessionIdForConsole,
  readsPerTarget = 1,
  startRepeatedAttempt = null,
}) {
  let firstReadCompleted = false;
  let loadGenerator = null;
  const runFaults = createRunFaults({ cdp, profile, condition, extensionId, serviceWorkerSessionId });
  let readerEngineTargetId;
  let readerEngineSessionId;
  let popupTargetId;
  let popupSessionForDiagnostics = null;
  let probe = null;
  let page = null;
  let output = null;
  let timedOut = false;
  let busyPageWait = null;
  const assertionFailures = [];
  const ticksBefore = readCpuTicks();
  const startedAtMs = Date.now();
  let enforcementBefore = null;
  let gpuBefore = null;
  let ocrBefore = null;
  try {
    await resetColdStartCaches(cdp, serviceWorkerSessionId, profile);
    await runFaults.beforeRead();
    attempt.modelCache = summarizeModelCache((await evaluateExpression(cdp, serviceWorkerSessionId, MODEL_CACHE_EXPRESSION)).result?.value);
    await configureProbeRead(cdp, serviceWorkerSessionId, documentTarget, profile, condition);
    const readerEngineTarget = await openReaderEngineTargetForProfile(cdp, extensionId, profile, {
      workers: workersBySession,
      offline: condition.network === 'offline',
    });
    readerEngineTargetId = readerEngineTarget.targetId;
    readerEngineSessionId = readerEngineTarget.sessionId;
    attempt.readIndex = 0;
    attempt.readLifecycle = { phase: 'cold', pageSessionId: readerEngineSessionId };
    await runFaults.arm(readerEngineSessionId);
    busyPageWait = createBusyPageWait({ queryEnforcement: () => browser.queryEnforcement(), deadlineAtMs: startedAtMs + PROBE_TIMEOUT_MS });
    BUSY_PAGE_WAITS.set(readerEngineSessionId, busyPageWait);
    await waitFor(async () => {
      const result = await evaluateExpression(cdp, readerEngineSessionId, 'Boolean(globalThis.chrome?.storage?.local)');
      return result.result.value;
    }, `Toolbar player storage API was not available for ${profile.name} ${documentTarget.documentType}`, 30_000);

    let lastInitState = null;
    await waitFor(async () => {
      const result = await evaluateExpression(cdp, readerEngineSessionId, `(() => ({
        url: location.href,
        readyState: document.readyState,
        hasProbe: Boolean(window.__pagenarratorTtsProbe),
        hasReadButton: Boolean(document.getElementById('read-btn')),
        state: document.getElementById('status-label')?.textContent || '',
        button: document.getElementById('read-btn')?.textContent || document.getElementById('read-btn')?.dataset?.label || '',
        buttonDisabled: Boolean(document.getElementById('read-btn')?.disabled),
      }))()`);
      const value = result.result.value;
      lastInitState = value;
      return value.readyState !== 'loading'
        && value.hasProbe
        && value.hasReadButton
        && value.state === 'Ready to read'
        && value.button === 'Read page'
        && value.buttonDisabled === false;
    }, () => `Toolbar player probe did not initialize for ${profile.name} ${documentTarget.documentType}: ${JSON.stringify(lastInitState)}`, 30_000);

    // Observe reported capabilities before reading, so a failed read still
    // records whether the profile's overrides reached the page.
    const hardware = await collectHardwareSnapshot(cdp, readerEngineSessionId);
    attempt.hardware = hardware;
    attempt.network = condition.network === 'offline'
      ? await verifyOfflineEmulation(cdp, readerEngineSessionId)
      : { mode: 'online' };
    enforcementBefore = await browser.queryEnforcement();
    gpuBefore = await browser.gpuSample();
    ocrBefore = await captureProbePdfOcr(cdp, documentTarget);
    if (profile.contention?.cpu) loadGenerator = await startLoadGenerator(profile.contention.cpu);
    await seedProbeDocumentTarget(cdp, serviceWorkerSessionId, documentTarget);
    const popup = await openProbePopup(cdp, extensionId);
    popupTargetId = popup.targetId;
    popupSessionForDiagnostics = popup.sessionId;
    attempt.readClick = await queueProbeReadAction(cdp, popup.sessionId);
    attempt.clickEpochMs = attempt.readClick.clickedAtEpochMs;
    expect(attempt.readClick.hitTestVerified).toBe(true);
    let lastPreReadState = null;
    await waitFor(async () => {
      assertNotCrashed(readerEngineSessionId, crashedSessions);
      const result = await evaluateExpression(cdp, readerEngineSessionId, `(() => ({
        latency: window.__pagenarratorTtsProbe?.result?.preTtsLatency || null,
        status: document.getElementById('status-label')?.textContent || '',
        title: document.getElementById('article-title')?.textContent || '',
      }))()`);
      lastPreReadState = result.result.value;
      return Number.isFinite(lastPreReadState?.latency?.extractionMs)
        && Number.isFinite(lastPreReadState?.latency?.chunkingMs);
    }, () => `Probe extraction and chunking did not finish for ${profile.name} ${documentTarget.documentType}: ${JSON.stringify(lastPreReadState)}`, 30_000);
    await cdp.send('Target.activateTarget', { targetId: readerEngineTargetId });

    await expectRuntimeControlsHidden(cdp, readerEngineSessionId);

    let lastBackendState = null;
    await waitFor(async () => {
      assertNotCrashed(readerEngineSessionId, crashedSessions);
      const result = await evaluateExpression(cdp, readerEngineSessionId, `(() => ({
        plan: window.__pagenarratorTtsProbe?.result?.selectedBackendPlan || null,
        state: document.getElementById('reading-state-label')?.textContent || '',
        status: document.getElementById('status-label')?.textContent || '',
        errorVisible: Boolean(document.getElementById('error-notice') && !document.getElementById('error-notice').hidden),
      }))()`);
      lastBackendState = result.result.value;
      return lastBackendState.plan || lastBackendState.errorVisible;
    }, () => `Probe read did not reach backend selection for ${profile.name} ${documentTarget.documentType}: ${JSON.stringify(lastBackendState)}`, 90_000);

    const readToEnd = READ_TO_END_TTS_PROBE_DOCUMENT_TYPES.includes(documentTarget.documentType);
    const destroyDevicesAfterFirstAudio = (profile.faults || []).some((fault) => fault.kind === 'webgpu-device-destroyed');
    let devicesDestroyed = false;
    let lastProbeState = null;
    probe = await waitFor(async () => {
      assertNotCrashed(readerEngineSessionId, crashedSessions);
      const result = await evaluateExpression(cdp, readerEngineSessionId, `(() => ({
        probe: window.__pagenarratorTtsProbe || null,
        audio: globalThis.__pnProbeAudio || null,
        errorVisible: Boolean(document.getElementById('error-notice') && !document.getElementById('error-notice').hidden),
        readIdle: Boolean(document.getElementById('stop-btn')?.hidden) && !document.getElementById('read-btn')?.disabled,
      }))()`);
      const value = result.result.value;
      const tts = value?.probe?.result;
      lastProbeState = tts ? {
        selectedBackendPlan: tts.selectedBackendPlan,
        firstSynthesisMs: tts.firstSynthesisMs,
        sectionCount: tts.flow?.sectionCount || 0,
        loadTransitionCount: tts.flow?.loadTransitionCount || 0,
        measuredTransitionCount: tts.flow?.measuredTransitionCount || 0,
        audioPlaybackObserved: Boolean(tts.flow?.audioPlaybackObserved),
        lastSection: tts.sections?.at?.(-1) || null,
        fallbackOccurred: tts.fallbackOccurred,
        uxProfileBadge: tts.uxProfileBadge,
        preTtsLatency: tts.preTtsLatency,
        errorVisible: value.errorVisible,
      } : { errorVisible: value?.errorVisible };
      const firstAudioStarted = tts?.sections?.some?.((section) => section.audioStartAtMs !== null);
      if (destroyDevicesAfterFirstAudio && !devicesDestroyed && firstAudioStarted) {
        devicesDestroyed = true;
        attempt.devicesDestroyedAtMs = Date.now() - startedAtMs;
        await evaluateExpression(cdp, readerEngineSessionId, 'globalThis.__pnProbeFaults?.destroyDevices?.() ?? 0');
      }
      if (profile.soak && !attempt.soak && firstAudioStarted) {
        attempt.soak = await runSoakObservation({
          cdp,
          browser,
          readerEngineSessionId,
          durationMs: getSoakDurationMs(profile),
          bounds: profile.soak,
          attempt,
        });
        const latest = await evaluateExpression(cdp, readerEngineSessionId, '(() => window.__pagenarratorTtsProbe || null)()');
        return latest.result.value;
      }
      if (profile.lifecycle && !attempt.lifecycle && firstAudioStarted) {
        attempt.lifecycle = await runLifecycleAction({
          cdp,
          action: profile.lifecycle.action,
          readerEngineSessionId,
          readerEngineTargetId,
          popupSessionId: popup.sessionId,
        });
        if (profile.lifecycle.action === 'stop') {
          const latest = await evaluateExpression(cdp, readerEngineSessionId, '(() => window.__pagenarratorTtsProbe || null)()');
          return latest.result.value;
        }
      }
      if (value?.errorVisible && value?.readIdle) return value.probe || { result: tts || null, terminalError: true };
      if (!isProbeResultReady(tts, {
        requiredSections,
        profile,
        condition,
        readIdle: value?.readIdle,
        audio: summarizeAudioTap(value?.audio, { clickEpochMs: attempt.clickEpochMs }),
      })) return null;
      return !readToEnd || value?.readIdle ? value.probe : null;
    }, () => `Probe did not record required synthesis/flow metrics or fallback for ${profile.name} ${documentTarget.documentType} run ${attempt.runIndex}: ${JSON.stringify(lastProbeState)}`, PROBE_TIMEOUT_MS);

    page = (await evaluateExpression(cdp, readerEngineSessionId, READER_ENGINE_OBSERVATION_EXPRESSION)).result?.value || null;
    output = {
      ...attempt,
      ...hardware,
      tts: {
        ...probe.result,
        uxProfileBadge: probe.result?.uxProfileBadge || '',
      },
    };
    // Lanes declare which outcomes (including explicit errors) are correct;
    // legacy profiles require generated audio.
    if (profile.expected) {
      assertionFailures.push(...evaluateLaneExpectations(profile, {
        ...attempt,
        tts: output.tts,
        page,
        execution: resolveExecutionBackend(output.tts),
        outcome: classifyProbeOutcome({ tts: output.tts, page }),
        workers: summarizeWorkerThreads(workersBySession.get(readerEngineSessionId)),
      }));
      assertionFailures.push(...evaluateLifecycleResult(profile.lifecycle, attempt.lifecycle, LIFECYCLE_BOUNDS));
      assertionFailures.push(...evaluateSoakResult(profile.soak, attempt.soak, profile.soak));
    } else if (!page?.errorNotice?.visible) {
      try {
        expectValidProbeOutput(output, { minSections: requiredSections });
        expectExpectedBackendReason(profile, probe);
      } catch (error) {
        assertionFailures.push(error.message);
      }
    }
    await cdp.send('Target.activateTarget', { targetId: popupTargetId });
    await waitForProbeReadCleanup(cdp, readerEngineSessionId, popup.sessionId);
    await completeFirstRead();
    if (attempt.status === RUN_STATUS.PASSED && readsPerTarget > 1) {
      let previousReadId = attempt.attemptId;
      for (let readIndex = 1; readIndex < readsPerTarget; readIndex += 1) {
        const repeated = await startRepeatedAttempt(readIndex);
        await runRepeatedRead({
          cdp,
          browser,
          profile,
          attempt: repeated,
          readerEngineSessionId,
          popupSessionId: popup.sessionId,
          requiredSections,
          crashedSessions,
          hostLoadBefore,
          previousPlan: output?.tts?.selectedBackendPlan || null,
          hardware: attempt.hardware,
          workers: workersBySession.get(readerEngineSessionId),
          serviceWorkerSessionId,
          documentTarget,
          previousReadId,
        });
        if (repeated.status !== RUN_STATUS.PASSED) break;
        previousReadId = repeated.attemptId;
      }
    }
  } catch (error) {
    if (!firstReadCompleted) {
      attempt.error = error.message;
      attempt.status = statusForError(error);
      timedOut = error?.name === 'ProbeTimeoutError' || error?.name === 'CdpTimeoutError';
      if (error?.name === 'ProbeCrashError') attempt.crash = error.crash;
      if (error?.name === 'CdpTimeoutError' && error.sessionId && error.sessionId === readerEngineSessionId) {
        attempt.crash = 'renderer-unresponsive';
      }
      if (readerEngineSessionId && crashedSessions.has(readerEngineSessionId)) {
        attempt.status = RUN_STATUS.CRASHED;
        attempt.crash = 'renderer';
      }
      if (attempt.status === RUN_STATUS.CRASHED && !attempt.crash) attempt.crash = 'browser';
      const pageResponsive = attempt.status !== RUN_STATUS.CRASHED && attempt.crash !== 'renderer-unresponsive';
      if (!page && readerEngineSessionId && pageResponsive) {
        page = (await evaluateExpression(cdp, readerEngineSessionId, READER_ENGINE_OBSERVATION_EXPRESSION).catch(() => null))?.result?.value || null;
      }
      if (!probe && readerEngineSessionId && pageResponsive) {
        probe = (await evaluateExpression(cdp, readerEngineSessionId, '(() => window.__pagenarratorTtsProbe || null)()').catch(() => null))?.result?.value || null;
      }
      attempt.diagnostics = {
        popupText: popupSessionForDiagnostics
          ? (await evaluateExpression(cdp, popupSessionForDiagnostics, "document.body?.innerText?.slice(0, 600) || ''").catch(() => null))?.result?.value ?? null
          : null,
        toolbarPlayerStatus: readerEngineSessionId && pageResponsive
          ? (await evaluateExpression(cdp, readerEngineSessionId, `(() => ({
            status: document.getElementById('status-label')?.textContent || '',
            title: document.getElementById('article-title')?.textContent || '',
            readingState: document.getElementById('reading-state-label')?.textContent || '',
          }))()`).catch(() => null))?.result?.value ?? null
          : null,
      };
    }
  } finally {
    await completeFirstRead();
    if (popupTargetId) await closeTargetBestEffort(cdp, popupTargetId);
    if (readerEngineTargetId) await closeTargetBestEffort(cdp, readerEngineTargetId);
    if (readerEngineSessionId) {
      workersBySession.delete(readerEngineSessionId);
      BUSY_PAGE_WAITS.delete(readerEngineSessionId);
    }
  }
  return { output: attempt.status === RUN_STATUS.PASSED ? attempt : null };

  async function completeFirstRead() {
    if (firstReadCompleted) return;
    firstReadCompleted = true;
    if (loadGenerator) {
      attempt.contention = await loadGenerator.stop().catch((error) => ({ error: error.message }));
      loadGenerator = null;
    }
    assertionFailures.push(...await runFaults.release(attempt).catch((error) => [`run fault release failed: ${error.message}`]));
    attempt.console = {
      toolbarPlayer: consoleBySession.get(readerEngineSessionId) || [],
      popup: consoleBySession.get(popupSessionForDiagnostics) || [],
      serviceWorker: (consoleBySession.get(serviceWorkerSessionIdForConsole) || []).slice(-20),
      // The document tab is reused across attempts; its last entries are kept.
      document: (consoleBySession.get(documentTarget.sessionId) || []).slice(-20),
    };
    attempt.documentCrashed = Boolean(documentTarget.sessionId && crashedSessions.has(documentTarget.sessionId));
    const enforcementAfter = await browser.queryEnforcement();
    const gpuAfter = await browser.gpuSample();
    attempt.ocr = summarizeProbePdfOcr({ documentType: documentTarget.documentType, profile, before: ocrBefore, after: await captureProbePdfOcr(cdp, documentTarget) });
    const pageUsable = readerEngineSessionId && attempt.status !== RUN_STATUS.CRASHED && attempt.crash !== 'renderer-unresponsive';
    const heap = pageUsable
      ? await cdp.send('Runtime.getHeapUsage', {}, readerEngineSessionId, { timeoutMs: PAGE_EVALUATE_TIMEOUT_MS }).catch(() => null)
      : null;
    const ticksAfter = readCpuTicks();
    attempt.readIndex = 0;
    attempt.modelResidency = 'loaded-for-read';
    if (pageUsable) {
      attempt.content = await captureWorkloadContent(cdp, readerEngineSessionId, documentTarget.documentType);
      assertionFailures.push(...contentAssertionFailures(attempt, documentTarget.documentType, { tts: output?.tts || probe?.result, page }));
    }
    finalizeAttempt({
      attempt,
      profile,
      probe,
      page,
      output,
      assertionFailures,
      timedOut,
      enforcementBefore,
      enforcementAfter,
      gpuBefore,
      gpuAfter,
      heap,
      ticksBefore,
      ticksAfter,
      startedAtMs,
      hostLoadBefore,
      browser,
      workers: workersBySession.get(readerEngineSessionId),
      pageBlocking: summarizePageBlocking(busyPageWait?.record),
    });
  }
}
